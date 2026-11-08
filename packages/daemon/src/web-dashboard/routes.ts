import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { AgentIdSchema, TabRoleSchema, formatPairingCode, toWireError, type ActivityEntry } from '@corsen-ai/shared'
import { SESSION_COOKIE } from '../auth/dashboard-sessions'
import { secretsMatch } from '../auth/hmac'
import type { DaemonContext } from '../daemon/context'
import { dashboardGuard, dashboardOrigins, hasDashboardSession, type GuardOptions } from '../http/guards'
import { sseResponse } from '../http/streaming'
import { dashboardPage, loginPage } from './page'

const STATIC_FILES: Readonly<Record<string, string>> = {
  'dashboard.js': 'text/javascript; charset=utf-8',
  'dashboard.css': 'text/css; charset=utf-8',
  'logo.png': 'image/png',
}

/** `dist/web` once bundled, `src/web-dashboard/static` when running from source (tests). */
export function resolveStaticDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(here, 'web'), join(here, 'static'), join(here, '..', 'web-dashboard', 'static'), join(here, '..', 'src', 'web-dashboard', 'static')]
  return candidates.find((dir) => existsSync(join(dir, 'dashboard.js'))) ?? candidates[0] ?? here
}

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
}

export function registerDashboardRoutes(app: Hono, ctx: DaemonContext, guards: GuardOptions): void {
  const staticDir = resolveStaticDir()
  // Static files are served as bytes: text and images alike (a UTF-8 round trip corrupts a PNG).
  const cache = new Map<string, ArrayBuffer>()
  const cookieOptions = { httpOnly: true, sameSite: 'Strict' as const, path: '/', maxAge: 12 * 60 * 60 }

  app.get('/assets/:file', (c) => {
    const file = c.req.param('file')
    const type = STATIC_FILES[file]
    if (type === undefined) return c.notFound()
    let body = cache.get(file)
    if (body === undefined) {
      try {
        const bytes = readFileSync(join(staticDir, file))
        body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        cache.set(file, body)
      } catch {
        return c.notFound()
      }
    }
    return c.body(body, 200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
  })

  app.get('/', (c) => {
    if (!hasDashboardSession(c, ctx.sessions)) return c.html(loginPage({}), 200, PAGE_HEADERS)
    return c.html(dashboardPage({ pairingSecret: ctx.pairingSecret, port: ctx.port }), 200, PAGE_HEADERS)
  })

  app.get('/login', (c) => {
    const code = c.req.query('code') ?? ''
    const session = code === '' ? null : ctx.sessions.redeemLoginCode(code)
    if (session === null) return c.html(loginPage({ error: code === '' ? undefined : 'This login link was already used or has expired.' }), 401, PAGE_HEADERS)
    setCookie(c, SESSION_COOKIE, session, cookieOptions)
    return c.redirect('/', 303)
  })

  app.post('/login', async (c) => {
    if (!dashboardOrigins(ctx.port).has(c.req.header('origin') ?? '')) return c.html(loginPage({ error: 'Sign in from the dashboard page itself.' }), 403, PAGE_HEADERS)
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    const token = typeof form['token'] === 'string' ? form['token'].trim() : ''
    if (!secretsMatch(token, ctx.apiToken)) {
      ctx.activity.note('security', 'Dashboard sign-in refused', 'error')
      return c.html(loginPage({ error: 'Wrong API key.' }), 401, PAGE_HEADERS)
    }
    setCookie(c, SESSION_COOKIE, ctx.sessions.createSession(), cookieOptions)
    return c.redirect('/', 303)
  })

  app.use('/api/dashboard/*', dashboardGuard(guards))

  app.get('/api/dashboard/status', (c) =>
    c.json({
      version: ctx.info().version,
      port: ctx.port,
      browser: ctx.hub.summary(),
      state: ctx.hub.state(),
      pairingCode: formatPairingCode(ctx.pairingSecret),
      apiToken: ctx.apiToken,
      endpoints: { openai: `${ctx.baseUrl()}/v1`, anthropic: ctx.baseUrl(), mcp: `${ctx.baseUrl()}/mcp` },
      models: ctx.router.listModels(),
      totals: ctx.activity.totals(),
      agents: ctx.configurator.list(),
    }),
  )

  app.get('/api/dashboard/activity', (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100) || 100))
    return c.json({ entries: ctx.activity.recent(limit), totals: ctx.activity.totals() })
  })

  app.post('/api/dashboard/agents/:id/:action', async (c) => {
    const id = AgentIdSchema.safeParse(c.req.param('id'))
    const action = c.req.param('action')
    if (!id.success || !['connect', 'unlink', 'restore'].includes(action)) return c.json({ error: { message: 'unknown agent or action' } }, 400)
    const finish = ctx.activity.start({ kind: 'agent', title: `${action} ${id.data}` })
    try {
      const result =
        action === 'connect' ? await ctx.configurator.connect(id.data) : action === 'unlink' ? await ctx.configurator.unlink(id.data) : await ctx.configurator.restore(id.data)
      finish({ status: 'ok', detail: result.message })
      return c.json(result)
    } catch (error) {
      finish({ status: 'error', detail: (error as Error).message })
      return c.json({ error: { message: (error as Error).message } }, 500)
    }
  })

  app.post('/api/dashboard/tabs/:tabId/role', async (c) => {
    const tabId = Number(c.req.param('tabId'))
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown }
    const role = TabRoleSchema.safeParse(body.role)
    if (!Number.isSafeInteger(tabId) || tabId < 0 || !role.success) return c.json({ error: { message: 'invalid tab or role' } }, 400)
    try {
      return c.json(await ctx.hub.call('tabs.setRole', { tabId, role: role.data }, { timeoutMs: 15_000 }))
    } catch (error) {
      const wire = toWireError(error)
      return c.json({ error: wire }, 502)
    }
  })

  app.post('/api/dashboard/panic', async (c) => {
    try {
      const result = await ctx.hub.call('system.panic', {}, { timeoutMs: 10_000 })
      ctx.activity.note('security', 'Panic stop', 'ok', `${result.detached} debugger session(s) detached`)
      return c.json(result)
    } catch (error) {
      return c.json({ error: toWireError(error) }, 502)
    }
  })

  app.post('/api/dashboard/selftest', async (c) => c.json(await ctx.selftest()))

  app.post('/api/dashboard/logout', (c) => {
    const id = getCookie(c, SESSION_COOKIE)
    if (id !== undefined) ctx.sessions.revokeSession(id)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/api/dashboard/events', (c) =>
    sseResponse(
      async (emit, signal) => {
        const send = (event: string, data: unknown): void => emit(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        send('hello', { totals: ctx.activity.totals() })
        const offActivity = ctx.activity.subscribe((entry: ActivityEntry, totals) => send('activity', { entry, totals }))
        const offHub = ctx.hub.on(() => send('state', { browser: ctx.hub.summary(), state: ctx.hub.state(), models: ctx.router.listModels() }))
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        offActivity()
        offHub()
      },
      { keepAlive: () => ': keep-alive\n\n', requestSignal: c.req.raw.signal },
    ),
  )
}
