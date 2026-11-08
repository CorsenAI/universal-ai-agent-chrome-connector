import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import {
  ConnectorError,
  LIMITS,
  type ActivityEntry,
  type ActivityTotals,
  type BrowserState,
  type ExtensionMethod,
  type ExtensionParams,
  type ExtensionResult,
} from '@corsen-ai/shared'
import type { ActivityLog } from '../activity/activity-log'
import type { Logger } from '../util/logger'
import { BrowserConnection, CLOSE, type CallOptions } from './browser-connection'

export interface HubOptions {
  readonly secret: () => string
  readonly logger: Logger
  readonly activity: ActivityLog
  readonly handleDaemonRpc: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>
}

export interface BrowserSummary {
  readonly connected: boolean
  readonly browserName: string | null
  readonly extensionVersion: string | null
  readonly connectedAt: number | null
}

type HubListener = (event: 'connected' | 'disconnected' | 'state') => void

/**
 * Owns every extension connection. One paired connection is active at a time (D-009): the newest
 * authenticated browser wins and the previous one is closed with code 4001 (SUPERSEDED) so it stops
 * auto-reconnecting until its user asks.
 */
export class BrowserHub {
  readonly #wss: WebSocketServer
  readonly #options: HubOptions
  readonly #connections = new Set<BrowserConnection>()
  readonly #listeners = new Set<HubListener>()
  #active: BrowserConnection | null = null

  constructor(options: HubOptions) {
    this.#options = options
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.MAX_FRAME_BYTES, perMessageDeflate: false })
  }

  /**
   * Accept a WebSocket upgrade the HTTP layer already checked (path and Host). The Origin must be a
   * Chrome extension: a precondition that excludes every web page, never an identity (the HMAC
   * proof is the identity).
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = request.headers.origin ?? ''
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      this.#options.activity.note('security', 'Refused WebSocket from a non-extension origin', 'error', origin === '' ? 'no Origin header' : origin.slice(0, 200))
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      const connection = new BrowserConnection(ws, origin, {
        secret: this.#options.secret,
        logger: this.#options.logger,
        handleDaemonRpc: this.#options.handleDaemonRpc,
        onPaired: (paired) => this.#promote(paired),
        onState: (from) => {
          if (from === this.#active) this.#emit('state')
        },
        onClosed: (closed) => this.#onClosed(closed),
        onSecurityEvent: (title, detail) => this.#options.activity.note('security', title, 'error', detail),
      })
      this.#connections.add(connection)
    })
  }

  get connected(): boolean {
    return this.#active?.paired === true
  }

  summary(): BrowserSummary {
    const active = this.#active
    return {
      connected: active?.paired === true,
      browserName: active?.hello?.browserName ?? null,
      extensionVersion: active?.hello?.extensionVersion ?? null,
      connectedAt: active?.connectedAt ?? null,
    }
  }

  state(): BrowserState | null {
    return this.#active?.state ?? null
  }

  async call<M extends ExtensionMethod>(method: M, params: ExtensionParams<M>, options: CallOptions<M>): Promise<ExtensionResult<M>> {
    const active = this.#active
    if (active === null || !active.paired) {
      throw new ConnectorError('NO_BROWSER', 'No browser is connected. Open Chrome with the Corsen extension installed and paired.')
    }
    return active.call(method, params, options)
  }

  pushActivity(entry: ActivityEntry, totals: ActivityTotals): void {
    if (this.#active?.paired === true) this.#active.sendFrame({ type: 'activity', entries: [entry], totals })
  }

  on(listener: HubListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  close(): void {
    for (const connection of this.#connections) connection.close(CLOSE.SHUTDOWN, 'daemon shutting down')
    this.#wss.close()
  }

  #promote(connection: BrowserConnection): void {
    const previous = this.#active
    this.#active = connection
    if (previous !== null && previous !== connection) {
      this.#options.logger.info('browser superseded by a newer connection', { previous: previous.id, next: connection.id })
      previous.close(CLOSE.SUPERSEDED, 'SUPERSEDED')
    }
    this.#options.logger.info('browser paired', {
      connection: connection.id,
      browser: connection.hello?.browserName,
      extension: connection.hello?.extensionVersion,
    })
    this.#options.activity.note('system', 'Browser connected', 'ok', connection.hello?.browserName ?? undefined)
    this.#emit('connected')
  }

  #onClosed(connection: BrowserConnection): void {
    this.#connections.delete(connection)
    if (this.#active === connection) {
      this.#active = null
      this.#options.logger.info('browser disconnected', { connection: connection.id })
      this.#options.activity.note('system', 'Browser disconnected', 'ok')
      this.#emit('disconnected')
    }
  }

  #emit(event: 'connected' | 'disconnected' | 'state'): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // ignore listener failures
      }
    }
  }
}
