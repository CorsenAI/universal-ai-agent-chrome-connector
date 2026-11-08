import { describe, expect, it } from 'vitest'
import type { NormalizedChatRequest, NormalizedMessage } from '@corsen-ai/shared'
import { buildPrompt, renderFullPrompt, sessionAfterReply } from '../src/llm-gateway/prompt-builder'

function request(messages: NormalizedMessage[], extra: Partial<NormalizedChatRequest> = {}): NormalizedChatRequest {
  return {
    model: 'web-auto',
    messages,
    tools: [],
    toolChoice: { type: 'auto' },
    parallelToolCalls: true,
    stream: false,
    maxTokens: null,
    stopSequences: [],
    jsonMode: false,
    warnings: [],
    ...extra,
  }
}

const user = (text: string): NormalizedMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string): Extract<NormalizedMessage, { role: 'assistant' }> => ({ role: 'assistant', content: text, toolCalls: [] })

describe('prompt builder', () => {
  it('types a lone user message as-is', () => {
    expect(renderFullPrompt(request([user('What is 2+2?')]))).toBe('What is 2+2?')
  })

  it('renders system instructions, tools and the conversation for a new chat', () => {
    const text = renderFullPrompt(
      request([{ role: 'system', content: 'Be terse.' }, user('Hi'), assistant('Hello'), user('Weather in Paris?')], {
        tools: [{ name: 'get_weather', description: 'Weather', parameters: { type: 'object' } }],
      }),
    )
    expect(text).toContain('[SYSTEM INSTRUCTIONS]\nBe terse.')
    expect(text).toContain('[TOOLS]')
    expect(text).toContain('USER:\nHi')
    expect(text).toContain('ASSISTANT:\nHello')
    expect(text.trim().endsWith('USER:\nWeather in Paris?')).toBe(true)
  })

  it('types only the new turn when the request continues the web conversation', () => {
    const first = request([user('Hi')])
    const built = buildPrompt(first, null, null)
    expect(built.newChat).toBe(true)
    const session = sessionAfterReply(built, assistant('Hello!'), 'https://chat.example/c/1')
    const second = buildPrompt(request([user('Hi'), assistant('Hello!'), user('And you?')]), session, 'https://chat.example/c/1')
    expect(second.newChat).toBe(false)
    expect(second.prompt).toBe('And you?')
  })

  it('tolerates whitespace differences in our previous answer', () => {
    const built = buildPrompt(request([user('Hi')]), null, null)
    const session = sessionAfterReply(built, assistant('Hello  there!\n'), 'u')
    expect(buildPrompt(request([user('Hi'), assistant('Hello there!'), user('Next')]), session, 'u').newChat).toBe(false)
  })

  it('starts a new chat when history diverges, the chat changed, or tools changed', () => {
    const built = buildPrompt(request([user('Hi')]), null, null)
    const session = sessionAfterReply(built, assistant('Hello!'), 'https://chat.example/c/1')
    expect(buildPrompt(request([user('Other'), assistant('Hello!'), user('x')]), session, 'https://chat.example/c/1').newChat).toBe(true)
    expect(buildPrompt(request([user('Hi'), assistant('Hello!'), user('x')]), session, 'https://chat.example/c/2').newChat).toBe(true)
    const withTools = request([user('Hi'), assistant('Hello!'), user('x')], { tools: [{ name: 't', description: '', parameters: {} }] })
    expect(buildPrompt(withTools, session, 'https://chat.example/c/1').newChat).toBe(true)
  })

  it('renders tool results as a delta and asks to continue', () => {
    const tools = [{ name: 'get_weather', description: 'Weather', parameters: { type: 'object' } }]
    const first = request([user('Weather?')], { tools })
    const built = buildPrompt(first, null, null)
    const call = { id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }
    const session = sessionAfterReply(built, { role: 'assistant', content: '', toolCalls: [call] }, 'u')
    const next = buildPrompt(
      request([user('Weather?'), { role: 'assistant', content: '', toolCalls: [call] }, { role: 'tool', toolCallId: 'call_1', name: 'get_weather', content: '21°C', isError: false }], { tools }),
      session,
      'u',
    )
    expect(next.newChat).toBe(false)
    expect(next.prompt).toContain('TOOL RESULT (tool: get_weather, id: call_1):\n21°C')
    expect(next.prompt).toContain('Continue the task')
  })
})
