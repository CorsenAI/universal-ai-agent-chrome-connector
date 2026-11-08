import { randomBytes } from 'node:crypto'
import type {
  AnthropicBlock,
  AnthropicMessagesRequest,
  NormalizedChatRequest,
  NormalizedChatResult,
  NormalizedContentPart,
  NormalizedMessage,
  NormalizedTool,
  NormalizedToolCall,
  NormalizedToolChoice,
} from '@corsen-ai/shared'
import { estimateTokens } from '@corsen-ai/shared'

/**
 * Anthropic Messages ⇄ normalized conversion. Stream events follow the documented order:
 * message_start → (content_block_start → content_block_delta* → content_block_stop)* →
 * message_delta (stop_reason, cumulative usage) → message_stop, with optional ping events.
 */

function blockText(block: AnthropicBlock): string {
  return block.type === 'text' && typeof block['text'] === 'string' ? block['text'] : ''
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item: unknown) => {
      if (item === null || typeof item !== 'object') return ''
      const record = item as Record<string, unknown>
      if (record['type'] === 'text' && typeof record['text'] === 'string') return record['text']
      if (record['type'] === 'image') return '[image omitted]'
      return ''
    })
    .filter((text) => text !== '')
    .join('\n')
}

export function normalizeAnthropicRequest(request: AnthropicMessagesRequest): NormalizedChatRequest {
  const warnings: string[] = []
  const messages: NormalizedMessage[] = []
  const toolNames = new Map<string, string>()

  const system =
    typeof request.system === 'string'
      ? request.system
      : (request.system ?? []).map((block) => (block.type === 'text' && typeof block['text'] === 'string' ? block['text'] : '')).join('\n\n')
  if (system.trim() !== '') messages.push({ role: 'system', content: system })

  for (const message of request.messages) {
    const blocks: AnthropicBlock[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    if (message.role === 'assistant') {
      const text = blocks.map(blockText).filter((part) => part !== '').join('\n')
      const toolCalls: NormalizedToolCall[] = []
      for (const block of blocks) {
        if (block.type === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
          const input = block['input']
          toolNames.set(block['id'], block['name'])
          toolCalls.push({
            id: block['id'],
            name: block['name'],
            arguments: input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
          })
        }
      }
      messages.push({ role: 'assistant', content: text, toolCalls })
      continue
    }
    // user turn: tool results become tool messages (in order), the rest one user message
    const parts: NormalizedContentPart[] = []
    const flushUser = (): void => {
      if (parts.length > 0) messages.push({ role: 'user', content: parts.splice(0) })
    }
    for (const block of blocks) {
      if (block.type === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        flushUser()
        const id = block['tool_use_id']
        messages.push({ role: 'tool', toolCallId: id, name: toolNames.get(id) ?? '', content: toolResultText(block['content']), isError: block['is_error'] === true })
      } else if (block.type === 'text' && typeof block['text'] === 'string') {
        parts.push({ type: 'text', text: block['text'] })
      } else if (block.type === 'image') {
        const source = block['source'] as Record<string, unknown> | undefined
        parts.push({ type: 'image', mediaType: typeof source?.['media_type'] === 'string' ? source['media_type'] : '', url: typeof source?.['url'] === 'string' ? source['url'] : '' })
        warnings.push('Images cannot be forwarded to a web chat yet; they were replaced by a placeholder.')
      } else if (block.type === 'document') {
        const source = block['source'] as Record<string, unknown> | undefined
        if (source?.['type'] === 'text' && typeof source['data'] === 'string') parts.push({ type: 'text', text: source['data'] })
        else warnings.push('A document block could not be forwarded and was skipped.')
      }
      // thinking, redacted_thinking, cache_control-only blocks… are skipped silently
    }
    flushUser()
  }

  const tools: NormalizedTool[] = []
  for (const tool of request.tools ?? []) {
    if (tool.type !== undefined && tool.type !== 'custom' && tool.input_schema === undefined) {
      warnings.push(`Server tool "${tool.name}" (${tool.type}) cannot run in a web chat and was skipped.`)
      continue
    }
    tools.push({ name: tool.name, description: tool.description ?? '', parameters: tool.input_schema ?? { type: 'object', properties: {} } })
  }

  let toolChoice: NormalizedToolChoice = { type: 'auto' }
  const choice = request.tool_choice
  if (choice?.type === 'any') toolChoice = { type: 'required' }
  else if (choice?.type === 'none') toolChoice = { type: 'none' }
  else if (choice?.type === 'tool' && typeof choice.name === 'string') toolChoice = { type: 'tool', name: choice.name }
  if (request.thinking !== undefined) warnings.push('Extended thinking settings are ignored by web chats.')

  return {
    model: request.model,
    messages,
    tools,
    toolChoice,
    parallelToolCalls: choice?.disable_parallel_tool_use !== true,
    stream: request.stream === true,
    maxTokens: request.max_tokens ?? null,
    stopSequences: request.stop_sequences ?? [],
    jsonMode: false,
    warnings,
  }
}

export function newMessageId(): string {
  return `msg_${randomBytes(12).toString('base64url')}`
}

export function newToolUseId(): string {
  return `toolu_${randomBytes(12).toString('base64url')}`
}

function stopReason(result: NormalizedChatResult): 'end_turn' | 'max_tokens' | 'tool_use' {
  if (result.toolCalls.length > 0) return 'tool_use'
  return result.finishReason === 'length' ? 'max_tokens' : 'end_turn'
}

export function anthropicMessage(result: NormalizedChatResult, model: string, id: string): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = []
  if (result.text !== '') content.push({ type: 'text', text: result.text })
  for (const call of result.toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason(result),
    stop_sequence: null,
    usage: { input_tokens: estimateTokens(result.promptChars), output_tokens: estimateTokens(result.completionChars) },
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Builds Anthropic SSE events for one streamed answer. */
export class AnthropicStreamWriter {
  readonly #id: string
  readonly #model: string
  readonly #inputTokens: number
  #index = 0
  #textOpen = false
  #started = false

  constructor(model: string, promptChars: number, id = newMessageId()) {
    this.#id = id
    this.#model = model
    this.#inputTokens = estimateTokens(promptChars)
  }

  start(): string {
    if (this.#started) return ''
    this.#started = true
    return sse('message_start', {
      type: 'message_start',
      message: {
        id: this.#id,
        type: 'message',
        role: 'assistant',
        model: this.#model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.#inputTokens, output_tokens: 1 },
      },
    })
  }

  ping(): string {
    return sse('ping', { type: 'ping' })
  }

  text(delta: string): string {
    if (delta === '') return ''
    let out = this.start()
    if (!this.#textOpen) {
      out += sse('content_block_start', { type: 'content_block_start', index: this.#index, content_block: { type: 'text', text: '' } })
      this.#textOpen = true
    }
    return out + sse('content_block_delta', { type: 'content_block_delta', index: this.#index, delta: { type: 'text_delta', text: delta } })
  }

  finish(result: NormalizedChatResult): string {
    let out = this.start()
    if (this.#textOpen) {
      out += sse('content_block_stop', { type: 'content_block_stop', index: this.#index })
      this.#textOpen = false
      this.#index += 1
    }
    for (const call of result.toolCalls) {
      out += sse('content_block_start', { type: 'content_block_start', index: this.#index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
      out += sse('content_block_delta', { type: 'content_block_delta', index: this.#index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } })
      out += sse('content_block_stop', { type: 'content_block_stop', index: this.#index })
      this.#index += 1
    }
    out += sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason(result), stop_sequence: null },
      usage: { output_tokens: estimateTokens(result.completionChars) },
    })
    return out + sse('message_stop', { type: 'message_stop' })
  }

  error(type: string, message: string): string {
    return sse('error', { type: 'error', error: { type, message } })
  }
}

export function anthropicError(type: string, message: string): Record<string, unknown> {
  return { type: 'error', error: { type, message } }
}
