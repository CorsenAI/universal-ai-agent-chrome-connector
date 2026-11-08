import { describe, expect, it } from 'vitest'
import { AnthropicMessagesRequestSchema, OpenAIChatRequestSchema, type NormalizedChatResult } from '@corsen-ai/shared'
import { AnthropicStreamWriter, anthropicMessage, normalizeAnthropicRequest } from '../src/llm-gateway/anthropic-convert'
import { StopFilter } from '../src/llm-gateway/chat-pipeline'
import { OpenAIStreamWriter, normalizeOpenAIRequest, openAICompletion } from '../src/llm-gateway/openai-convert'

const result: NormalizedChatResult = {
  text: 'Checking.',
  toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }],
  finishReason: 'stop',
  promptChars: 400,
  completionChars: 120,
  servedBy: 'deepseek',
}

function sseData(stream: string): unknown[] {
  return stream
    .split('\n\n')
    .filter((block) => block.startsWith('data: ') && !block.startsWith('data: [DONE]'))
    .map((block) => JSON.parse(block.slice(6)))
}

describe('OpenAI conversion', () => {
  it('normalizes roles, tool calls and tool results (name looked up by id)', () => {
    const parsed = OpenAIChatRequestSchema.parse({
      model: 'gpt-5',
      messages: [
        { role: 'developer', content: 'Rules' },
        { role: 'user', content: [{ type: 'text', text: 'Weather?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: 'call_9', content: '21°C' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      tool_choice: 'required',
      stop: 'END',
      response_format: { type: 'json_object' },
    })
    const normalized = normalizeOpenAIRequest(parsed)
    expect(normalized.messages[0]).toEqual({ role: 'system', content: 'Rules' })
    expect(normalized.messages[2]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call_9', name: 'get_weather', arguments: { city: 'Paris' } }] })
    expect(normalized.messages[3]).toEqual({ role: 'tool', toolCallId: 'call_9', name: 'get_weather', content: '21°C', isError: false })
    expect(normalized.toolChoice).toEqual({ type: 'required' })
    expect(normalized.stopSequences).toEqual(['END'])
    expect(normalized.jsonMode).toBe(true)
    expect(normalized.warnings.join(' ')).toContain('Images')
  })

  it('builds a chat.completion with tool_calls and finish_reason', () => {
    const body = openAICompletion(result, 'gpt-5', 'chatcmpl-1', 1) as any
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0].finish_reason).toBe('tool_calls')
    expect(body.choices[0].message.tool_calls[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } })
    expect(body.usage.prompt_tokens).toBe(100)
  })

  it('streams chunks: role first, text deltas, tool calls, finish, usage, [DONE]', () => {
    const writer = new OpenAIStreamWriter('gpt-5', true, 'chatcmpl-1', 1)
    const stream = writer.start() + writer.text('Check') + writer.text('ing.') + writer.finish(result)
    const chunks = sseData(stream) as any[]
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' })
    expect(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')).toBe('Checking.')
    const toolChunk = chunks.find((chunk) => chunk.choices[0]?.delta?.tool_calls)
    expect(toolChunk.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: 'call_1', function: { name: 'get_weather' } })
    const finish = chunks.find((chunk) => chunk.choices[0]?.finish_reason)
    expect(finish.choices[0].finish_reason).toBe('tool_calls')
    const usage = chunks.at(-1)
    expect(usage.choices).toEqual([])
    expect(usage.usage.total_tokens).toBe(130)
    expect(stream.trimEnd().endsWith('data: [DONE]')).toBe(true)
    for (const chunk of chunks) expect(chunk.object).toBe('chat.completion.chunk')
  })
})

describe('Anthropic conversion', () => {
  it('splits tool_result blocks into tool messages and maps tool_choice', () => {
    const parsed = AnthropicMessagesRequestSchema.parse({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      system: [{ type: 'text', text: 'Sys' }],
      messages: [
        { role: 'user', content: 'Weather?' },
        { role: 'assistant', content: [{ type: 'text', text: 'Let me check' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '21°C' }] }, { type: 'text', text: 'Thanks' }] },
      ],
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }, { name: 'web_search', type: 'web_search_20250305' }],
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
    })
    const normalized = normalizeAnthropicRequest(parsed)
    expect(normalized.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(normalized.messages[3]).toEqual({ role: 'tool', toolCallId: 'toolu_1', name: 'get_weather', content: '21°C', isError: false })
    expect(normalized.tools.map((tool) => tool.name)).toEqual(['get_weather'])
    expect(normalized.toolChoice).toEqual({ type: 'required' })
    expect(normalized.parallelToolCalls).toBe(false)
  })

  it('builds a message with tool_use blocks and stop_reason tool_use', () => {
    const body = anthropicMessage(result, 'claude', 'msg_1') as any
    expect(body.content).toEqual([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
    ])
    expect(body.stop_reason).toBe('tool_use')
  })

  it('streams events in the documented order', () => {
    const writer = new AnthropicStreamWriter('claude', 400, 'msg_1')
    const stream = writer.start() + writer.ping() + writer.text('Check') + writer.text('ing.') + writer.finish(result)
    const events = [...stream.matchAll(/^event: (\w+)$/gm)].map((match) => match[1])
    expect(events).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const toolDelta = stream.split('\n\n').find((block) => block.includes('input_json_delta'))
    expect(JSON.parse(toolDelta!.split('data: ')[1]!).delta.partial_json).toBe('{"city":"Paris"}')
    expect(stream).toContain('"stop_reason":"tool_use"')
  })
})

describe('stop sequences', () => {
  it('truncates at the first stop sequence even when it is split across deltas', () => {
    const filter = new StopFilter(['STOP'])
    const out = filter.push('Hello ST') + filter.push('OP and more') + filter.end()
    expect(out).toBe('Hello ')
    expect(filter.stopped).toBe(true)
  })

  it('releases held text when it was not a stop sequence', () => {
    const filter = new StopFilter(['STOP'])
    expect(filter.push('Hello ST') + filter.push('ar') + filter.end()).toBe('Hello STar')
  })
})
