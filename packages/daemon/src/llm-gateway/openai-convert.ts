import { randomBytes } from 'node:crypto'
import type {
  NormalizedChatRequest,
  NormalizedChatResult,
  NormalizedContentPart,
  NormalizedMessage,
  NormalizedTool,
  NormalizedToolCall,
  NormalizedToolChoice,
  OpenAIChatRequest,
  OpenAIMessage,
} from '@corsen-ai/shared'
import { estimateTokens } from '@corsen-ai/shared'
import { parseLenientJson } from './tool-shim'

/** OpenAI Chat Completions ⇄ normalized conversion (shapes per the official `openai` SDK 7.53 types). */

type OpenAIContent = OpenAIMessage['content']

function contentToParts(content: OpenAIContent, warnings: string[]): NormalizedContentPart[] {
  if (content === null || content === undefined) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  const parts: NormalizedContentPart[] = []
  for (const part of content) {
    if (part.type === 'text' && typeof part['text'] === 'string') parts.push({ type: 'text', text: part['text'] })
    else if (part.type === 'image_url') {
      const imageUrl = part['image_url'] as { url?: unknown } | undefined
      const url = typeof imageUrl?.url === 'string' ? imageUrl.url : ''
      const mediaType = /^data:([^;,]+)/.exec(url)?.[1] ?? ''
      parts.push({ type: 'image', mediaType, url: url.startsWith('data:') ? '' : url })
      warnings.push('Images cannot be forwarded to a web chat yet; they were replaced by a placeholder.')
    } else warnings.push(`Content part "${String(part.type)}" is not supported and was skipped.`)
  }
  return parts
}

function contentToText(content: OpenAIContent): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .map((part) => (part.type === 'text' && typeof part['text'] === 'string' ? part['text'] : ''))
    .filter((text) => text !== '')
    .join('\n')
}

function parseArguments(raw: string): Record<string, unknown> {
  const value = raw.trim() === '' ? {} : parseLenientJson(raw)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return { _raw: raw }
}

export function normalizeOpenAIRequest(request: OpenAIChatRequest): NormalizedChatRequest {
  const warnings: string[] = []
  const toolNames = new Map<string, string>()
  const messages: NormalizedMessage[] = []

  for (const message of request.messages) {
    switch (message.role) {
      case 'system':
      case 'developer':
        messages.push({ role: 'system', content: contentToText(message.content) })
        break
      case 'user':
        messages.push({ role: 'user', content: contentToParts(message.content, warnings) })
        break
      case 'assistant': {
        const toolCalls: NormalizedToolCall[] = []
        for (const call of message.tool_calls ?? []) {
          toolNames.set(call.id, call.function.name)
          toolCalls.push({ id: call.id, name: call.function.name, arguments: parseArguments(call.function.arguments) })
        }
        if (message.function_call) {
          const id = `legacy_${message.function_call.name}`
          toolNames.set(id, message.function_call.name)
          toolCalls.push({ id, name: message.function_call.name, arguments: parseArguments(message.function_call.arguments) })
        }
        messages.push({ role: 'assistant', content: contentToText(message.content), toolCalls })
        break
      }
      case 'tool':
        messages.push({
          role: 'tool',
          toolCallId: message.tool_call_id,
          name: toolNames.get(message.tool_call_id) ?? '',
          content: contentToText(message.content),
          isError: false,
        })
        break
      case 'function':
        messages.push({ role: 'tool', toolCallId: `legacy_${message.name}`, name: message.name, content: contentToText(message.content), isError: false })
        break
    }
  }

  const tools: NormalizedTool[] = []
  for (const tool of request.tools ?? []) {
    tools.push({ name: tool.function.name, description: tool.function.description ?? '', parameters: tool.function.parameters ?? { type: 'object', properties: {} } })
  }
  for (const fn of request.functions ?? []) {
    tools.push({ name: fn.name, description: fn.description ?? '', parameters: fn.parameters ?? { type: 'object', properties: {} } })
  }

  let toolChoice: NormalizedToolChoice = { type: 'auto' }
  const choice = request.tool_choice ?? request.function_call
  if (choice === 'none') toolChoice = { type: 'none' }
  else if (choice === 'required') toolChoice = { type: 'required' }
  else if (choice !== null && choice !== undefined && typeof choice === 'object') {
    const name = 'function' in choice ? (choice.function as { name: string }).name : (choice as { name?: string }).name
    if (typeof name === 'string') toolChoice = { type: 'tool', name }
  }

  if ((request.n ?? 1) > 1) warnings.push('Only n=1 is supported; one choice is returned.')
  if (request.temperature !== null && request.temperature !== undefined) warnings.push('Sampling parameters are ignored by web chats.')

  const format = request.response_format?.type
  const stop = request.stop
  return {
    model: request.model,
    messages,
    tools,
    toolChoice,
    parallelToolCalls: request.parallel_tool_calls ?? true,
    stream: request.stream === true,
    maxTokens: request.max_completion_tokens ?? request.max_tokens ?? null,
    stopSequences: stop === null || stop === undefined ? [] : typeof stop === 'string' ? [stop] : stop,
    jsonMode: format === 'json_object' || format === 'json_schema',
    warnings,
  }
}

export function newCompletionId(): string {
  return `chatcmpl-${randomBytes(12).toString('base64url')}`
}

export function newToolCallId(): string {
  return `call_${randomBytes(12).toString('base64url')}`
}

function finishReason(result: NormalizedChatResult): 'stop' | 'length' | 'tool_calls' {
  if (result.toolCalls.length > 0) return 'tool_calls'
  return result.finishReason === 'length' ? 'length' : 'stop'
}

export function usageOf(result: Pick<NormalizedChatResult, 'promptChars' | 'completionChars'>): {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
} {
  const prompt = estimateTokens(result.promptChars)
  const completion = estimateTokens(result.completionChars)
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

export function toOpenAIToolCalls(calls: readonly NormalizedToolCall[]): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> {
  return calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
}

/** Non-streaming `chat.completion` object. */
export function openAICompletion(result: NormalizedChatResult, model: string, id: string, created: number): Record<string, unknown> {
  const toolCalls = toOpenAIToolCalls(result.toolCalls)
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    system_fingerprint: `corsen-${result.servedBy}`,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text === '' && toolCalls.length > 0 ? null : result.text,
          refusal: null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason(result),
      },
    ],
    usage: usageOf(result),
  }
}

/** Builds `chat.completion.chunk` SSE frames for one streamed answer. */
export class OpenAIStreamWriter {
  readonly #id: string
  readonly #model: string
  readonly #created: number
  readonly #includeUsage: boolean
  #started = false

  constructor(model: string, includeUsage: boolean, id = newCompletionId(), created = Math.floor(Date.now() / 1000)) {
    this.#id = id
    this.#model = model
    this.#created = created
    this.#includeUsage = includeUsage
  }

  #chunk(delta: Record<string, unknown>, finish: string | null): string {
    const chunk: Record<string, unknown> = {
      id: this.#id,
      object: 'chat.completion.chunk',
      created: this.#created,
      model: this.#model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    }
    if (this.#includeUsage) chunk['usage'] = null
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  /** First frame announces the assistant role. */
  start(): string {
    if (this.#started) return ''
    this.#started = true
    return this.#chunk({ role: 'assistant', content: '' }, null)
  }

  text(delta: string): string {
    if (delta === '') return ''
    return this.start() + this.#chunk({ content: delta }, null)
  }

  /** Tool calls are emitted whole, one chunk per call, after the text. */
  finish(result: NormalizedChatResult): string {
    let out = this.start()
    toOpenAIToolCalls(result.toolCalls).forEach((call, index) => {
      out += this.#chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: call.function }] }, null)
    })
    out += this.#chunk({}, finishReason(result))
    if (this.#includeUsage) {
      out += `data: ${JSON.stringify({ id: this.#id, object: 'chat.completion.chunk', created: this.#created, model: this.#model, choices: [], usage: usageOf(result) })}\n\n`
    }
    return `${out}data: [DONE]\n\n`
  }

  error(message: string, type: string, code: string): string {
    return `data: ${JSON.stringify({ error: { message, type, param: null, code } })}\n\ndata: [DONE]\n\n`
  }
}

/** OpenAI-style error body. */
export function openAIError(message: string, type: string, code: string): Record<string, unknown> {
  return { error: { message, type, param: null, code } }
}
