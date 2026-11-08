/**
 * Server-sent events response backed by a ReadableStream. The producer receives an `emit` function
 * and an AbortSignal that fires when the client goes away (stream cancelled or request aborted), so
 * the web generation can be cancelled instead of running for nobody.
 */
export interface StreamingOptions {
  /** Payload sent periodically while waiting (SSE comment or a ping event). */
  readonly keepAlive?: (() => string) | undefined
  readonly keepAliveMs?: number | undefined
  /** The incoming request's signal, when the runtime provides one. */
  readonly requestSignal?: AbortSignal | undefined
}

export function sseResponse(
  produce: (emit: (chunk: string) => void, signal: AbortSignal) => Promise<void>,
  options: StreamingOptions = {},
): Response {
  const abort = new AbortController()
  options.requestSignal?.addEventListener('abort', () => abort.abort(), { once: true })
  const encoder = new TextEncoder()
  let closed = false
  let timer: NodeJS.Timeout | undefined

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (chunk: string): void => {
        if (closed || chunk === '') return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
          abort.abort()
        }
      }
      if (options.keepAlive !== undefined) {
        const keepAlive = options.keepAlive
        timer = setInterval(() => emit(keepAlive()), options.keepAliveMs ?? 15_000)
        timer.unref?.()
      }
      produce(emit, abort.signal)
        .catch(() => undefined)
        .finally(() => {
          if (timer !== undefined) clearInterval(timer)
          if (!closed) {
            closed = true
            try {
              controller.close()
            } catch {
              // already closed by the consumer
            }
          }
        })
    },
    cancel() {
      closed = true
      if (timer !== undefined) clearInterval(timer)
      abort.abort()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
