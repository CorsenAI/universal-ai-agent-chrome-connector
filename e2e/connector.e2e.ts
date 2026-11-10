import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { EXTENSION_DIST, launchBrowser, startDaemon, startFixtureServer, waitFor, type BrowserHandle, type DaemonProcess } from './helpers'

/**
 * End to end, for real: the BUILT daemon (CLI) + the BUILT extension loaded unpacked in Chromium,
 * a fixture web app and a fixture web chat. Nothing is mocked between the agent-facing APIs (MCP,
 * OpenAI, Anthropic) and the page.
 */
let daemon: DaemonProcess
let browser: BrowserHandle
let fixtures: { base: string; close: () => Promise<void> }
let mcp: Client
let app: Page
let chat: Page
let appTabId = -1
let chatTabId = -1

type ToolText = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }
const text = (result: ToolText): string => result.content.map((part) => part.text ?? '').join('\n')

async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolText> {
  return (await mcp.callTool({ name, arguments: args })) as ToolText
}

function refOf(markdown: string, pattern: RegExp): string {
  const match = pattern.exec(markdown)
  if (match?.[1] === undefined) throw new Error(`no ref matching ${pattern} in:\n${markdown}`)
  return match[1]
}

beforeAll(async () => {
  fixtures = await startFixtureServer()
  daemon = await startDaemon()
  browser = await launchBrowser()
  const paired = await browser.send({ type: 'setPairing', code: daemon.pairingSecret, port: daemon.port })
  expect(paired.ok).toBe(true)
  await waitFor(async () => ((await (await fetch(`http://127.0.0.1:${daemon.port}/health`)).json()) as { browserConnected: boolean }).browserConnected, 15_000, 'browser paired')
  mcp = new Client({ name: 'e2e', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${daemon.apiToken}` } } }))
})

afterAll(async () => {
  await mcp?.close().catch(() => undefined)
  await browser?.close()
  await daemon?.stop()
  await fixtures?.close()
})

describe('packaged extension hygiene', () => {
  it('ships no eval-capable code, no remote script and a valid MV3 manifest', () => {
    const files = [join(EXTENSION_DIST, 'background.js'), ...readdirSync(join(EXTENSION_DIST, 'assets')).filter((name) => name.endsWith('.js')).map((name) => join(EXTENSION_DIST, 'assets', name))]
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
      expect(code, file).not.toMatch(/new\s+Function\s*\(|\beval\s*\(/)
      expect(code, file).not.toMatch(/<script[^>]+src=["']https?:/i)
    }
    const manifest = JSON.parse(readFileSync(join(EXTENSION_DIST, 'manifest.json'), 'utf8')) as { manifest_version: number; permissions: string[]; host_permissions?: string[]; content_scripts?: unknown; content_security_policy: { extension_pages: string } }
    expect(manifest.manifest_version).toBe(3)
    // Extension pages load images only from the package or inline (no request to any website).
    expect(manifest.content_security_policy.extension_pages).toContain("img-src 'self' data:;")
    // Every bundled third-party package ships its license notice.
    const notices = readFileSync(join(EXTENSION_DIST, 'THIRD_PARTY_LICENSES.txt'), 'utf8')
    for (const name of ['react', 'react-dom', 'scheduler', 'zod', 'lucide-react']) expect(notices).toMatch(new RegExp(`^${name} \\S+ — (MIT|ISC)$`, 'm'))
    expect(manifest.permissions.sort()).toEqual(['activeTab', 'alarms', 'debugger', 'scripting', 'sidePanel', 'storage', 'tabs'])
    expect(manifest.host_permissions).toBeUndefined()
    expect(manifest.content_scripts).toBeUndefined()
  })
})

describe('pairing', () => {
  it('pairs through the real HMAC handshake and reports the browser', async () => {
    const state = await browser.send<{ link: { status: string } }>({ type: 'getState' })
    expect(state.ok && state.result.link.status).toBe('connected')
  })

  it('refuses a wrong pairing code shape', async () => {
    const result = await browser.send({ type: 'setPairing', code: 'not-a-code' })
    expect(result.ok).toBe(false)
  })
})

describe('The Hands — MCP tools on a real page', () => {
  beforeAll(async () => {
    app = await browser.context.newPage()
    await app.goto(`${fixtures.base}/app.html`)
    await app.waitForTimeout(800) // let the fixture fire its console error and API calls after attach
    appTabId = await browser.tabIdOf(`${fixtures.base}/app.html`)
  })

  it('keeps an ignored tab private (no target, fail closed)', async () => {
    const listed = await tool('browser_list_targets')
    expect(text(listed)).toContain('No tab is exposed')
    const read = await tool('browser_read_page')
    expect(read.isError).toBe(true)
    expect(text(read)).toMatch(/^NO_TARGET/)
  })

  it('exposes the tab after an explicit role change', async () => {
    const result = await browser.send({ type: 'setRole', tabId: appTabId, role: 'mcp' })
    expect(result.ok).toBe(true)
    await app.reload()
    await app.waitForTimeout(1_000)
    const listed = text(await tool('browser_list_targets'))
    expect(listed).toContain(`target_id ${appTabId}`)
    expect(listed).toContain('Fixture App')
  })

  it('reads the page as clean Markdown with refs, secrets masked and hidden text skipped', async () => {
    const page = text(await tool('browser_read_page'))
    expect(page).toContain('# Inventory dashboard')
    expect(page).toMatch(/\[button "Increment"\] \[ref=e\d+\]/)
    expect(page).toContain('| Item | Qty |')
    expect(page).toContain('••••••••')
    expect(page).not.toContain('hunter2')
    expect(page).not.toContain('SECRET123')
    expect(page).not.toContain('Hidden secret text')
  })

  it('clicks with trusted input (the page ignores synthetic clicks)', async () => {
    const page = text(await tool('browser_read_page'))
    const ref = refOf(page, /\[button "Increment"\] \[ref=(e\d+)\]/)
    const result = await tool('browser_act', { action: 'click', ref })
    expect(result.isError).not.toBe(true)
    await waitFor(async () => (await app.textContent('#count')) === 'Count: 1', 5_000, 'counter incremented')
    expect(text(await tool('browser_read_page'))).toContain('Count: 1')
  })

  it('types and selects through refs', async () => {
    const page = text(await tool('browser_read_page'))
    const email = refOf(page, /\[textbox type=email "Email"[^\]]*\] \[ref=(e\d+)\]/)
    const plan = refOf(page, /\[select "Plan"[^\]]*\] \[ref=(e\d+)\]/)
    expect((await tool('browser_act', { action: 'type', ref: email, text: 'ada@example.com' })).isError).not.toBe(true)
    expect((await tool('browser_act', { action: 'select', ref: plan, value: 'Pro' })).isError).not.toBe(true)
    expect(await app.inputValue('#email')).toBe('ada@example.com')
    expect(await app.inputValue('#plan')).toBe('pro')
  })

  it('fails with STALE_REF on a ref it never issued', async () => {
    const result = await tool('browser_act', { action: 'click', ref: 'e99999' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^STALE_REF/)
  })

  it('feeds DevTools errors: console, exception and HTTP 500 with redacted body', async () => {
    const feed = text(await waitFor(async () => {
      const result = await tool('browser_get_devtools_errors')
      return text(result).includes('Unhandled boom') && text(result).includes('db down') ? result : undefined
    }, 10_000, 'devtools entries'))
    expect(feed).toContain('Boot failed: missing FEATURE_FLAG')
    expect(feed).toContain('Unhandled boom')
    expect(feed).toContain('HTTP 500')
    expect(feed).toContain('db down')
    expect(feed).not.toContain('p4ss')
  })

  it('captures JSON and GraphQL API calls with credentials masked', async () => {
    const capture = text(await tool('browser_capture_network_api'))
    expect(capture).toContain('/api/items')
    expect(capture).toContain('[graphql Viewer]')
    expect(capture).not.toContain('xyz-secret-token')
  })

  it('reads the accessibility tree with refs', async () => {
    const tree = text(await tool('browser_read_page', { mode: 'accessibility' }))
    expect(tree).toMatch(/button "Increment".*\[ref=e\d+\]/)
  })

  it('takes a WebP screenshot', async () => {
    await app.bringToFront()
    const shot = await tool('browser_screenshot', { format: 'webp' })
    const image = shot.content.find((part) => part.type === 'image')
    expect(image?.mimeType).toBe('image/webp')
    const bytes = Buffer.from(image?.data ?? '', 'base64')
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP')
  })
})

describe('The Brain — a web chat as an OpenAI/Anthropic API', () => {
  beforeAll(async () => {
    chat = await browser.context.newPage()
    await chat.goto(`${fixtures.base}/chat.html`)
    chatTabId = await browser.tabIdOf(`${fixtures.base}/chat.html`)
  })

  async function calibrate(kind: string, selector: string): Promise<string> {
    const pending = browser.send<{ selector: string }>({ type: 'calibrate', tabId: chatTabId, kind })
    await chat.waitForSelector('[data-corsen-picker]', { state: 'attached', timeout: 10_000 })
    await chat.click(selector)
    const result = await pending
    if (!result.ok) throw new Error(result.error.message)
    return result.result.selector
  }

  it('calibrates an unknown chat with the visual picker (real clicks)', async () => {
    expect(await calibrate('input', '#prompt')).toBe('#prompt')
    expect(await calibrate('send', '#send')).toBe('#send')
    // An answer must exist to be picked: produce one by hand.
    await chat.fill('#prompt', 'warm up')
    await chat.click('#send')
    await chat.waitForSelector('.answer p', { timeout: 5_000 })
    await chat.waitForFunction(() => !document.body.classList.contains('streaming'), undefined, { timeout: 10_000 })
    const answer = await calibrate('response', '.answer p')
    expect(await chat.locator(answer).count()).toBeGreaterThan(0)
    // Seed the two settings a picker cannot click here (hidden stop button, new-chat URL).
    await browser.ui.evaluate(
      async ({ host, newChatUrl }) => {
        const bag = await chrome.storage.local.get('settings')
        const settings = bag['settings'] as { harnessOverrides: Record<string, Record<string, unknown>> }
        settings.harnessOverrides[host] = { ...settings.harnessOverrides[host], stop: '#stop', newChatUrl, updatedAt: Date.now() }
        await chrome.storage.local.set({ settings })
      },
      { host: '127.0.0.1', newChatUrl: `${fixtures.base}/chat.html` },
    )
    const role = await browser.send({ type: 'setRole', tabId: chatTabId, role: 'brain' })
    expect(role.ok).toBe(true)
  })

  it('lists the calibrated brain as a model (state pushed to the daemon)', async () => {
    const ids = await waitFor(async () => {
      const models = (await (await fetch(`http://127.0.0.1:${daemon.port}/v1/models`, { headers: { authorization: `Bearer ${daemon.apiToken}` } })).json()) as { data: Array<{ id: string }> }
      const list = models.data.map((model) => model.id)
      return list.includes('web-generic') ? list : undefined
    }, 5_000, 'web-generic model')
    expect(ids).toEqual(['web-auto', 'web-generic'])
  })

  it('streams an OpenAI chat completion typed into the page and read back as Markdown', async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'web-generic', stream: true, messages: [{ role: 'user', content: 'Hello there' }] }),
    })
    const body = await response.text()
    const chunks = body
      .split('\n\n')
      .filter((block) => block.startsWith('data: {'))
      .map((block) => JSON.parse(block.slice(6)) as { choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }> })
    const content = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')
    expect(content).toContain('You sent 11 characters.')
    expect(content).toContain('```js\nconst answer = 42\n```')
    expect(content).toContain('Anything else?')
    // The code block's header row (label + "Copy code" button) is chrome, not answer.
    expect(content).not.toMatch(/Copy|javascript/)
    expect(chunks.filter((chunk) => (chunk.choices[0]?.delta?.content ?? '') !== '').length).toBeGreaterThan(1)
    expect(chunks.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe('stop')
  })

  it('turns the chat answer into OpenAI tool_calls through the tool shim', async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'web-generic',
        messages: [{ role: 'user', content: 'Weather in Paris?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      }),
    })
    const body = (await response.json()) as { choices: Array<{ message: { content: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }> }
    expect(body.choices[0]?.finish_reason).toBe('tool_calls')
    // The block sits under a banner with "Copy" / "Download" controls and no <code>: the JSON must
    // come back intact and the banner must not leak into the text.
    expect(body.choices[0]?.message.tool_calls?.[0]?.function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' })
    expect(body.choices[0]?.message.content ?? '').not.toMatch(/Copy|Download|tool_calls/)
  })

  it('answers an Anthropic Messages request', async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': daemon.apiToken, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'web-generic', max_tokens: 512, messages: [{ role: 'user', content: 'Hi' }] }),
    })
    const body = (await response.json()) as { content: Array<{ type: string; text?: string }>; stop_reason: string }
    expect(body.content[0]?.text).toContain('You sent 2 characters.')
    expect(body.stop_reason).toBe('end_turn')
  })

  it('fails fast, with the reason, when the chat finished but no response selector matched', async () => {
    const setResponseSelector = (selector: string): Promise<void> =>
      browser.ui.evaluate(
        async ({ host, selector }) => {
          const bag = await chrome.storage.local.get('settings')
          const settings = bag['settings'] as { harnessOverrides: Record<string, Record<string, unknown>> }
          settings.harnessOverrides[host] = { ...settings.harnessOverrides[host], response: selector, updatedAt: Date.now() }
          await chrome.storage.local.set({ settings })
        },
        { host: '127.0.0.1', selector },
      )
    const original = await browser.ui.evaluate(async (host) => {
      const bag = await chrome.storage.local.get('settings')
      const settings = bag['settings'] as { harnessOverrides: Record<string, { response?: string }> }
      return settings.harnessOverrides[host]?.response ?? ''
    }, '127.0.0.1')
    expect(original).not.toBe('')
    await setResponseSelector('.no-such-answer')
    try {
      const started = Date.now()
      const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'web-generic', messages: [{ role: 'user', content: 'Hello again' }] }),
      })
      const body = (await response.json()) as { error?: { code?: string; message?: string } }
      expect(response.ok).toBe(false)
      expect(body.error?.code).toBe('HARNESS_FAILED')
      expect(body.error?.message).toContain('no response element matched')
      // The stop control of the fixture disappears within seconds; the driver must not wait for the deadline.
      expect(Date.now() - started).toBeLessThan(20_000)
    } finally {
      await setResponseSelector(original)
    }
  })

  it('recovers the answer when the chat replaces its document on the first message', async () => {
    // Many chat sites open a conversation URL on the first message: the document, and with it the
    // isolated world the probe runs in, is replaced while the answer streams. The fixture also opens
    // both documents with an assistant greeting, which must not be taken for the reply.
    const setNewChatUrl = (url: string): Promise<void> =>
      browser.ui.evaluate(
        async ({ host, url }) => {
          const bag = await chrome.storage.local.get('settings')
          const settings = bag['settings'] as { harnessOverrides: Record<string, Record<string, unknown>> }
          settings.harnessOverrides[host] = { ...settings.harnessOverrides[host], newChatUrl: url, updatedAt: Date.now() }
          await chrome.storage.local.set({ settings })
        },
        { host: '127.0.0.1', url },
      )
    await setNewChatUrl(`${fixtures.base}/chat.html?nav=1`)
    try {
      const started = Date.now()
      const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'web-generic', stream: true, messages: [{ role: 'user', content: 'Navigate please' }] }),
      })
      const chunks = (await response.text())
        .split('\n\n')
        .filter((block) => block.startsWith('data: {'))
        .map((block) => JSON.parse(block.slice(6)) as { choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>; error?: { message: string } })
      const content = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('')
      const outcome = {
        error: chunks.find((chunk) => chunk.error !== undefined)?.error?.message ?? null,
        finish: chunks.find((chunk) => chunk.choices?.[0]?.finish_reason)?.choices[0]?.finish_reason ?? null,
        content,
      }
      expect(outcome).toEqual({ error: null, finish: 'stop', content: expect.stringContaining('You sent 15 characters.') })
      expect(content).toContain('```js\nconst answer = 42\n```')
      expect(content).toContain('Anything else?')
      expect(content).not.toContain('Hello! Ask me anything.')
      expect(Date.now() - started).toBeLessThan(30_000)
      const url = await browser.ui.evaluate(async (id) => (await chrome.tabs.get(id)).url ?? '', chatTabId)
      expect(url).toMatch(/\/chat\.html\?nav=1&c=\d+$/)
    } finally {
      await setNewChatUrl(`${fixtures.base}/chat.html`)
    }
  })
})

describe('Panic stop', () => {
  it('detaches every debugger session and makes every tab private again', async () => {
    const result = await browser.send<{ detached: number }>({ type: 'panic' })
    expect(result.ok && result.result.detached).toBeGreaterThanOrEqual(2)
    expect(text(await tool('browser_list_targets'))).toContain('No tab is exposed')
  })
})
