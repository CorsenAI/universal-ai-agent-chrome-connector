import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROOT, assertNoLocalPaths, chromiumBinary, launchBrowser, startDaemon, startFixtureServer, waitFor, type BrowserHandle, type DaemonProcess } from './helpers'

/**
 * Chrome Web Store images (opt-in: `pnpm store:assets`). Every product pixel is a capture of the
 * built extension and daemon, driven against invented local demo pages: no mock-up, no personal
 * data. Screenshots are 1280x800, laid out the way Chrome shows a page beside its side panel (page
 * 879 px, 1 px divider, panel 400 px), full bleed, RGB without alpha, as the Store asks
 * (developer.chrome.com/docs/webstore/images). Promotional tiles are HTML rendered by the same
 * Chromium at the Store's exact sizes, from the Corsen AI mark (store/brand). Provenance and hashes:
 * store/ASSETS.md.
 *
 * Compositions and tiles are rendered in a second, extension-free browser: while the connector
 * debugs a tab, Chrome's "started debugging this browser" bar shortens the visible area of every
 * tab, and a new tab of the product browser then captures its top rows again at the bottom.
 */
const OUT = join(ROOT, 'store')
const SHOTS = join(OUT, 'screenshots')
const SIZE = { width: 1280, height: 800 }
const PANEL = { width: 400, height: 800 }
const PAGE = { width: SIZE.width - PANEL.width - 1, height: 800 }
const SECRET = 'nw-whsec-4f9a1c'
const MARK = `data:image/png;base64,${readFileSync(join(ROOT, 'store', 'brand', 'corsen-mark.png')).toString('base64')}`

let daemon: DaemonProcess
let browser: BrowserHandle
let renderer: Browser
let fixtures: { base: string; close: () => Promise<void> }
let orders: Page
let readResult = ''

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A product page at its exact size (CDP capture of the clip, independent of the window). */
async function capture(page: Page, size: { width: number; height: number }): Promise<Buffer> {
  const cdp = await browser.context.newCDPSession(page)
  try {
    const shot = (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } })) as { data: string }
    return Buffer.from(shot.data, 'base64')
  } finally {
    await cdp.detach()
  }
}

async function checked(path: string, png: Buffer, size: { width: number; height: number }): Promise<void> {
  expect(png.readUInt32BE(16), `${path} width`).toBe(size.width)
  expect(png.readUInt32BE(20), `${path} height`).toBe(size.height)
  expect(png[25], `${path} must be 24-bit RGB without alpha`).toBe(2)
  // Every image is checked for a repeated band (bottom rows equal to the top rows).
  const probe = await renderer.newPage()
  const band = await probe.evaluate(async (b64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${b64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    if (context === null) return -1
    context.drawImage(image, 0, 0)
    const { width, height } = image
    const pixels = context.getImageData(0, 0, width, height).data
    const rows: number[] = []
    for (let y = 0; y < height; y += 1) {
      let hash = 2166136261
      for (let i = y * width * 4; i < (y + 1) * width * 4; i += 1) hash = Math.imul(hash ^ (pixels[i] ?? 0), 16777619) >>> 0
      rows.push(hash)
    }
    // A band of k >= 20 non-uniform rows at the bottom that equals the top k rows.
    for (let k = 20; k <= Math.floor(height / 3); k += 1) {
      let same = true
      for (let i = 0; i < k && same; i += 1) same = rows[height - k + i] === rows[i]
      if (same && new Set(rows.slice(0, k)).size > 1) return k
    }
    return 0
  }, png.toString('base64'))
  await probe.close()
  expect(band, `${path}: the bottom ${band} rows repeat the top rows (stale capture)`).toBe(0)
  writeFileSync(path, png)
}

async function render(html: string, size: { width: number; height: number }): Promise<Buffer> {
  const page = await renderer.newPage({ viewport: size, deviceScaleFactor: 1 })
  await page.setContent(html)
  await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))
  const png = await page.screenshot({ type: 'png' })
  await page.close()
  return png
}

async function compose(name: string, left: Buffer, panel: Buffer): Promise<void> {
  const src = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`
  const html = `<!doctype html><html><head><style>html,body{margin:0;width:${SIZE.width}px;height:${SIZE.height}px;overflow:hidden;background:#090d16}body{display:flex}img{display:block}i{width:1px;height:${SIZE.height}px;background:#1f2a3d}</style></head><body><img width="${PAGE.width}" height="${PAGE.height}" src="${src(left)}"><i></i><img width="${PANEL.width}" height="${PANEL.height}" src="${src(panel)}"></body></html>`
  await checked(join(SHOTS, name), await render(html, SIZE), SIZE)
}

async function panelView(tab: RegExp | null): Promise<Buffer> {
  const panel = browser.ui
  if (tab !== null) {
    await panel.getByRole('tab', { name: tab }).click()
    await panel.waitForTimeout(500)
  }
  await assertNoLocalPaths(panel, `side panel (${tab?.source ?? 'Quick Connect'})`)
  return capture(panel, PANEL)
}

function tileHtml(width: number, height: number, wide: boolean): string {
  const logo = `<img src="${MARK}" height="${wide ? 300 : 160}" alt="">`
  const name = wide ? 'Universal AI Agent Connector' : 'Universal AI<br>Agent Connector'
  const tagline = wide ? '<p>The tabs you choose, for the AI agents on your computer</p>' : ''
  return `<!doctype html><html><head><style>
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
    body{display:flex;align-items:center;gap:${wide ? 64 : 26}px;padding:0 ${wide ? 120 : 36}px;box-sizing:border-box;
      background:radial-gradient(120% 140% at 0% 0%,#22184a 0%,#0d1322 52%,#090d16 100%);color:#e6edf7;
      font-family:system-ui,"Segoe UI",Ubuntu,Cantarell,sans-serif}
    h1{margin:0;font-size:${wide ? 64 : 30}px;line-height:1.08;font-weight:700;letter-spacing:-0.01em}
    span{display:block;margin-top:${wide ? 18 : 10}px;font-size:${wide ? 28 : 15}px;color:#8b98ad}
    p{margin:${wide ? 26 : 0}px 0 0;font-size:24px;color:#c9d3e3}
  </style></head><body>${logo}<div><h1>${name}</h1><span>by Corsen AI</span>${tagline}</div></body></html>`
}

describe.skipIf(process.env['STORE_ASSETS'] === undefined)('Chrome Web Store images', () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true })
    renderer = await chromium.launch({ executablePath: chromiumBinary(), headless: true })
    fixtures = await startFixtureServer()
    daemon = await startDaemon({ fakeAgents: ['.cursor', '.claude', '.config/Claude', '.config/Code/User/globalStorage/saoudrizwan.claude-dev'] })
    browser = await launchBrowser()
    await browser.send({ type: 'setPairing', code: daemon.pairingSecret, port: daemon.port })
    await waitFor(async () => ((await (await fetch(`http://127.0.0.1:${daemon.port}/health`)).json()) as { browserConnected: boolean }).browserConnected, 15_000, 'paired')

    // An invented operations page on its own host, and a calibrated demo chat.
    const ordersUrl = `${fixtures.base.replace('127.0.0.1', 'northwind.localhost')}/demo-orders.html`
    orders = await browser.context.newPage()
    await orders.setViewportSize(PAGE)
    await orders.goto(ordersUrl)
    const chat = await browser.context.newPage()
    await chat.goto(`${fixtures.base}/demo-chat.html`)
    await browser.ui.evaluate(
      async ({ newChatUrl }) => {
        const bag = await chrome.storage.local.get('settings')
        const settings = bag['settings'] as { harnessOverrides: Record<string, unknown> }
        settings.harnessOverrides['127.0.0.1'] = { input: '#prompt', send: '#send', stop: '#stop', response: 'div.answer', newChatUrl, updatedAt: Date.now() }
        await chrome.storage.local.set({ settings })
      },
      { newChatUrl: `${fixtures.base}/demo-chat.html` },
    )
    await browser.send({ type: 'setRole', tabId: await browser.tabIdOf(ordersUrl), role: 'mcp' })
    await browser.send({ type: 'setRole', tabId: await browser.tabIdOf(`${fixtures.base}/demo-chat.html`), role: 'brain' })
    await orders.reload()
    await orders.waitForTimeout(1_000)

    // Real activity: an agent reads the page, checks its errors and API calls; one LLM request.
    const mcp = new Client({ name: 'store-assets', version: '1.0.0' })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${daemon.apiToken}` } } }))
    await mcp.callTool({ name: 'browser_list_targets', arguments: {} })
    const read = (await mcp.callTool({ name: 'browser_read_page', arguments: { scope: 'main' } })) as { content: Array<{ type: string; text?: string }> }
    readResult = read.content.map((part) => part.text ?? '').join('\n')
    await mcp.callTool({ name: 'browser_get_devtools_errors', arguments: {} })
    await mcp.callTool({ name: 'browser_capture_network_api', arguments: {} })
    await mcp.close()
    await waitFor(async () => {
      const models = (await (await fetch(`http://127.0.0.1:${daemon.port}/v1/models`, { headers: { authorization: `Bearer ${daemon.apiToken}` } })).json()) as { data: Array<{ id: string }> }
      return models.data.some((model) => model.id === 'web-generic')
    }, 5_000, 'brain model')
    await fetch(`http://127.0.0.1:${daemon.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'web-generic', messages: [{ role: 'user', content: 'Which orders are late?' }] }),
    })

    await browser.ui.setViewportSize(PANEL)
    await browser.ui.reload()
    await browser.ui.waitForTimeout(1_200)
  })

  afterAll(async () => {
    await browser?.close()
    await renderer?.close()
    await daemon?.stop()
    await fixtures?.close()
  })

  it('captures three 1280x800 screenshots of the real product', async () => {
    // 1. Pairing and one-click agent setup: the local dashboard beside Quick Connect.
    const login = (await (await fetch(`http://127.0.0.1:${daemon.port}/api/admin/login-code`, { method: 'POST', headers: { authorization: `Bearer ${daemon.apiToken}`, 'content-type': 'application/json' }, body: '{}' })).json()) as { url: string }
    const dashboard = await browser.context.newPage()
    await dashboard.setViewportSize(PAGE)
    await dashboard.emulateMedia({ colorScheme: 'dark' })
    await dashboard.goto(login.url)
    await dashboard.waitForTimeout(1_500)
    await assertNoLocalPaths(dashboard, 'dashboard')
    const dashboardShot = await capture(dashboard, PAGE)
    await compose('01-connect.png', dashboardShot, await panelView(null))

    // 2. Private by default: roles chosen per tab, beside the page an agent may use.
    const ordersShot = await capture(orders, PAGE)
    await compose('02-tab-roles.png', ordersShot, await panelView(/Tabs|Onglets/))

    // 3. What the agent receives (the real tool result, secret masked) beside the live feed.
    expect(readResult).toContain('[ref=e')
    expect(readResult, 'the webhook secret must be masked').not.toContain(SECRET)
    expect(readResult).toContain('"Webhook secret" = "••••••••"')
    const view = `<!doctype html><html><head><style>
      html,body{margin:0;width:${PAGE.width}px;height:${PAGE.height}px;overflow:hidden;background:#0d1322;color:#e6edf7;font-family:system-ui,"Segoe UI",Ubuntu,sans-serif}
      header{padding:22px 28px 14px;border-bottom:1px solid #1f2a3d}
      h1{margin:0;font-size:20px} p{margin:6px 0 0;color:#8b98ad;font-size:13px}
      pre{margin:0;padding:16px 28px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;color:#c9d3e3}
    </style></head><body><header><h1>What your agent receives</h1><p>browser_read_page (scope: main) · Markdown with [ref=eN] handles · secret fields masked in the browser</p></header><pre>${escapeHtml(readResult)}</pre></body></html>`
    await compose('03-agent-view.png', await render(view, PAGE), await panelView(/activity|Activité/i))
  })

  it('renders the promotional tiles', async () => {
    await checked(join(OUT, 'promo-small-440x280.png'), await render(tileHtml(440, 280, false), { width: 440, height: 280 }), { width: 440, height: 280 })
    await checked(join(OUT, 'promo-marquee-1400x560.png'), await render(tileHtml(1400, 560, true), { width: 1400, height: 560 }), { width: 1400, height: 560 })
  })
})
