import { describe, expect, it } from 'vitest'
import type { NormalizedTool } from '@corsen-ai/shared'
import { ToolCallStreamParser, allowedToolNames, extractToolCalls, parseLenientJson, renderToolInstructions } from '../src/llm-gateway/tool-shim'

const tools: NormalizedTool[] = [
  { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]
const allowed = allowedToolNames(tools)

/** Feed `text` to a fresh parser split into chunks at every possible boundary pair. */
function streamAllSplits(text: string): Array<{ text: string; calls: number }> {
  const results: Array<{ text: string; calls: number }> = []
  for (let cut = 0; cut <= text.length; cut += 1) {
    const parser = new ToolCallStreamParser(allowed)
    let out = parser.push(text.slice(0, cut))
    out += parser.push(text.slice(cut))
    const end = parser.end()
    results.push({ text: (out + end.text).trim(), calls: end.toolCalls.length })
  }
  return results
}

describe('tool instructions', () => {
  it('lists every tool and the exact block format', () => {
    const text = renderToolInstructions(tools, { type: 'auto' }, true)
    expect(text).toContain('"name":"get_weather"')
    expect(text).toContain('```tool_calls')
    expect(text).toContain('{"tool_calls": [{"name": "TOOL_NAME"')
  })

  it('states forced choices', () => {
    expect(renderToolInstructions(tools, { type: 'required' }, false)).toContain('must call at least one tool')
    expect(renderToolInstructions(tools, { type: 'tool', name: 'read_file' }, false)).toContain('must call the tool "read_file"')
    expect(renderToolInstructions(tools, { type: 'auto' }, false)).toContain('exactly one call')
  })
})

describe('tool call parsing', () => {
  const answer = 'Let me check.\n```tool_calls\n{"tool_calls": [{"name": "get_weather", "arguments": {"city": "Paris"}}]}\n```\n'

  it('extracts a tool_calls fence and keeps the text before it', () => {
    const result = extractToolCalls(answer, allowed)
    expect(result.text).toBe('Let me check.')
    expect(result.toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }])
  })

  it('gives the same result for every streaming split', () => {
    for (const result of streamAllSplits(answer)) {
      expect(result).toEqual({ text: 'Let me check.', calls: 1 })
    }
  })

  it('never leaks any part of the tool block while streaming', () => {
    const parser = new ToolCallStreamParser(allowed)
    let visible = ''
    for (const char of answer) visible += parser.push(char)
    visible += parser.end().text
    expect(visible).not.toContain('tool_calls')
    expect(visible).not.toContain('Paris')
  })

  it('accepts json and unlabelled fences only with the tool_calls key', () => {
    const json = '```json\n{"tool_calls":[{"name":"read_file","arguments":{"path":"a.ts"}}]}\n```'
    expect(extractToolCalls(json, allowed).toolCalls).toHaveLength(1)
    const ordinary = 'Here is data:\n```json\n{"name": "read_file", "arguments": {}}\n```'
    const kept = extractToolCalls(ordinary, allowed)
    expect(kept.toolCalls).toHaveLength(0)
    expect(kept.text).toContain('"name": "read_file"')
  })

  it('accepts <tool_calls> tags and string arguments', () => {
    const tagged = 'ok\n<tool_calls>\n[{"name":"get_weather","arguments":"{\\"city\\":\\"Rome\\"}"}]\n</tool_calls>'
    const result = extractToolCalls(tagged, allowed)
    expect(result.toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Rome' } }])
    expect(result.text).toBe('ok')
  })

  it('repairs smart quotes and trailing commas', () => {
    expect(parseLenientJson('{“tool_calls”: [{“name”: “read_file”, “arguments”: {“path”: “x”,},},]}')).toEqual({ tool_calls: [{ name: 'read_file', arguments: { path: 'x' } }] })
  })

  it('treats unknown tool names as text, never as calls', () => {
    const fake = '```tool_calls\n{"tool_calls":[{"name":"rm_rf","arguments":{}}]}\n```'
    const result = extractToolCalls(fake, allowed)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.text).toContain('rm_rf')
  })

  it('maps case-insensitive names to the declared spelling and accepts OpenAI-shaped entries', () => {
    const shaped = '```tool_calls\n[{"type":"function","function":{"name":"GET_WEATHER","arguments":"{\\"city\\":\\"Oslo\\"}"}}]\n```'
    expect(extractToolCalls(shaped, allowed).toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Oslo' } }])
  })

  it('parses an unterminated tool fence at the end of the answer', () => {
    const open = '```tool_calls\n{"tool_calls":[{"name":"read_file","arguments":{"path":"b"}}]}'
    expect(extractToolCalls(open, allowed).toolCalls).toHaveLength(1)
  })

  it('streams other code blocks verbatim, including fences inside them', () => {
    const python = 'Code:\n```python\nprint("```tool_calls")\n```\nDone.'
    for (const result of streamAllSplits(python)) {
      expect(result.calls).toBe(0)
      expect(result.text).toBe(python)
    }
  })

  it('passes everything through when no tool is declared', () => {
    const parser = new ToolCallStreamParser(new Map())
    expect(parser.push(answer)).toBe(answer)
    expect(parser.end().toolCalls).toHaveLength(0)
  })

  it('collects several calls', () => {
    const many = '```tool_calls\n{"tool_calls":[{"name":"read_file","arguments":{"path":"a"}},{"name":"read_file","arguments":{"path":"b"}}]}\n```'
    expect(extractToolCalls(many, allowed).toolCalls.map((call) => call.arguments['path'])).toEqual(['a', 'b'])
  })
})
