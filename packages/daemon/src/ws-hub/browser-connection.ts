import type { WebSocket } from 'ws'
import type * as z from 'zod'
import {
  ConnectorError,
  DAEMON_METHODS,
  EXTENSION_METHODS,
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  VERSION,
  fromWireError,
  isDaemonMethod,
  parseClientFrame,
  toWireError,
  type BrowserState,
  type ClientFrame,
  type ErrorCode,
  type ExtensionMethod,
  type ExtensionParams,
  type ExtensionResult,
  type HelloFrame,
  type ServerFrame,
} from '@corsen-ai/shared'
import { createNonce, daemonProof, expectedBrowserProof, secretsMatch } from '../auth/hmac'
import type { Logger } from '../util/logger'
import { PendingCalls } from './pending-calls'

/** WebSocket close codes used by the daemon (4000-4999 is the application range). */
export const CLOSE = {
  SUPERSEDED: 4001,
  PROTOCOL_VERSION: 4002,
  UNAUTHENTICATED: 4003,
  HANDSHAKE_TIMEOUT: 4004,
  HEARTBEAT_TIMEOUT: 4005,
  POLICY: 1008,
  SHUTDOWN: 1001,
} as const

export interface ConnectionHost {
  readonly secret: () => string
  readonly logger: Logger
  readonly handleDaemonRpc: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>
  readonly onPaired: (connection: BrowserConnection) => void
  readonly onState: (connection: BrowserConnection, state: BrowserState) => void
  readonly onClosed: (connection: BrowserConnection) => void
  readonly onSecurityEvent: (title: string, detail: string) => void
}

export interface CallOptions<M extends ExtensionMethod> {
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly onEvent?: ((event: NonNullable<ExtensionEvent<M>>) => void) | undefined
}

export type ExtensionEvent<M extends ExtensionMethod> = (typeof EXTENSION_METHODS)[M] extends { event: infer E extends z.ZodType }
  ? z.infer<E>
  : never

let connectionSequence = 0

/** One extension connection: handshake state machine, heartbeat watchdog and RPC both ways. */
export class BrowserConnection {
  readonly id: string
  readonly origin: string
  readonly connectedAt = Date.now()
  #phase: 'handshaking' | 'paired' | 'closed' = 'handshaking'
  #hello: HelloFrame | null = null
  #state: BrowserState | null = null
  #lastSeen = Date.now()
  readonly #serverNonce = createNonce()
  readonly #socket: WebSocket
  readonly #host: ConnectionHost
  readonly #pending = new PendingCalls('d')
  readonly #inbound = new Map<string, AbortController>()
  readonly #handshakeTimer: NodeJS.Timeout
  readonly #watchdog: NodeJS.Timeout

  constructor(socket: WebSocket, origin: string, host: ConnectionHost) {
    connectionSequence += 1
    this.id = `c${connectionSequence.toString(36)}${Date.now().toString(36)}`
    this.origin = origin
    this.#socket = socket
    this.#host = host
    socket.on('message', (data, isBinary) => this.#onMessage(data, isBinary))
    socket.on('close', () => this.#onClose())
    socket.on('error', (error) => host.logger.warn('browser socket error', { connection: this.id, error: error.message }))
    this.#handshakeTimer = setTimeout(() => {
      if (this.#phase === 'handshaking') this.close(CLOSE.HANDSHAKE_TIMEOUT, 'handshake timeout')
    }, HANDSHAKE_TIMEOUT_MS)
    this.#handshakeTimer.unref?.()
    this.#watchdog = setInterval(() => {
      if (this.#phase === 'paired' && Date.now() - this.#lastSeen > HEARTBEAT_TIMEOUT_MS) {
        host.logger.warn('browser heartbeat timeout', { connection: this.id })
        this.close(CLOSE.HEARTBEAT_TIMEOUT, 'heartbeat timeout')
      }
    }, 5_000)
    this.#watchdog.unref?.()
    this.#send({ type: 'challenge', nonce: this.#serverNonce, protocolVersion: PROTOCOL_VERSION, daemonVersion: VERSION })
  }

  get paired(): boolean {
    return this.#phase === 'paired'
  }

  get hello(): HelloFrame | null {
    return this.#hello
  }

  get state(): BrowserState | null {
    return this.#state
  }

  supports(method: ExtensionMethod): boolean {
    return this.#hello?.capabilities.includes(method) ?? false
  }

  /** Call an extension method; params and result are validated against the shared contract. */
  async call<M extends ExtensionMethod>(method: M, params: ExtensionParams<M>, options: CallOptions<M>): Promise<ExtensionResult<M>> {
    if (this.#phase !== 'paired') throw new ConnectorError('NO_BROWSER', 'the browser is not connected')
    if (!this.supports(method)) throw new ConnectorError('UNSUPPORTED', `the extension does not implement ${method}; update it`)
    const contract = EXTENSION_METHODS[method]
    const checked = contract.params.safeParse(params)
    if (!checked.success) throw new ConnectorError('INVALID_ARGUMENT', `invalid ${method} parameters: ${checked.error.issues[0]?.message ?? ''}`)
    const id = this.#pending.nextId()
    const eventSchema = 'event' in contract ? contract.event : undefined
    const result = this.#pending.register(id, method, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onAbort: () => this.#send({ type: 'rpc_cancel', id }),
      onEvent:
        options.onEvent === undefined
          ? undefined
          : (event) => {
              const parsed = eventSchema?.safeParse(event)
              if (parsed?.success === true) options.onEvent?.(parsed.data as unknown as NonNullable<ExtensionEvent<M>>)
            },
    })
    this.#send({ type: 'rpc', id, method, params: checked.data })
    const raw = await result
    const parsed = contract.result.safeParse(raw)
    if (!parsed.success) {
      throw new ConnectorError('MALFORMED', `the extension returned an invalid ${method} result: ${parsed.error.issues[0]?.message ?? ''}`)
    }
    return parsed.data as ExtensionResult<M>
  }

  sendFrame(frame: ServerFrame): void {
    this.#send(frame)
  }

  close(code: number, reason: string): void {
    if (this.#phase === 'closed') return
    try {
      this.#socket.close(code, reason)
    } catch {
      this.#socket.terminate()
    }
    // Some peers never answer the close handshake; make sure the socket goes away.
    setTimeout(() => this.#socket.terminate(), 2_000).unref?.()
  }

  #send(frame: ServerFrame): void {
    if (this.#socket.readyState !== this.#socket.OPEN) return
    this.#socket.send(JSON.stringify(frame))
  }

  #deny(code: ErrorCode, message: string, closeCode: number): void {
    this.#send({ type: 'denied', code, message })
    this.close(closeCode, code)
  }

  #onMessage(data: unknown, isBinary: boolean): void {
    this.#lastSeen = Date.now()
    if (isBinary) {
      this.close(CLOSE.POLICY, 'binary frames are not accepted')
      return
    }
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : String(data)
    const parsed = parseClientFrame(text)
    if (!parsed.ok) {
      this.#host.logger.warn('refused browser frame', { connection: this.id, code: parsed.code, message: parsed.message })
      if (this.#phase === 'handshaking') this.#deny(parsed.code, parsed.message, CLOSE.POLICY)
      else this.close(CLOSE.POLICY, parsed.code)
      return
    }
    if (this.#phase === 'handshaking') {
      this.#onHandshakeFrame(parsed.frame)
      return
    }
    if (this.#phase === 'paired') this.#onPairedFrame(parsed.frame)
  }

  #onHandshakeFrame(frame: ClientFrame): void {
    if (frame.type !== 'hello') {
      this.#deny('UNAUTHENTICATED', 'the first frame must be hello', CLOSE.UNAUTHENTICATED)
      return
    }
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      const older = frame.protocolVersion < PROTOCOL_VERSION ? 'the extension is older than the daemon' : 'the daemon is older than the extension'
      this.#deny('PROTOCOL_VERSION', `protocol ${frame.protocolVersion} != ${PROTOCOL_VERSION}: ${older}; update it`, CLOSE.PROTOCOL_VERSION)
      return
    }
    const secret = this.#host.secret()
    const expected = expectedBrowserProof(secret, frame.browserId, this.#serverNonce)
    if (!secretsMatch(expected, frame.proof)) {
      this.#host.onSecurityEvent('Rejected browser: wrong pairing code', `origin ${this.origin}`)
      this.#deny('UNAUTHENTICATED', 'pairing proof did not verify; pair the extension again with the current code', CLOSE.UNAUTHENTICATED)
      return
    }
    clearTimeout(this.#handshakeTimer)
    this.#hello = frame
    this.#phase = 'paired'
    this.#send({
      type: 'paired',
      proof: daemonProof(secret, frame.browserId, frame.nonce),
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: VERSION,
      connectionId: this.id,
    })
    this.#host.onPaired(this)
  }

  #onPairedFrame(frame: ClientFrame): void {
    switch (frame.type) {
      case 'ping':
        this.#send({ type: 'pong', ts: frame.ts })
        return
      case 'state':
        this.#state = frame.state
        this.#host.onState(this, frame.state)
        return
      case 'rpc_result':
        if (frame.ok) this.#pending.resolve(frame.id, frame.result)
        else if (frame.error !== undefined) this.#pending.reject(frame.id, fromWireError(frame.error))
        return
      case 'rpc_event':
        this.#pending.event(frame.id, frame.event)
        return
      case 'rpc':
        void this.#onInboundRpc(frame.id, frame.method, frame.params)
        return
      case 'rpc_cancel':
        this.#inbound.get(frame.id)?.abort()
        return
      case 'hello':
        this.close(CLOSE.POLICY, 'unexpected hello')
        return
    }
  }

  async #onInboundRpc(id: string, method: string, params: unknown): Promise<void> {
    if (!isDaemonMethod(method)) {
      this.#send({ type: 'rpc_result', id, ok: false, error: { code: 'UNSUPPORTED', message: `unknown method ${method}` } })
      return
    }
    const checked = DAEMON_METHODS[method].params.safeParse(params)
    if (!checked.success) {
      this.#send({ type: 'rpc_result', id, ok: false, error: { code: 'INVALID_ARGUMENT', message: checked.error.issues[0]?.message ?? 'invalid params' } })
      return
    }
    const controller = new AbortController()
    this.#inbound.set(id, controller)
    try {
      const result = await this.#host.handleDaemonRpc(method, checked.data, controller.signal)
      this.#send({ type: 'rpc_result', id, ok: true, result })
    } catch (error) {
      this.#send({ type: 'rpc_result', id, ok: false, error: toWireError(error) })
    } finally {
      this.#inbound.delete(id)
    }
  }

  #onClose(): void {
    if (this.#phase === 'closed') return
    this.#phase = 'closed'
    clearTimeout(this.#handshakeTimer)
    clearInterval(this.#watchdog)
    for (const controller of this.#inbound.values()) controller.abort()
    this.#inbound.clear()
    this.#pending.rejectAll((method) => new ConnectorError('INTERRUPTED', `the browser disconnected during ${method}; the outcome is unknown`))
    this.#host.onClosed(this)
  }
}
