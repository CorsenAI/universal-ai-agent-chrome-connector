import { ConnectorError, LIMITS } from '@corsen-ai/shared'

interface PendingCall {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: ConnectorError) => void
  readonly onEvent: ((event: unknown) => void) | undefined
  readonly timer: NodeJS.Timeout
  readonly detach: () => void
}

export interface PendingOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly onEvent?: ((event: unknown) => void) | undefined
  /** Called when the caller aborts, so the transport can tell the peer (rpc_cancel). */
  readonly onAbort?: (() => void) | undefined
}

/**
 * Tracks RPCs sent to the peer until their result arrives, they time out, the caller aborts, or the
 * connection drops (then every pending call fails with INTERRUPTED: the peer may have acted).
 */
export class PendingCalls {
  readonly #pending = new Map<string, PendingCall>()
  readonly #prefix: string
  #sequence = 0

  constructor(prefix: string) {
    this.#prefix = prefix
  }

  get size(): number {
    return this.#pending.size
  }

  nextId(): string {
    this.#sequence += 1
    return `${this.#prefix}${this.#sequence.toString(36)}`
  }

  register(id: string, method: string, options: PendingOptions): Promise<unknown> {
    if (this.#pending.size >= LIMITS.MAX_PENDING_RPC) {
      return Promise.reject(new ConnectorError('TOO_LARGE', `too many requests in flight (${LIMITS.MAX_PENDING_RPC})`))
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new ConnectorError('CANCELLED', `${method} was cancelled before it started`))
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.#pending.has(id)) return
        this.#settle(id)
        options.onAbort?.()
        reject(new ConnectorError('CANCELLED', `${method} was cancelled`))
      }
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return
        this.#settle(id)
        options.onAbort?.()
        reject(new ConnectorError('TIMEOUT', `${method} did not answer within ${options.timeoutMs} ms`))
      }, options.timeoutMs)
      timer.unref?.()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, {
        method,
        resolve,
        reject,
        onEvent: options.onEvent,
        timer,
        detach: () => options.signal?.removeEventListener('abort', onAbort),
      })
    })
  }

  resolve(id: string, value: unknown): boolean {
    const call = this.#settle(id)
    if (call === undefined) return false
    call.resolve(value)
    return true
  }

  reject(id: string, error: ConnectorError): boolean {
    const call = this.#settle(id)
    if (call === undefined) return false
    call.reject(error)
    return true
  }

  event(id: string, event: unknown): boolean {
    const call = this.#pending.get(id)
    if (call === undefined) return false
    try {
      call.onEvent?.(event)
    } catch {
      // a consumer error must not break the stream
    }
    return true
  }

  methodOf(id: string): string | undefined {
    return this.#pending.get(id)?.method
  }

  rejectAll(make: (method: string) => ConnectorError): void {
    for (const id of [...this.#pending.keys()]) {
      const call = this.#settle(id)
      if (call !== undefined) call.reject(make(call.method))
    }
  }

  #settle(id: string): PendingCall | undefined {
    const call = this.#pending.get(id)
    if (call === undefined) return undefined
    this.#pending.delete(id)
    clearTimeout(call.timer)
    call.detach()
    return call
  }
}
