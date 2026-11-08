import { describe, expect, it } from 'vitest'
import type Protocol from 'devtools-protocol'
import { parseKeyCombo, selectAllStroke } from '../src/cdp/keys'
import { detectHarness, resolveHarness } from '../src/harnesses/registry'
import { BlockStreamCommitter, stablePrefix } from '../src/harnesses/stream-committer'
import { formatAxTree } from '../src/mcp-executor/ax-tree'
import { RefRegistry } from '../src/mcp-executor/refs'

describe('stream committer (block-safe streaming)', () => {
  it('holds code fences until complete and streams prose up to the last word', () => {
    expect(stablePrefix(['Hello wor'])).toBe('Hello')
    expect(stablePrefix(['Intro.', '```py\nprint(1'])).toBe('Intro.')
    expect(stablePrefix(['- a\n- b'])).toBe('')
  })

  it('emits a consistent prefix over successive snapshots and the exact final text', () => {
    const committer = new BlockStreamCommitter()
    const snapshots = [['Hel'], ['Hello wo'], ['Hello world, this'], ['Hello world, this is it.', '```js\nconst'], ['Hello world, this is it.', '```js\nconst a = 1\n```', 'Done']]
    let streamed = ''
    for (const blocks of snapshots) streamed += committer.update(blocks, false)
    streamed += committer.update(['Hello world, this is it.', '```js\nconst a = 1\n```', 'Done'], true)
    expect(streamed).toBe('Hello world, this is it.\n\n```js\nconst a = 1\n```\n\nDone')
    expect(committer.diverged).toBe(false)
  })

  it('never retracts and flags a divergence', () => {
    const committer = new BlockStreamCommitter()
    committer.update(['First block', 'second'], false)
    expect(committer.update(['Changed block', 'second more'], false)).toBe('')
    expect(committer.diverged).toBe(true)
  })
})

describe('keys', () => {
  it('parses named keys, characters and modifiers', () => {
    expect(parseKeyCombo('Enter', 'other')).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 0 })
    expect(parseKeyCombo('Control+Shift+K', 'other')).toMatchObject({ key: 'K', code: 'KeyK', modifiers: 10 })
    expect(parseKeyCombo('a', 'other')).toMatchObject({ key: 'a', code: 'KeyA', text: 'a' })
    expect(parseKeyCombo('Mod+a', 'mac').modifiers).toBe(4)
    expect(parseKeyCombo('esc', 'other').key).toBe('Escape')
    expect(() => parseKeyCombo('Hyper+x', 'other')).toThrow(/modifier/)
    expect(() => parseKeyCombo('NotAKey', 'other')).toThrow(/unknown key/)
  })

  it('uses Meta+A on macOS and Ctrl+A elsewhere for select-all', () => {
    expect(selectAllStroke('mac').modifiers).toBe(4)
    expect(selectAllStroke('other').modifiers).toBe(2)
    expect(selectAllStroke('other').text).toBeUndefined()
  })
})

describe('harness registry', () => {
  it('detects built-in chats by host and calibrated sites as generic', () => {
    expect(detectHarness('https://chat.deepseek.com/a/chat/s/1', {})).toBe('deepseek')
    expect(detectHarness('https://claude.ai/new', {})).toBe('claude')
    expect(detectHarness('https://chatgpt.com/c/abc', {})).toBe('chatgpt')
    expect(detectHarness('https://gemini.google.com/app', {})).toBe('gemini')
    expect(detectHarness('https://example.com/', {})).toBeNull()
    expect(detectHarness('https://chat.example.com/', { 'chat.example.com': { input: '#in', response: '.msg', updatedAt: 1 } })).toBe('generic')
    expect(detectHarness('https://chat.example.com/', { 'chat.example.com': { input: '#in', updatedAt: 1 } })).toBeNull()
  })

  it('puts the calibration first, then the definition, then generic fallbacks', () => {
    const resolved = resolveHarness('chatgpt', 'https://chatgpt.com/', { 'chatgpt.com': { input: '#mine', updatedAt: 1 } })
    expect(resolved.selectors.input[0]).toBe('#mine')
    expect(resolved.selectors.input).toContain('#prompt-textarea')
    expect(resolved.selectors.input.at(-1)).toBe('div[contenteditable="true"]')
    expect(resolved.calibrated).toBe(true)
    expect(resolved.selectors.exclude.length).toBeGreaterThan(0)
  })
})

describe('refs', () => {
  it('never reuses numbers and keeps AX refs stable per node', () => {
    const refs = new RefRegistry()
    expect(refs.startIndex(1)).toBe(1)
    refs.advanceTo(1, 5)
    expect(refs.axRef(1, 900)).toBe('e5')
    expect(refs.axRef(1, 900)).toBe('e5')
    expect(refs.axRef(1, 901)).toBe('e6')
    expect(refs.startIndex(1)).toBe(7)
    expect(refs.lookup(1, 'e5')).toEqual({ kind: 'ax', backendNodeId: 900 })
    expect(refs.lookup(1, 'e3')).toEqual({ kind: 'dom', index: 3 })
    expect(refs.lookup(1, 'e99')).toBeNull()
    expect(refs.lookup(2, 'e1')).toBeNull()
  })
})

describe('accessibility tree formatter', () => {
  const v = (value: unknown): Protocol.Accessibility.AXValue => ({ type: 'string', value })
  const nodes: Protocol.Accessibility.AXNode[] = [
    { nodeId: '1', ignored: false, role: v('RootWebArea'), name: v('Login'), childIds: ['2', '3', '6'] },
    { nodeId: '2', ignored: false, role: v('heading'), name: v('Sign in'), properties: [{ name: 'level' as never, value: { type: 'integer', value: 1 } }], childIds: ['7'], parentId: '1' },
    { nodeId: '7', ignored: false, role: v('StaticText'), name: v('Sign in'), parentId: '2' },
    { nodeId: '3', ignored: true, role: v('generic'), childIds: ['4', '5'], parentId: '1' },
    { nodeId: '4', ignored: false, role: v('textbox'), name: v('Password'), value: v('hunter2'), backendDOMNodeId: 40, parentId: '3' },
    { nodeId: '5', ignored: false, role: v('button'), name: v('Continue'), properties: [{ name: 'disabled' as never, value: { type: 'boolean', value: true } }], backendDOMNodeId: 50, parentId: '3' },
    { nodeId: '6', ignored: false, role: v('link'), name: v('Forgot?'), backendDOMNodeId: 60, parentId: '1' },
  ]

  it('renders a compact tree with refs, states and masked secrets', () => {
    const refs = new RefRegistry()
    const result = formatAxTree(nodes, (backend) => refs.axRef(7, backend), 10_000)
    expect(result.text).toBe(
      [
        '- page "Login"',
        '  - heading "Sign in" [level=1]',
        '  - textbox "Password" = "••••••••" [ref=e1]',
        '  - button "Continue" (disabled) [ref=e2]',
        '  - link "Forgot?" [ref=e3]',
      ].join('\n'),
    )
    expect(result.refCount).toBe(3)
    expect(result.text).not.toContain('hunter2')
  })

  it('truncates honestly', () => {
    const result = formatAxTree(nodes, () => 'e1', 60)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('truncated')
  })
})
