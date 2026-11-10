import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { ROOT, assertNoLocalPaths, launchBrowser, startDaemon, startFixtureServer, waitFor, type BrowserHandle, type DaemonProcess } from './helpers'

/**
 * Real-product screenshots (opt-in: `pnpm screenshots`). Everything shown is produced by the built
 * daemon and extension against local fixture pages: no mock-ups, no personal data.
 */
const OUT = join(ROOT, 'docs', 'assets')
let daemon: DaemonProcess
let browser: BrowserHandle
let fixtures: { base: string; close: () => Promise<void> }

describe.skipIf(process.env['CAPTURE'] === undefined)('screenshots', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true })
    fixtures = await startFixtureServer()
    daemon = await startDaemon({ fakeAgents: ['.cursor', '.claude', '.config/Claude', '.config/Code/User/globalStorage/saoudrizwan.claude-dev'] })
    browser = await launchBrowser()
    await browser.send({ type: 'setPairing', code: daemon.pairingSecret, port: daemon.port })
    await waitFor(async () => ((await (await fetch(`http://127.0.0.1:${daemon.port}/health`)).json()) as { browserConnected: boolean }).browserConnected, 15_000, 'paired')
    const app = await browser.context.newPage()
    await app.goto(`${fixtures.base}/app.html`)
    const chat = await browser.context.newPage()
    await chat.goto(`${fixtures.base}/chat.html`)
    await browser.ui.evaluate(
      async ({ newChatUrl }) => {
        const bag = await chrome.storage.local.get('settings')
        const settings = bag['settings'] as { harnessOverrides: Record<string, unknown> }
        settings.harnessOverrides['127.0.0.1'] = { input: '#prompt', send: '#send', stop: '#stop', response: 'div.answer', newChatUrl, updatedAt: Date.now() }
        await chrome.storage.local.set({ settings })
      },
      { newChatUrl: `${fixtures.base}/chat.html` },
    )
    await browser.send({ type: 'setRole', tabId: await browser.tabIdOf(`${fixtures.base}/app.html`), role: 'mcp' })
    await browser.send({ type: 'setRole', tabId: await browser.tabIdOf(`${fixtures.base}/chat.html`), role: 'brain' })
    await app.reload()
    await app.waitForTimeout(1_000)
    // Real activity for the feed: MCP calls and one LLM request.
    const mcp = new Client({ name: 'capture', version: '1.0.0' })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${daemon.apiToken}` } } }))
    await mcp.callTool({ name: 'browser_list_targets', arguments: {} })
    await mcp.callTool({ name: 'browser_read_page', arguments: {} })
    await mcp.callTool({ name: 'browser_get_devtools_errors', arguments: {} })
    await mcp.close()
    await waitFor(async () => {
      const models = (await (await fetch(`http://127.0.0.1:${daemon.port}/v1/models`, { headers: { authorization: `Bearer ${daemon.apiToken}` } })).json()) as { data: Array<{ id: string }> }
      return models.data.some((model) => model.id === 'web-generic')
    }, 5_000, 'brain model')
    await fetch(`http://127.0.0.1:${daemon.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'web-generic', messages: [{ role: 'user', content: 'Hello from Cursor' }] }),
    })
  })

  afterAll(async () => {
    await browser?.close()
    await daemon?.stop()
    await fixtures?.close()
  })

  it('captures the side panel views and the dashboard', async () => {
    const panel = browser.ui
    await panel.setViewportSize({ width: 420, height: 860 })
    await panel.reload()
    await panel.waitForTimeout(1_200)
    await assertNoLocalPaths(panel, 'side panel (Quick Connect)')
    await panel.screenshot({ path: join(OUT, 'sidepanel-quick-connect.png') })
    await panel.getByRole('tab', { name: /Tabs|Onglets/ }).click()
    await panel.waitForTimeout(400)
    await assertNoLocalPaths(panel, 'side panel (Tabs)')
    await panel.screenshot({ path: join(OUT, 'sidepanel-tabs.png') })
    await panel.getByRole('tab', { name: /activity|Activité/i }).click()
    await panel.waitForTimeout(400)
    await assertNoLocalPaths(panel, 'side panel (activity)')
    await panel.screenshot({ path: join(OUT, 'sidepanel-activity.png') })

    const login = (await (await fetch(`http://127.0.0.1:${daemon.port}/api/admin/login-code`, { method: 'POST', headers: { authorization: `Bearer ${daemon.apiToken}`, 'content-type': 'application/json' }, body: '{}' })).json()) as { url: string }
    const dashboard = await browser.context.newPage()
    await dashboard.setViewportSize({ width: 1280, height: 900 })
    await dashboard.emulateMedia({ colorScheme: 'dark' })
    await dashboard.goto(login.url)
    await dashboard.waitForTimeout(1_500)
    await assertNoLocalPaths(dashboard, 'dashboard')
    await dashboard.screenshot({ path: join(OUT, 'dashboard.png'), fullPage: true })
  })
})
