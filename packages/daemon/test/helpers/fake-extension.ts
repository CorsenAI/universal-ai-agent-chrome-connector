import { createHmac, randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  EXTENSION_CAPABILITIES,
  PROTOCOL_VERSION,
  browserProofMessage,
  daemonProofMessage,
  parseServerFrame,
  type BrowserState,
  type ClientFrame,
  type ServerFrame,
} from '@corsen-ai/shared'

export const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`

export type RpcHandler = (method: string, params: any, io: { event: (event: unknown) => void; cancelled: () => boolean; id: string }) => Promise<unknown> | unknown

export interface FakeExtensionOptions {
  readonly port: number
  readonly secret: string
  readonly browserId?: string
  readonly origin?: string
  readonly protocolVersion?: number
  readonly handler?: RpcHandler
}

/** A scripted stand-in for the Chrome extension, speaking the real wire protocol over a real socket. */
export class FakeExtension {
  readonly socket: WebSocket
  readonly frames: ServerFrame[] = []
  readonly cancelled = new Set<string>()
  closeCode: number | null = null
  #handler: RpcHandler
  #clientNonce = randomBytes(16).toString('hex')
  #pending = new Map<string, (frame: ServerFrame) => void>()
  readonly ready: Promise<'paired' | 'denied'>

  constructor(readonly options: FakeExtensionOptions) {
    this.#handler = options.handler ?? (() => ({}))
    this.socket = new WebSocket(`ws://127.0.0.1:${options.port}/ws`, { origin: options.origin ?? EXTENSION_ORIGIN })
    this.ready = new Promise((resolve, reject) => {
      this.socket.on('error', reject)
      this.socket.on('close', (code) => {
        this.closeCode = code
        resolve('denied')
      })
      this.socket.on('message', (data) => {
        const parsed = parseServerFrame(String(data))
        if (!parsed.ok) throw new Error(`daemon sent an invalid frame: ${parsed.message}`)
        const frame = parsed.frame
        this.frames.push(frame)
        if (frame.type === 'challenge') this.#hello(frame.nonce)
        else if (frame.type === 'paired') {
          const browserId = this.options.browserId ?? 'fake-browser'
          const expected = createHmac('sha256', options.secret).update(daemonProofMessage(browserId, this.#clientNonce)).digest('hex')
          if (frame.proof !== expected) reject(new Error('daemon proof did not verify'))
          else resolve('paired')
        } else if (frame.type === 'denied') resolve('denied')
        else if (frame.type === 'rpc') void this.#onRpc(frame.id, frame.method, frame.params)
        else if (frame.type === 'rpc_cancel') this.cancelled.add(frame.id)
        else if (frame.type === 'rpc_result') this.#pending.get(frame.id)?.(frame)
      })
    })
  }

  setHandler(handler: RpcHandler): void {
    this.#handler = handler
  }

  send(frame: ClientFrame): void {
    this.socket.send(JSON.stringify(frame))
  }

  pushState(state: Partial<BrowserState> & { tabs: BrowserState['tabs'] }): void {
    this.send({ type: 'state', state: { extensionVersion: '0.1.0', browserName: 'Fake Chrome', hiddenTabCount: 0, updatedAt: Date.now(), ...state } })
  }

  /** Extension → daemon RPC (what the side panel does). */
  call(method: string, params: unknown): Promise<ServerFrame> {
    const id = `x${randomBytes(4).toString('hex')}`
    const result = new Promise<ServerFrame>((resolve) => this.#pending.set(id, resolve))
    this.send({ type: 'rpc', id, method, params })
    return result
  }

  close(): void {
    this.socket.close()
  }

  #hello(serverNonce: string): void {
    const browserId = this.options.browserId ?? 'fake-browser'
    const proof = createHmac('sha256', this.options.secret).update(browserProofMessage(browserId, serverNonce)).digest('hex')
    this.send({
      type: 'hello',
      role: 'browser',
      browserId,
      browserName: 'Fake Chrome',
      nonce: this.#clientNonce,
      proof,
      protocolVersion: this.options.protocolVersion ?? PROTOCOL_VERSION,
      extensionVersion: '0.1.0',
      capabilities: [...EXTENSION_CAPABILITIES],
      takeover: false,
    })
  }

  async #onRpc(id: string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.#handler(method, params, {
        id,
        event: (event) => this.send({ type: 'rpc_event', id, event }),
        cancelled: () => this.cancelled.has(id),
      })
      this.send({ type: 'rpc_result', id, ok: true, result })
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'ACTION_FAILED'
      this.send({ type: 'rpc_result', id, ok: false, error: { code: code as never, message: (error as Error).message } })
    }
  }
}

export function tab(overrides: Partial<BrowserState['tabs'][number]> & { tabId: number; role: 'brain' | 'mcp' | 'ignored' }): BrowserState['tabs'][number] {
  return {
    windowId: 1,
    title: `Tab ${overrides.tabId}`,
    url: `https://example.com/${overrides.tabId}`,
    harnessId: null,
    attached: true,
    busy: false,
    consoleErrors: 0,
    networkErrors: 0,
    active: false,
    ...overrides,
  }
}
