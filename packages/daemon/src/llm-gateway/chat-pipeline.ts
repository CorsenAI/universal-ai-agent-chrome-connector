import type { NormalizedChatRequest, NormalizedChatResult, NormalizedToolCall } from '@corsen-ai/shared'
import type { Logger } from '../util/logger'
import type { BrainRouter } from './brain-router'
import { ToolCallStreamParser, allowedToolNames, extractToolCalls } from './tool-shim'

/** Holds back text that could be the start of a stop sequence; truncates at the first match. */
export class StopFilter {
  readonly #stops: readonly string[]
  #held = ''
  #stopped = false

  constructor(stops: readonly string[]) {
    this.#stops = stops.filter((stop) => stop !== '')
  }

  get stopped(): boolean {
    return this.#stopped
  }

  push(delta: string): string {
    if (this.#stopped) return ''
    if (this.#stops.length === 0) return delta
    const text = this.#held + delta
    let cut = -1
    for (const stop of this.#stops) {
      const index = text.indexOf(stop)
      if (index >= 0 && (cut < 0 || index < cut)) cut = index
    }
    if (cut >= 0) {
      this.#stopped = true
      this.#held = ''
      return text.slice(0, cut)
    }
    // keep the longest suffix that is a prefix of some stop sequence
    let keep = 0
    for (const stop of this.#stops) {
      for (let length = Math.min(stop.length - 1, text.length); length > keep; length -= 1) {
        if (stop.startsWith(text.slice(text.length - length))) {
          keep = length
          break
        }
      }
    }
    this.#held = text.slice(text.length - keep)
    return text.slice(0, text.length - keep)
  }

  end(): string {
    if (this.#stopped) return ''
    const rest = this.#held
    this.#held = ''
    return rest
  }
}

export interface ChatRunOptions {
  readonly signal: AbortSignal
  /** Streamed text, already stripped of tool-call blocks. Omit for non-streaming requests. */
  readonly onText?: ((delta: string) => void) | undefined
  readonly newToolCallId: () => string
  readonly logger: Logger
}

/**
 * The provider-neutral generation pipeline shared by the OpenAI and Anthropic endpoints:
 * router (web tab) → stop filter → tool-call parser → normalized result.
 */
export async function runChat(router: BrainRouter, request: NormalizedChatRequest, options: ChatRunOptions): Promise<NormalizedChatResult> {
  const allowed = request.toolChoice.type === 'none' ? new Map<string, string>() : allowedToolNames(request.tools)
  const stop = new StopFilter(request.stopSequences)
  const parser = new ToolCallStreamParser(allowed)
  let streamedRaw = ''
  let emitted = ''

  const forward = (raw: string): void => {
    const visible = parser.push(stop.push(raw))
    if (visible !== '') {
      emitted += visible
      options.onText?.(visible)
    }
  }

  const handle = await router.generate(request, {
    signal: options.signal,
    onDelta: (delta) => {
      streamedRaw += delta
      if (options.onText !== undefined) forward(delta)
    },
  })

  let text: string
  let calls: readonly { name: string; arguments: Record<string, unknown> }[]
  if (options.onText !== undefined) {
    if (handle.text.startsWith(streamedRaw)) {
      forward(handle.text.slice(streamedRaw.length))
    } else {
      options.logger.warn('final answer diverged from the streamed text; keeping what was streamed', {
        streamedChars: streamedRaw.length,
        finalChars: handle.text.length,
      })
    }
    const tailVisible = parser.push(stop.end())
    const end = parser.end()
    const tail = tailVisible + end.text
    if (tail !== '') {
      emitted += tail
      options.onText(tail)
    }
    text = emitted.trim()
    calls = end.toolCalls
  } else {
    const stopFiltered = stop.push(handle.text) + stop.end()
    const extracted = extractToolCalls(stopFiltered, allowed)
    text = extracted.text
    calls = extracted.toolCalls
  }

  const toolCalls: NormalizedToolCall[] = calls.map((call) => ({ id: options.newToolCallId(), name: call.name, arguments: call.arguments }))
  router.recordReply(handle, { role: 'assistant', content: text, toolCalls })
  return {
    text,
    toolCalls,
    finishReason: handle.finishReason === 'timeout' ? 'length' : handle.finishReason === 'cancelled' ? 'cancelled' : stop.stopped ? 'stop' : handle.finishReason,
    promptChars: handle.built.prompt.length,
    completionChars: handle.text.length,
    servedBy: handle.harnessId,
  }
}
