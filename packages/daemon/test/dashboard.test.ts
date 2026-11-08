import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentConfigurator } from '../src/agent-configurator/configurator'
import { BackupStore } from '../src/agent-configurator/backups'
import { runDaemon, type DaemonHandle } from '../src/daemon/run-daemon'
import { silentLogger } from '../src/util/logger'
import { freePort, tempDir } from './helpers/env'

let home: ReturnType<typeof tempDir>
let daemon: DaemonHandle
let port: number
const base = (): string => `http://127.0.0.1:${port}`

beforeAll(async () => {
  home = tempDir('dashboard')
  port = await freePort()
  const configurator = new AgentConfigurator({
    ctx: { platform: 'linux', home: join(home.path, 'user'), env: { PATH: '' } },
    launch: { command: 'node', args: ['x', 'mcp'], env: {} },
    backups: new BackupStore(join(home.path, 'backups.json')),
    logger: silentLogger,
  })
  daemon = await runDaemon({ port, home: home.path, logger: silentLogger, configurator, writePid: false })
})

afterAll(async () => {
  await daemon?.stop()
  home?.cleanup()
})

async function login(): Promise<string> {
  const code = daemon.ctx.sessions.createLoginCode()
  const response = await fetch(`${base()}/login?code=${code}`, { redirect: 'manual' })
  expect(response.status).toBe(303)
  const cookie = response.headers.get('set-cookie') ?? ''
  expect(cookie).toMatch(/corsen_session=[^;]+; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict/i)
  return cookie.split(';')[0]!
}

describe('dashboard authentication', () => {
  it('shows the login page (without the pairing code) to anonymous visitors', async () => {
    const response = await fetch(`${base()}/`)
    const html = await response.text()
    expect(html).toContain('<form method="post" action="/login">')
    expect(html).not.toContain('corsen-pairing')
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  it('trades a one-time login code for a session cookie, once', async () => {
    const code = daemon.ctx.sessions.createLoginCode()
    const first = await fetch(`${base()}/login?code=${code}`, { redirect: 'manual' })
    expect(first.status).toBe(303)
    const replay = await fetch(`${base()}/login?code=${code}`, { redirect: 'manual' })
    expect(replay.status).toBe(401)
  })

  it('exposes the pairing code meta only on the authenticated page', async () => {
    const cookie = await login()
    const html = await (await fetch(`${base()}/`, { headers: { cookie } })).text()
    expect(html).toMatch(/<meta name="corsen-pairing" content="[A-Z0-9]{4}(-[A-Z0-9]{4}){4}">/)
    expect(html).not.toMatch(/<script>(?!<\/script>)/)
  })

  it('requires the session for the dashboard API', async () => {
    expect((await fetch(`${base()}/api/dashboard/status`)).status).toBe(401)
    const cookie = await login()
    const response = await fetch(`${base()}/api/dashboard/status`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { agents: unknown[]; browser: { connected: boolean } }
    expect(body.agents).toHaveLength(8)
    expect(body.browser.connected).toBe(false)
  })

  it('refuses state-changing calls without same-origin proof (CSRF)', async () => {
    const cookie = await login()
    const noHeader = await fetch(`${base()}/api/dashboard/selftest`, { method: 'POST', headers: { cookie, origin: base(), 'content-type': 'application/json' }, body: '{}' })
    expect(noHeader.status).toBe(403)
    const foreign = await fetch(`${base()}/api/dashboard/selftest`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'x-corsen-dashboard': '1', 'content-type': 'application/json' }, body: '{}' })
    expect(foreign.status).toBe(403)
    const good = await fetch(`${base()}/api/dashboard/selftest`, { method: 'POST', headers: { cookie, origin: base(), 'x-corsen-dashboard': '1', 'content-type': 'application/json' }, body: '{}' })
    expect(good.status).toBe(200)
    const result = (await good.json()) as { ok: boolean; steps: Array<{ ok: boolean }> }
    expect(result.ok).toBe(false) // no browser paired: the self-test reports it honestly
  })

  it('signs in with the API key only from the dashboard origin', async () => {
    const form = new URLSearchParams({ token: daemon.ctx.apiToken })
    const cross = await fetch(`${base()}/login`, { method: 'POST', body: form, headers: { origin: 'https://evil.example' }, redirect: 'manual' })
    expect(cross.status).toBe(403)
    const wrong = await fetch(`${base()}/login`, { method: 'POST', body: new URLSearchParams({ token: 'csk_wrong' }), headers: { origin: base() }, redirect: 'manual' })
    expect(wrong.status).toBe(401)
    const ok = await fetch(`${base()}/login`, { method: 'POST', body: form, headers: { origin: base() }, redirect: 'manual' })
    expect(ok.status).toBe(303)
  })

  it('serves the static assets', async () => {
    const js = await fetch(`${base()}/assets/dashboard.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('javascript')
    expect((await fetch(`${base()}/assets/../credentials.json`)).status).toBe(404)
  })

  it('serves binary assets byte for byte', async () => {
    const response = await fetch(`${base()}/assets/logo.png`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    const served = Buffer.from(await response.arrayBuffer())
    const onDisk = readFileSync(join(import.meta.dirname, '..', 'src', 'web-dashboard', 'static', 'logo.png'))
    expect(served.equals(onDisk)).toBe(true)
  })
})
