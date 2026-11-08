import {
  ConnectorError,
  DAEMON_METHODS,
  EXTENSION_CAPABILITIES,
  EXTENSION_METHODS,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  WS_PATH,
  browserProofMessage,
  daemonProofMessage,
  fromWireError,
  isExtensionMethod,
  parseServerFrame,
  toWireError,
  type ActivityEntry,
  type ActivityTotals,
  type BrowserState,
  type ClientFrame,
  type DaemonMethod,
  type DaemonParams,
  type DaemonResult,
  type ServerFrame,
} from '@corsen-ai/shared'
import { equalHex, hmacHex, randomHex } from './crypto'
import { getFlags, getSettings, setFlags } from './storage'

export type LinkStatus = 'unpaired' | 'connecting' | 'connected' | 'offline' | 'denied' | 'superseded' | 'version'

export interface LinkSnapshot {
  readonly status: LinkStatus
  readonly detail: string
  readonly port: number
  readonly daemonVersion: string | null
}

export type InboundHandler = (method: string, params: unknown, io: { signal: AbortSignal; emit: (event: unknown) => void }) => Promise<unknown>

interface Outbound {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const CLOSE_SUPERSEDED = 4001
const CLOSE_VERSION = 4002
const CLOSE_UNAUTHENTICATED = 4003

/**
 * The extension side of the daemon link: mutual HMAC handshake (the pairing secret never crosses the
 * wire), 20 s keepalive pings (Chrome keeps the service worker alive on WebSocket traffic), RPC both
 * ways, exponential reconnect backoff plus a chrome.alarms safety net while the daemon is down.
 */
export class DaemonLink {
  #socket: WebSocket | null = null
  #status: LinkStatus = 'offline'
  #detail = ''
  #port = 0
  #daemonVersion: string | null = null
  #attempt = 0
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #retry: ReturnType<typeof setTimeout> | null = null
  #outSeq = 0
  readonly #outbound = new Map<string, Outbound>()
  readonly #inbound = new Map<string, AbortController>()
  readonly #handler: InboundHandler
  readonly #listeners = new Set<(snapshot: LinkSnapshot) => void>()
  readonly #activityListeners = new Set<(entries: ActivityEntry[], totals: ActivityTotals) => void>()
  readonly #stateProvider: () => Promise<BrowserState>

  constructor(handler: InboundHandler, stateProvider: () => Promise<BrowserState>) {
    this.#handler = handler
    this.#stateProvider = stateProvider
  }

  snapshot(): LinkSnapshot {
    return { status: this.#status, detail: this.#detail, port: this.#port, daemonVersion: this.#daemonVersion }
  }

  get connected(): boolean {
    return this.#status === 'connected'
  }

  onChange(listener: (snapshot: LinkSnapshot) => void): void {
    this.#listeners.add(listener)
  }

  onActivity(listener: (entries: ActivityEntry[], totals: ActivityTotals) => void): void {
    this.#activityListeners.add(listener)
  }

  #set(status: LinkStatus, detail = ''): void {
    this.#status = status
    this.#detail = detail
    for (const listener of this.#listeners) listener(this.snapshot())
  }

  /** Connect when paired and not already connected (idempotent; safe to call from any event). */
  async ensureConnected(options: { takeover?: boolean } = {}): Promise<void> {
    if (this.#socket !== null && (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)) return
    const settings = await getSettings()
    this.#port = settings.port
    if (settings.pairingSecret === '') {
      this.#set('unpaired', 'Open the Corsen dashboard and pair this browser.')
      return
    }
    const flags = await getFlags()
    if (flags.superseded && options.takeover !== true) {
      this.#set('superseded', 'Another browser is connected to the connector. Click "Use this browser" to take over.')
      return
    }
    if (options.takeover === true) await setFlags({ superseded: false })
    if (this.#status === 'denied' && options.takeover !== true) return
    this.#open(settings.port, settings.pairingSecret, settings.browserId, options.takeover === true)
  }

  #open(port: number, secret: string, browserId: string, takeover: boolean): void {
    this.#clearRetry()
    this.#set('connecting', `ws://127.0.0.1:${port}${WS_PATH}`)
    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`)
    } catch (error) {
      this.#set('offline', (error as Error).message)
      this.#scheduleRetry()
      return
    }
    this.#socket = socket
    const clientNonce = randomHex(16)
    socket.addEventListener('message', (event) => {
      void this.#onMessage(socket, String(event.data), { secret, browserId, clientNonce, takeover })
    })
    socket.addEventListener('close', (event) => this.#onClose(socket, event.code))
    socket.addEventListener('error', () => undefined)
  }

  async #onMessage(socket: WebSocket, raw: string, auth: { secret: string; browserId: string; clientNonce: string; takeover: boolean }): Promise<void> {
    const parsed = parseServerFrame(raw)
    if (!parsed.ok) {
      socket.close(1008, parsed.code)
      return
    }
    const frame: ServerFrame = parsed.frame
    switch (frame.type) {
      case 'challenge': {
        if (frame.protocolVersion !== PROTOCOL_VERSION) {
          this.#set('version', `The daemon speaks protocol ${frame.protocolVersion}, this extension ${PROTOCOL_VERSION}: update the older one.`)
          socket.close(1000)
          return
        }
        const proof = await hmacHex(auth.secret, browserProofMessage(auth.browserId, frame.nonce))
        this.#send({
          type: 'hello',
          role: 'browser',
          browserId: auth.browserId,
          browserName: await browserName(),
          nonce: auth.clientNonce,
          proof,
          protocolVersion: PROTOCOL_VERSION,
          extensionVersion: chrome.runtime.getManifest().version,
          capabilities: [...EXTENSION_CAPABILITIES],
          takeover: auth.takeover,
        })
        return
      }
      case 'paired': {
        const expected = await hmacHex(auth.secret, daemonProofMessage(auth.browserId, auth.clientNonce))
        if (!equalHex(expected, frame.proof)) {
          // Something answered on the port without knowing our secret: never trust it.
          this.#set('denied', 'The process on this port could not prove the pairing code. Pair again from the dashboard.')
          socket.close(1008)
          return
        }
        this.#attempt = 0
        this.#daemonVersion = frame.daemonVersion
        this.#set('connected', `daemon ${frame.daemonVersion}`)
        this.#startHeartbeat()
        void this.pushState()
        return
      }
      case 'denied':
        this.#set(frame.code === 'PROTOCOL_VERSION' ? 'version' : frame.code === 'SUPERSEDED' ? 'superseded' : 'denied', frame.message)
        return
      case 'rpc':
        void this.#onRpc(frame.id, frame.method, frame.params)
        return
      case 'rpc_cancel':
        this.#inbound.get(frame.id)?.abort()
        return
      case 'rpc_result': {
        const pending = this.#outbound.get(frame.id)
        if (pending === undefined) return
        this.#outbound.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.ok) pending.resolve(frame.result)
        else pending.reject(frame.error !== undefined ? fromWireError(frame.error) : new ConnectorError('INTERNAL', 'empty error'))
        return
      }
      case 'activity':
        for (const listener of this.#activityListeners) listener(frame.entries, frame.totals)
        return
      case 'rpc_event':
      case 'pong':
        return
    }
  }

  async #onRpc(id: string, method: string, params: unknown): Promise<void> {
    if (!isExtensionMethod(method)) {
      this.#send({ type: 'rpc_result', id, ok: false, error: { code: 'UNSUPPORTED', message: `unknown method ${method}` } })
      return
    }
    const checked = EXTENSION_METHODS[method].params.safeParse(params)
    if (!checked.success) {
      this.#send({ type: 'rpc_result', id, ok: false, error: { code: 'INVALID_ARGUMENT', message: checked.error.issues[0]?.message ?? 'invalid params' } })
      return
    }
    const controller = new AbortController()
    this.#inbound.set(id, controller)
    try {
      const result = await this.#handler(method, checked.data, { signal: controller.signal, emit: (event) => this.#send({ type: 'rpc_event', id, event }) })
      this.#send({ type: 'rpc_result', id, ok: true, result })
    } catch (error) {
      this.#send({ type: 'rpc_result', id, ok: false, error: toWireError(error) })
    } finally {
      this.#inbound.delete(id)
    }
  }

  /** Extension → daemon request (side panel / popup actions). */
  call<M extends DaemonMethod>(method: M, params: DaemonParams<M>, timeoutMs = 60_000): Promise<DaemonResult<M>> {
    if (!this.connected) return Promise.reject(new ConnectorError('NO_BROWSER', 'The connector daemon is not connected.'))
    this.#outSeq += 1
    const id = `x${this.#outSeq.toString(36)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#outbound.delete(id)
        reject(new ConnectorError('TIMEOUT', `${method} timed out`))
      }, timeoutMs)
      this.#outbound.set(id, {
        resolve: (value) => {
          const parsed = DAEMON_METHODS[method].result.safeParse(value)
          if (parsed.success) resolve(parsed.data as DaemonResult<M>)
          else reject(new ConnectorError('MALFORMED', `invalid ${method} result`))
        },
        reject,
        timer,
      })
      this.#send({ type: 'rpc', id, method, params })
    })
  }

  async pushState(): Promise<void> {
    if (!this.connected) return
    this.#send({ type: 'state', state: await this.#stateProvider() })
  }

  /** Close for good (forget pairing / panic) without scheduling a reconnect. */
  disconnect(status: LinkStatus = 'offline', detail = ''): void {
    this.#clearRetry()
    const socket = this.#socket
    this.#socket = null
    this.#stopHeartbeat()
    socket?.close(1000)
    this.#set(status, detail)
  }

  #send(frame: ClientFrame): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(frame))
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat()
    this.#heartbeat = setInterval(() => this.#send({ type: 'ping', ts: Date.now() }), HEARTBEAT_INTERVAL_MS)
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat)
    this.#heartbeat = null
  }

  #onClose(socket: WebSocket, code: number): void {
    if (this.#socket !== socket) return
    this.#socket = null
    this.#stopHeartbeat()
    for (const controller of this.#inbound.values()) controller.abort()
    this.#inbound.clear()
    for (const [id, pending] of this.#outbound) {
      clearTimeout(pending.timer)
      pending.reject(new ConnectorError('INTERRUPTED', 'the daemon connection closed'))
      this.#outbound.delete(id)
    }
    if (code === CLOSE_SUPERSEDED) {
      void setFlags({ superseded: true })
      this.#set('superseded', 'Another browser is now connected to the connector. Click "Use this browser" to take over.')
      return
    }
    if (code === CLOSE_VERSION) {
      if (this.#status !== 'version') this.#set('version', 'Protocol versions differ: update the extension or the daemon.')
      return
    }
    if (code === CLOSE_UNAUTHENTICATED) {
      if (this.#status !== 'denied') this.#set('denied', 'The pairing code was refused. Pair again from the dashboard.')
      return
    }
    if (this.#status === 'denied' || this.#status === 'version') return
    this.#set('offline', 'The connector daemon is not reachable. Start it with: npx @corsen-ai/universal-connector')
    this.#scheduleRetry()
  }

  #scheduleRetry(): void {
    this.#clearRetry()
    const delay = Math.min(30_000, 1_000 * 2 ** this.#attempt) + Math.floor(Math.random() * 400)
    this.#attempt = Math.min(this.#attempt + 1, 10)
    this.#retry = setTimeout(() => void this.ensureConnected(), delay)
  }

  #clearRetry(): void {
    if (this.#retry !== null) clearTimeout(this.#retry)
    this.#retry = null
  }
}

async function browserName(): Promise<string> {
  const info = await chrome.runtime.getPlatformInfo()
  const brand = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData?.brands?.find((item) => !/Not.?A.?Brand|Chromium/i.test(item.brand))?.brand ?? 'Chrome'
  return `${brand} (${info.os})`.slice(0, 120)
}
