import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { AgentConfigurator } from '../src/agent-configurator/configurator'
import { BackupStore } from '../src/agent-configurator/backups'
import { readCredentials } from '../src/auth/credentials'
import { connectorPaths } from '../src/config/paths'
import { runDaemon, type DaemonHandle } from '../src/daemon/run-daemon'
import { silentLogger } from '../src/util/logger'
import { FakeExtension, tab } from './helpers/fake-extension'
import { freePort, tempDir, waitFor } from './helpers/env'

let home: ReturnType<typeof tempDir>
let daemon: DaemonHandle
let port: number
let token: string
let secret: string
let extension: FakeExtension

const base = (): string => `http://127.0.0.1:${port}`
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

/** Simulated web chat: answers prompts by streaming deltas, like the real harness does. */
let nextAnswer = 'Hello from the web chat!'
let lastPrompt = ''
let lastNewChat = false

beforeAll(async () => {
  home = tempDir('integration')
  port = await freePort()
  const configurator = new AgentConfigurator({
    ctx: { platform: 'linux', home: join(home.path, 'user'), env: { PATH: '' } },
    launch: { command: 'node', args: ['x', 'mcp'], env: {} },
    backups: new BackupStore(join(home.path, 'backups.json')),
    logger: silentLogger,
  })
  daemon = await runDaemon({ port, home: home.path, logger: silentLogger, configurator, writePid: false })
  const credentials = readCredentials(connectorPaths(home.path).credentials)!
  token = credentials.apiToken
  secret = credentials.pairingSecret
  extension = new FakeExtension({
    port,
    secret,
    handler: async (method, params, io) => {
      switch (method) {
        case 'targets.list':
          return { targets: [{ targetId: '7', title: 'My App', url: 'http://localhost:3000/', consoleErrors: 2, networkErrors: 1, active: true }] }
        case 'page.read':
          return { title: 'My App', url: 'http://localhost:3000/', mode: params.mode, content: '# Hello\n[Sign in](/login) [ref=e1]', refCount: 1, truncated: false, sourceChars: 40_000, outputChars: 36 }
        case 'page.act':
          return { summary: `Clicked ${params.act.ref}`, url: 'http://localhost:3000/', title: 'My App', navigated: false }
        case 'llm.generate': {
          lastPrompt = params.prompt
          lastNewChat = params.newChat
          io.event({ kind: 'status', status: 'generating' })
          const words = nextAnswer.match(/[\s\S]{1,7}/g) ?? []
          let sent = ''
          for (const word of words) {
            if (io.cancelled()) return { text: sent, finishReason: 'cancelled', url: 'https://chat.example/c/1' }
            sent += word
            io.event({ kind: 'delta', text: word })
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          return { text: nextAnswer, finishReason: 'stop', url: 'https://chat.example/c/1' }
        }
        case 'system.echo':
          return { nonce: params.nonce, extensionVersion: '0.1.0' }
        default:
          throw Object.assign(new Error(`unexpected ${method}`), { code: 'UNSUPPORTED' })
      }
    },
  })
  expect(await extension.ready).toBe('paired')
  extension.pushState({
    tabs: [tab({ tabId: 7, role: 'mcp', title: 'My App', url: 'http://localhost:3000/', consoleErrors: 2, networkErrors: 1 }), tab({ tabId: 9, role: 'brain', harnessId: 'deepseek', url: 'https://chat.example/c/1' })],
  })
  await waitFor(() => daemon.ctx.hub.state()?.tabs.length === 2, 5_000, 'browser state')
})

afterAll(async () => {
  extension?.close()
  await daemon?.stop()
  home?.cleanup()
})

describe('extension link security', () => {
  it('refuses a wrong pairing secret with UNAUTHENTICATED', async () => {
    const intruder = new FakeExtension({ port, secret: 'ACDEFGHJKMNPQRTUVWXY', browserId: 'intruder' })
    expect(await intruder.ready).toBe('denied')
    expect(intruder.frames.some((frame) => frame.type === 'denied' && frame.code === 'UNAUTHENTICATED')).toBe(true)
  })

  it('refuses a different protocol version, naming the reason', async () => {
    const old = new FakeExtension({ port, secret, browserId: 'old', protocolVersion: 0 })
    expect(await old.ready).toBe('denied')
    const denied = old.frames.find((frame) => frame.type === 'denied')
    expect(denied?.type === 'denied' && denied.code).toBe('PROTOCOL_VERSION')
  })

  it('refuses WebSocket upgrades from web pages', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example' })
    const outcome = await new Promise<string>((resolve) => {
      socket.on('unexpected-response', (_request, response) => resolve(String(response.statusCode)))
      socket.on('open', () => resolve('open'))
      socket.on('error', () => resolve('error'))
    })
    expect(outcome).toBe('403')
  })
})

describe('OpenAI-compatible endpoint', () => {
  it('lists the brains as models', async () => {
    const body = (await (await fetch(`${base()}/v1/models`, { headers: auth() })).json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual(['web-auto', 'web-deepseek'])
  })

  it('answers a non-streaming completion', async () => {
    nextAnswer = 'Plain answer.'
    const response = await fetch(`${base()}/v1/chat/completions`, { method: 'POST', headers: auth(), body: JSON.stringify({ model: 'web-deepseek', messages: [{ role: 'user', content: 'Hi' }] }) })
    const body = (await response.json()) as any
    expect(response.status).toBe(200)
    expect(body.choices[0].message.content).toBe('Plain answer.')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(lastPrompt).toBe('Hi')
    expect(lastNewChat).toBe(true)
  })

  it('continues the same web conversation with only the new turn', async () => {
    nextAnswer = 'Second.'
    await fetch(`${base()}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ model: 'web-deepseek', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Plain answer.' }, { role: 'user', content: 'And then?' }] }),
    })
    expect(lastNewChat).toBe(false)
    expect(lastPrompt).toBe('And then?')
  })

  it('streams SSE chunks and turns a tool_calls block into tool_calls', async () => {
    nextAnswer = 'Checking now.\n```tool_calls\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}\n```'
    const response = await fetch(`${base()}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        model: 'deepseek-chat',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'Weather in Paris?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      }),
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    const chunks = text
      .split('\n\n')
      .filter((block) => block.startsWith('data: {'))
      .map((block) => JSON.parse(block.slice(6)))
    const content = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')
    expect(content.trim()).toBe('Checking now.')
    expect(content).not.toContain('tool_calls')
    const call = chunks.find((chunk) => chunk.choices[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0]
    expect(call.function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' })
    expect(chunks.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls')
    expect(chunks.at(-1).usage.total_tokens).toBeGreaterThan(0)
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(lastPrompt).toContain('[TOOLS]')
  })

  it('cancels the web generation when the client disconnects', async () => {
    nextAnswer = 'x'.repeat(4_000)
    const controller = new AbortController()
    const response = await fetch(`${base()}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ model: 'web-auto', stream: true, messages: [{ role: 'user', content: 'long' }] }),
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await waitFor(() => extension.cancelled.size > 0, 5_000, 'rpc_cancel')
  })

  it('reports NO_BRAIN for an explicit model without a matching tab', async () => {
    const response = await fetch(`${base()}/v1/chat/completions`, { method: 'POST', headers: auth(), body: JSON.stringify({ model: 'web-gemini', messages: [{ role: 'user', content: 'Hi' }] }) })
    expect(response.status).toBe(503)
    expect(((await response.json()) as any).error.code).toBe('NO_BRAIN')
  })
})

describe('Anthropic-compatible endpoint', () => {
  it('streams the documented event sequence with a tool_use block', async () => {
    nextAnswer = 'Let me look.\n```tool_calls\n{"tool_calls":[{"name":"read_file","arguments":{"path":"a.ts"}}]}\n```'
    const response = await fetch(`${base()}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'Open a.ts' }], tools: [{ name: 'read_file', input_schema: { type: 'object' } }] }),
    })
    const text = await response.text()
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((match) => match[1]).filter((name) => name !== 'ping')
    expect(events[0]).toBe('message_start')
    expect(events.at(-1)).toBe('message_stop')
    expect(events).toContain('content_block_delta')
    expect(text).toContain('"type":"tool_use"')
    expect(text).toContain('"stop_reason":"tool_use"')
  })

  it('counts tokens', async () => {
    const response = await fetch(`${base()}/v1/messages/count_tokens`, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'Hello world' }] }) })
    expect(((await response.json()) as any).input_tokens).toBeGreaterThan(0)
  })
})

describe('MCP over Streamable HTTP (official client)', () => {
  for (const mode of ['legacy', 'auto'] as const) {
    it(`serves a ${mode === 'legacy' ? '2025-era (initialize)' : '2026-07-28 (stateless)'} client`, async () => {
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { versionNegotiation: { mode } })
      const transport = new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } })
      await client.connect(transport)
      // Prove which protocol revision was really negotiated (no silent fallback).
      if (mode === 'legacy') {
        expect(client.getProtocolEra()).toBe('legacy')
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25')
      } else {
        expect(client.getProtocolEra()).toBe('modern')
        expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
      }
      expect(client.getServerVersion()?.name).toBe('corsen-browser')
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual([
        'browser_list_targets',
        'browser_read_page',
        'browser_act',
        'browser_get_devtools_errors',
        'browser_capture_network_api',
        'browser_screenshot',
      ])
      const targets = await client.callTool({ name: 'browser_list_targets', arguments: {} })
      expect(JSON.stringify(targets.content)).toContain('target_id 7')
      const page = await client.callTool({ name: 'browser_read_page', arguments: {} })
      expect(JSON.stringify(page.content)).toContain('[ref=e1]')
      const act = await client.callTool({ name: 'browser_act', arguments: { action: 'click', ref: 'e1' } })
      expect(JSON.stringify(act.content)).toContain('Clicked e1')
      await client.close()
    })
  }

  it('refuses MCP calls without the API key', async () => {
    const response = await fetch(`${base()}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
    expect(response.status).toBe(401)
  })

  it('fails closed on a tab that is not exposed', async () => {
    const response = await fetch(`${base()}/api/tools/call`, { method: 'POST', headers: auth(), body: JSON.stringify({ name: 'browser_read_page', arguments: { target_id: '9' } }) })
    const body = (await response.json()) as { isError?: boolean; content: Array<{ text: string }> }
    expect(body.isError).toBe(true)
    expect(body.content[0]?.text).toMatch(/^NO_TARGET/)
  })

  it('records token savings in the activity totals', () => {
    expect(daemon.ctx.activity.totals().tokensSaved).toBeGreaterThan(9_000)
    expect(daemon.ctx.activity.totals().mcpCalls).toBeGreaterThan(0)
  })
})

describe('extension-initiated requests', () => {
  it('runs the bridge self-test and lists agents', async () => {
    const result = await extension.call('daemon.selftest', {})
    expect(result.type === 'rpc_result' && result.ok).toBe(true)
    const agents = await extension.call('agents.list', {})
    expect(agents.type === 'rpc_result' && (agents.result as { agents: unknown[] }).agents).toHaveLength(8)
  })

  it('refuses unknown methods and bad params without crashing', async () => {
    const unknown = await extension.call('daemon.format', {})
    expect(unknown.type === 'rpc_result' && unknown.error?.code).toBe('UNSUPPORTED')
    const bad = await extension.call('agents.connect', { agentId: 'notepad' })
    expect(bad.type === 'rpc_result' && bad.error?.code).toBe('INVALID_ARGUMENT')
  })
})

describe('one active browser', () => {
  it('supersedes the previous browser when another one pairs', async () => {
    const second = new FakeExtension({ port, secret, browserId: 'second', handler: () => ({}) })
    expect(await second.ready).toBe('paired')
    await waitFor(() => extension.closeCode !== null, 5_000, 'first browser closed')
    expect(extension.closeCode).toBe(4001)
    second.close()
  })
})
