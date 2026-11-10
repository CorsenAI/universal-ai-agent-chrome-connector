import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Page } from 'playwright'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** The unpacked extension under test: the build, or (EXTENSION_DIR) the files of an unpacked Store zip. */
export const EXTENSION_DIST = process.env['EXTENSION_DIR'] !== undefined && process.env['EXTENSION_DIR'] !== '' ? process.env['EXTENSION_DIR'] : join(ROOT, 'packages', 'extension', 'dist')
export const DAEMON_ENTRY = join(ROOT, 'packages', 'daemon', 'dist', 'index.js')
const FIXTURES = join(ROOT, 'e2e', 'fixtures')

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export async function waitFor<T>(check: () => Promise<T | undefined | null | false>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check().catch(() => undefined)
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/** Static fixture site with the API endpoints the test app calls. */
export async function startFixtureServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const port = await freePort()
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (url.pathname === '/api/items') return json(200, { items: [{ id: 1, name: 'Bolts', token: 'xyz-secret-token' }] })
    if (url.pathname === '/api/broken') return json(500, { error: 'db down', detail: 'connection refused' })
    if (url.pathname === '/graphql') return json(200, { data: { me: { id: 'u1' } } })
    if (url.pathname === '/docs') {
      response.writeHead(200, { 'content-type': 'text/html' })
      return response.end('<h1>Docs</h1>')
    }
    const file = join(FIXTURES, url.pathname.replace(/^\/+/, ''))
    if (!file.startsWith(FIXTURES) || !existsSync(file)) {
      response.writeHead(404)
      return response.end('not found')
    }
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    response.end(readFileSync(file))
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

export interface DaemonProcess {
  readonly port: number
  readonly home: string
  readonly apiToken: string
  readonly pairingSecret: string
  readonly logs: () => string
  stop(): Promise<void>
}

/** The BUILT daemon, as a user would run it, in a temporary home. */
/**
 * Refuse a published image whose page shows a path of this machine (the developer's home or the
 * temporary directory the test homes live in). Screenshots are public: README and Store listing.
 */
export async function assertNoLocalPaths(page: Page, what: string): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText)
  for (const local of [homedir(), tmpdir()]) {
    if (text.includes(local)) throw new Error(`${what} shows a local path (${local}); it must not be published`)
  }
}

/** Environment variables the agent configurator reads to locate config files (see locations.ts). */
export const AGENT_LOCATION_VARIABLES = ['CLAUDE_CONFIG_DIR', 'CLINE_MCP_SETTINGS_PATH'] as const

export async function startDaemon(options: { fakeAgents?: readonly string[] } = {}): Promise<DaemonProcess> {
  if (!existsSync(DAEMON_ENTRY)) throw new Error(`missing ${DAEMON_ENTRY}: run pnpm build first`)
  const port = await freePort()
  const home = mkdtempSync(join(tmpdir(), 'corsen-e2e-home-'))
  // The configurator must never see (or touch) the developer's real agent configs: fake user home.
  const userHome = join(home, 'user')
  mkdirSync(userHome, { recursive: true })
  for (const dir of options.fakeAgents ?? []) mkdirSync(join(userHome, dir), { recursive: true })
  let output = ''
  const env: NodeJS.ProcessEnv = { ...process.env, CORSEN_CONNECTOR_HOME: join(home, 'connector'), HOME: userHome, USERPROFILE: userHome, APPDATA: join(userHome, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(userHome, '.config') }
  // Variables that point agents at config files outside the fake home must not reach the daemon.
  for (const name of AGENT_LOCATION_VARIABLES) delete env[name]
  const child: ChildProcess = spawn(process.execPath, [DAEMON_ENTRY, 'start', '--no-open', '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 15_000, 'daemon health')
  const credentials = JSON.parse(readFileSync(join(home, 'connector', 'credentials.json'), 'utf8')) as { apiToken: string; pairingSecret: string }
  return {
    port,
    home,
    apiToken: credentials.apiToken,
    pairingSecret: credentials.pairingSecret,
    logs: () => output,
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 300))
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** A Chromium build that still accepts --load-extension (official Chrome ignores it since 137). */
export function chromiumBinary(): string {
  if (process.env['CHROME_BINARY'] !== undefined && process.env['CHROME_BINARY'] !== '') return process.env['CHROME_BINARY']
  const bundled = chromium.executablePath()
  if (existsSync(bundled)) return bundled
  const cache = join(homedir(), '.cache', 'ms-playwright')
  const candidates = readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map((name) => join(cache, name, 'chrome-linux64', 'chrome'))
    .filter((path) => existsSync(path))
  const first = candidates[0]
  if (first === undefined) throw new Error('no Chromium found: set CHROME_BINARY or run `npx playwright install chromium`')
  return first
}

export interface BrowserHandle {
  readonly context: BrowserContext
  readonly extensionId: string
  /** An extension page (side panel opened as a tab) used to talk to the service worker like the UI does. */
  readonly ui: Page
  send<T = unknown>(request: Record<string, unknown>): Promise<{ ok: true; result: T } | { ok: false; error: { code: string; message: string } }>
  tabIdOf(urlPrefix: string): Promise<number>
  close(): Promise<void>
}

export async function launchBrowser(): Promise<BrowserHandle> {
  const userData = mkdtempSync(join(tmpdir(), 'corsen-e2e-profile-'))
  const context = await chromium.launchPersistentContext(userData, {
    executablePath: chromiumBinary(),
    headless: process.env['HEADED'] === undefined,
    args: [`--disable-extensions-except=${EXTENSION_DIST}`, `--load-extension=${EXTENSION_DIST}`, '--no-first-run'],
    viewport: { width: 1280, height: 800 },
  })
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }))
  const extensionId = new URL(worker.url()).host
  const ui = await context.newPage()
  await ui.goto(`chrome-extension://${extensionId}/sidepanel.html`)
  const send: BrowserHandle['send'] = (request) => ui.evaluate((req) => chrome.runtime.sendMessage(req), request) as never
  return {
    context,
    extensionId,
    ui,
    send,
    tabIdOf: async (urlPrefix) => {
      const id = await ui.evaluate(async (prefix) => (await chrome.tabs.query({})).find((tab) => (tab.url ?? '').startsWith(prefix))?.id ?? -1, urlPrefix)
      if (id < 0) throw new Error(`no tab with URL ${urlPrefix}`)
      return id
    },
    close: async () => {
      await context.close()
      rmSync(userData, { recursive: true, force: true })
    },
  }
}
