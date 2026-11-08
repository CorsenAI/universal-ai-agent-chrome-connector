import { createHash } from 'node:crypto'
import { contentPartsToText, type NormalizedChatRequest, type NormalizedMessage, type NormalizedToolCall } from '@corsen-ai/shared'
import { renderToolChoiceReminder, renderToolInstructions } from './tool-shim'

/**
 * Turns a stateless API request into what is typed into a stateful web chat.
 *
 * Continuity: a web conversation already holds earlier turns. When a request is exactly the previous
 * exchange plus new user / tool-result messages, only those new messages are typed (delta). Anything
 * else — another conversation, an edited history, other tools, the tab moved to another chat — starts
 * a new chat with the full transcript. When unsure, start over: a duplicated context is cheaper than
 * a wrong one.
 */

export interface ConversationSession {
  /** Fingerprints of every message the web conversation holds, in order (including our replies). */
  readonly fingerprints: readonly string[]
  /** Fingerprint of the declared tools; a change requires a new chat (instructions differ). */
  readonly toolsKey: string
  /** URL of the conversation after the last reply (to notice the user switching chats). */
  readonly url: string
}

export interface BuiltPrompt {
  readonly prompt: string
  readonly newChat: boolean
  readonly requestFingerprints: readonly string[]
  readonly toolsKey: string
}

function canonicalToolCalls(calls: readonly NormalizedToolCall[]): unknown[] {
  return calls.map((call) => ({ name: call.name, arguments: sortKeys(call.arguments) }))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** Canonical, whitespace-tolerant fingerprint (clients often trim or re-wrap what we returned). */
export function fingerprintMessage(message: NormalizedMessage): string {
  let canonical: unknown
  switch (message.role) {
    case 'system':
      canonical = ['system', message.content.trim()]
      break
    case 'user':
      canonical = ['user', contentPartsToText(message.content).trim()]
      break
    case 'assistant':
      canonical = ['assistant', message.content.replace(/\s+/g, ' ').trim(), canonicalToolCalls(message.toolCalls)]
      break
    case 'tool':
      canonical = ['tool', message.toolCallId, message.content.trim()]
      break
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32)
}

export function toolsKey(request: NormalizedChatRequest): string {
  if (request.tools.length === 0 || request.toolChoice.type === 'none') return 'none'
  const canonical = request.tools.map((tool) => [tool.name, tool.description, sortKeys(tool.parameters)])
  return createHash('sha256').update(JSON.stringify([canonical, request.parallelToolCalls])).digest('hex').slice(0, 32)
}

function renderToolCallsBlock(calls: readonly NormalizedToolCall[]): string {
  return ['```tool_calls', JSON.stringify({ tool_calls: canonicalToolCalls(calls) }), '```'].join('\n')
}

function renderMessage(message: NormalizedMessage): string {
  switch (message.role) {
    case 'system':
      return `SYSTEM:\n${message.content}`
    case 'user':
      return `USER:\n${contentPartsToText(message.content)}`
    case 'assistant': {
      const parts = [message.content.trim()]
      if (message.toolCalls.length > 0) parts.push(renderToolCallsBlock(message.toolCalls))
      return `ASSISTANT:\n${parts.filter((part) => part !== '').join('\n')}`
    }
    case 'tool':
      return `TOOL RESULT (tool: ${message.name || 'unknown'}, id: ${message.toolCallId})${message.isError ? ' [ERROR]' : ''}:\n${message.content}`
  }
}

function hasTools(request: NormalizedChatRequest): boolean {
  return request.tools.length > 0 && request.toolChoice.type !== 'none'
}

const JSON_MODE = '[OUTPUT FORMAT]\nReply with one valid JSON value and nothing else (no prose, no code fence).'

/** Full transcript for a new chat. A lone user message with nothing else is typed as-is. */
export function renderFullPrompt(request: NormalizedChatRequest): string {
  const system = request.messages
    .filter((message): message is Extract<NormalizedMessage, { role: 'system' }> => message.role === 'system')
    .map((message) => message.content.trim())
    .filter((text) => text !== '')
    .join('\n\n')
  const conversation = request.messages.filter((message) => message.role !== 'system')
  const tools = hasTools(request)
  const only = conversation.length === 1 ? conversation[0] : undefined
  if (only?.role === 'user' && system === '' && !tools && !request.jsonMode) return contentPartsToText(only.content)

  const sections: string[] = []
  if (system !== '') sections.push(`[SYSTEM INSTRUCTIONS]\n${system}`)
  if (tools) sections.push(renderToolInstructions(request.tools, request.toolChoice, request.parallelToolCalls))
  if (request.jsonMode) sections.push(JSON_MODE)
  if (only?.role === 'user') {
    sections.push(`[USER MESSAGE]\n${contentPartsToText(only.content)}`)
  } else {
    sections.push(
      [
        '[CONVERSATION]',
        'The conversation so far is below, one turn per block. Continue as the ASSISTANT: answer the last message only, without repeating these labels.',
        '',
        conversation.map(renderMessage).join('\n\n'),
      ].join('\n'),
    )
  }
  return sections.join('\n\n')
}

/** What is typed when the web conversation already holds the earlier turns. */
export function renderDeltaPrompt(delta: readonly NormalizedMessage[], request: NormalizedChatRequest): string {
  const reminder = renderToolChoiceReminder(request.toolChoice)
  const onlyUser = delta.length === 1 && delta[0]?.role === 'user'
  const body = onlyUser && delta[0]?.role === 'user' ? contentPartsToText(delta[0].content) : delta.map(renderMessage).join('\n\n')
  const parts = [body]
  const endsWithToolResult = delta[delta.length - 1]?.role === 'tool'
  if (endsWithToolResult) {
    parts.push('Continue the task with these results. If another tool is needed, reply with a tool_calls block; otherwise give your answer.')
  }
  if (reminder !== null && hasTools(request)) parts.push(reminder)
  if (request.jsonMode) parts.push('Reply with one valid JSON value and nothing else.')
  return parts.join('\n\n')
}

/** Decide between delta and new chat, and produce the text to type. */
export function buildPrompt(request: NormalizedChatRequest, session: ConversationSession | null, currentUrl: string | null): BuiltPrompt {
  const requestFingerprints = request.messages.map(fingerprintMessage)
  const key = toolsKey(request)
  if (session !== null && session.toolsKey === key && (currentUrl === null || currentUrl === session.url)) {
    const known = session.fingerprints
    const isPrefix = known.length > 0 && known.length < requestFingerprints.length && known.every((fp, index) => fp === requestFingerprints[index])
    if (isPrefix) {
      const delta = request.messages.slice(known.length)
      if (delta.every((message) => message.role === 'user' || message.role === 'tool')) {
        return { prompt: renderDeltaPrompt(delta, request), newChat: false, requestFingerprints, toolsKey: key }
      }
    }
  }
  return { prompt: renderFullPrompt(request), newChat: true, requestFingerprints, toolsKey: key }
}

/** Session state after a successful reply: the request's messages plus our normalized answer. */
export function sessionAfterReply(built: BuiltPrompt, reply: Extract<NormalizedMessage, { role: 'assistant' }>, url: string): ConversationSession {
  return { fingerprints: [...built.requestFingerprints, fingerprintMessage(reply)], toolsKey: built.toolsKey, url }
}
