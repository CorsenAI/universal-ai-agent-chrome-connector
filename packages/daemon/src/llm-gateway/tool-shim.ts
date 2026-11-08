import type { NormalizedTool, NormalizedToolChoice } from '@corsen-ai/shared'

/**
 * Universal function-calling shim for web chats that have no native tool API (D-008).
 *
 * Outbound: the declared tools become a plain-text section of the prompt asking the model to answer a
 * tool call with exactly one fenced block, language `tool_calls`, holding
 * `{"tool_calls":[{"name":…,"arguments":{…}}]}`. Code blocks survive every chat UI's Markdown
 * renderer verbatim, unlike raw XML tags.
 *
 * Inbound: {@link ToolCallStreamParser} consumes the answer as it streams, emits ordinary text right
 * away, holds back anything that may be the start of a tool block, and returns the parsed calls.
 * Accepted forms: a `tool_calls` fence (or `json` / unlabelled fence whose JSON has a `tool_calls`
 * key) and `<tool_calls>…</tool_calls>` tags. Names are validated against the declared tools.
 */

export interface ParsedToolCall {
  readonly name: string
  readonly arguments: Record<string, unknown>
}

const TOOL_LANGS = new Set(['tool_calls', 'tool_call', 'toolcalls', 'tool-calls', 'tools'])
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_.+-]*)[^\n`]*\n?$/
const TAG_OPEN = '<tool_calls>'
const TAG_CLOSE = '</tool_calls>'

export function renderToolInstructions(
  tools: readonly NormalizedTool[],
  choice: NormalizedToolChoice,
  parallel: boolean,
): string {
  const catalog = tools
    .map((tool) => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .join('\n')
  const rules = [
    '- Use only the tool names listed above, with arguments that match their JSON Schema.',
    parallel
      ? '- You may put several calls in the list when they do not depend on each other.'
      : '- Put exactly one call in the list.',
    '- Write nothing after the block. The results will come back to you in a message starting with "TOOL RESULT".',
    '- When no tool is needed, answer normally and do not write any tool_calls block.',
  ]
  if (choice.type === 'required') rules.push('- In this reply you must call at least one tool.')
  if (choice.type === 'tool') rules.push(`- In this reply you must call the tool "${choice.name}".`)
  return [
    '[TOOLS]',
    'You can call the following tools. Each line is one tool: its name, what it does, and the JSON Schema of its arguments.',
    catalog,
    '',
    '[HOW TO CALL TOOLS]',
    'To call tools, reply with exactly one fenced code block whose language is tool_calls, containing JSON in this exact shape:',
    '```tool_calls',
    '{"tool_calls": [{"name": "TOOL_NAME", "arguments": {"argument_name": "value"}}]}',
    '```',
    ...rules,
  ].join('\n')
}

/** One-line reminder used when a continuation turn changes the tool choice. */
export function renderToolChoiceReminder(choice: NormalizedToolChoice): string | null {
  if (choice.type === 'required') return 'Reminder: in this reply you must call at least one tool using a tool_calls block.'
  if (choice.type === 'tool') return `Reminder: in this reply you must call the tool "${choice.name}" using a tool_calls block.`
  if (choice.type === 'none') return 'Reminder: do not call any tool in this reply; answer directly.'
  return null
}

function normalizeQuotes(text: string): string {
  return text.replace(/[“”„‟″]/g, '"').replace(/[‘’‚‛′]/g, "'")
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1')
}

/** JSON.parse with the repairs web UIs typically need (smart quotes, trailing commas, a stray `json` line). */
export function parseLenientJson(text: string): unknown {
  let body = text.trim()
  if (/^json\s*\n/i.test(body)) body = body.replace(/^json\s*\n/i, '')
  const attempts = [body, normalizeQuotes(body), removeTrailingCommas(normalizeQuotes(body))]
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch {
      // try the next repair
    }
  }
  return undefined
}

function asCallList(value: unknown, explicit: boolean): unknown[] | null {
  if (Array.isArray(value)) return explicit ? value : null
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const list = record['tool_calls'] ?? record['toolCalls']
    if (Array.isArray(list)) return list
    if (explicit && typeof record['name'] === 'string') return [record]
  }
  return null
}

function normalizeCall(raw: unknown, allowed: ReadonlyMap<string, string>): ParsedToolCall | null {
  if (raw === null || typeof raw !== 'object') return null
  let record = raw as Record<string, unknown>
  // OpenAI-shaped entries: {"type":"function","function":{"name","arguments"}}
  const fn = record['function']
  if (fn !== null && typeof fn === 'object' && typeof (fn as Record<string, unknown>)['name'] === 'string') {
    record = fn as Record<string, unknown>
  }
  const rawName = record['name'] ?? record['tool'] ?? record['tool_name']
  if (typeof rawName !== 'string') return null
  const name = allowed.get(rawName) ?? allowed.get(rawName.toLowerCase())
  if (name === undefined) return null
  let args: unknown = record['arguments'] ?? record['args'] ?? record['input'] ?? record['parameters'] ?? {}
  if (typeof args === 'string') args = args.trim() === '' ? {} : parseLenientJson(args)
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  return { name, arguments: args as Record<string, unknown> }
}

/**
 * Parse the body of a candidate block. `explicit` is true for `tool_calls` fences and tags (then a
 * bare array or single call object is accepted); for `json`/unlabelled fences the `tool_calls` key
 * is required so ordinary JSON answers are never mistaken for calls.
 */
export function parseToolCallPayload(payload: string, allowed: ReadonlyMap<string, string>, explicit: boolean): ParsedToolCall[] | null {
  const value = parseLenientJson(payload)
  if (value === undefined) return null
  const list = asCallList(value, explicit)
  if (list === null) return null
  const calls = list.map((item) => normalizeCall(item, allowed)).filter((call): call is ParsedToolCall => call !== null)
  return calls.length > 0 ? calls : null
}

/** Map of accepted spellings (exact and lower-case) to the declared tool name. */
export function allowedToolNames(tools: readonly NormalizedTool[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const tool of tools) {
    map.set(tool.name, tool.name)
    if (!map.has(tool.name.toLowerCase())) map.set(tool.name.toLowerCase(), tool.name)
  }
  return map
}

type Mode =
  | { readonly kind: 'text' }
  | { readonly kind: 'passthrough'; readonly marker: string }
  | { readonly kind: 'block'; readonly marker: string; readonly explicit: boolean; raw: string; body: string }
  | { readonly kind: 'tag'; raw: string }

function closesFence(line: string, marker: string): boolean {
  const trimmed = line.replace(/\n$/, '')
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(trimmed)
  return match?.[1] !== undefined && match[1][0] === marker[0] && match[1].length >= marker.length
}

/**
 * Incremental parser. `push()` returns the text that is safe to forward to the client now;
 * `end()` flushes everything and returns the remaining text plus all parsed calls.
 */
export class ToolCallStreamParser {
  readonly #allowed: ReadonlyMap<string, string>
  readonly #enabled: boolean
  readonly #calls: ParsedToolCall[] = []
  #buffer = ''
  #atLineStart = true
  #mode: Mode = { kind: 'text' }

  constructor(allowed: ReadonlyMap<string, string>) {
    this.#allowed = allowed
    this.#enabled = allowed.size > 0
  }

  get toolCalls(): readonly ParsedToolCall[] {
    return this.#calls
  }

  push(delta: string): string {
    if (!this.#enabled) return delta
    this.#buffer += delta
    let out = ''
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) {
        out += this.#partialLine()
        break
      }
      const line = this.#buffer.slice(0, newline + 1)
      this.#buffer = this.#buffer.slice(newline + 1)
      out += this.#line(line)
    }
    return out
  }

  end(): { text: string; toolCalls: readonly ParsedToolCall[] } {
    if (!this.#enabled) {
      const rest = this.#buffer
      this.#buffer = ''
      return { text: rest, toolCalls: this.#calls }
    }
    let out = ''
    if (this.#buffer !== '') {
      const rest = this.#buffer
      this.#buffer = ''
      out += this.#line(rest)
    }
    const mode = this.#mode
    this.#mode = { kind: 'text' }
    if (mode.kind === 'block') {
      // Unterminated fence (models and UIs sometimes drop the closing one): try to parse anyway.
      const calls = parseToolCallPayload(mode.body, this.#allowed, mode.explicit)
      if (calls !== null) this.#calls.push(...calls)
      else out += mode.raw
    } else if (mode.kind === 'tag') {
      const calls = parseToolCallPayload(mode.raw.replace(TAG_OPEN, '').replace(TAG_CLOSE, ''), this.#allowed, true)
      if (calls !== null) this.#calls.push(...calls)
      else out += mode.raw
    }
    return { text: out, toolCalls: this.#calls }
  }

  /** Decide whether an incomplete trailing line can be forwarded yet. */
  #partialLine(): string {
    const mode = this.#mode
    if (mode.kind === 'block' || mode.kind === 'tag') return ''
    if (mode.kind === 'passthrough') {
      // A closing fence can only be recognized once the line is complete; text inside code is safe
      // to forward unless it could be that closing fence.
      if (this.#atLineStart && /^ {0,3}[`~]*$/.test(this.#buffer)) return ''
      const text = this.#buffer
      this.#buffer = ''
      this.#atLineStart = false
      return text
    }
    if (this.#atLineStart) {
      const head = this.#buffer.trimStart()
      const couldBeFence = /^ {0,3}(`{1,}|~{1,})/.test(this.#buffer) || head === ''
      const couldBeTag = TAG_OPEN.startsWith(head.slice(0, TAG_OPEN.length)) || head.startsWith(TAG_OPEN)
      if (couldBeFence || couldBeTag) return ''
    }
    const text = this.#buffer
    this.#buffer = ''
    this.#atLineStart = false
    return text
  }

  #line(line: string): string {
    const startedAtLineStart = this.#atLineStart
    this.#atLineStart = line.endsWith('\n')
    const mode = this.#mode
    switch (mode.kind) {
      case 'passthrough':
        if (startedAtLineStart && closesFence(line, mode.marker)) this.#mode = { kind: 'text' }
        return line
      case 'block':
        if (startedAtLineStart && closesFence(line, mode.marker)) {
          this.#mode = { kind: 'text' }
          const calls = parseToolCallPayload(mode.body, this.#allowed, mode.explicit)
          if (calls !== null) {
            this.#calls.push(...calls)
            return ''
          }
          return mode.raw + line
        }
        mode.raw += line
        mode.body += line
        return ''
      case 'tag': {
        mode.raw += line
        const close = mode.raw.indexOf(TAG_CLOSE)
        if (close < 0) return ''
        this.#mode = { kind: 'text' }
        const inner = mode.raw.slice(mode.raw.indexOf(TAG_OPEN) + TAG_OPEN.length, close)
        const after = mode.raw.slice(close + TAG_CLOSE.length)
        const calls = parseToolCallPayload(inner, this.#allowed, true)
        if (calls !== null) {
          this.#calls.push(...calls)
          return after.trim() === '' ? '' : after
        }
        return mode.raw
      }
      case 'text': {
        if (!startedAtLineStart) return line
        const fence = FENCE_OPEN.exec(line)
        if (fence?.[1] !== undefined) {
          const lang = (fence[2] ?? '').toLowerCase()
          if (TOOL_LANGS.has(lang) || lang === 'json' || lang === '') {
            this.#mode = { kind: 'block', marker: fence[1], explicit: TOOL_LANGS.has(lang), raw: line, body: '' }
            return ''
          }
          this.#mode = { kind: 'passthrough', marker: fence[1] }
          return line
        }
        const trimmed = line.trimStart()
        if (trimmed.startsWith(TAG_OPEN)) {
          this.#mode = { kind: 'tag', raw: '' }
          return this.#line(line)
        }
        return line
      }
    }
  }
}

/** Non-streaming convenience: split a complete answer into text and tool calls. */
export function extractToolCalls(text: string, allowed: ReadonlyMap<string, string>): { text: string; toolCalls: readonly ParsedToolCall[] } {
  const parser = new ToolCallStreamParser(allowed)
  const head = parser.push(text)
  const tail = parser.end()
  return { text: (head + tail.text).trim(), toolCalls: tail.toolCalls }
}
