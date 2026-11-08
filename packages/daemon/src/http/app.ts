import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { PROTOCOL_VERSION, VERSION } from '@corsen-ai/shared'
import type { DaemonContext } from '../daemon/context'
import { HEALTH_NAME } from '../daemon/lifecycle'
import { registerGatewayRoutes } from '../llm-gateway/routes'
import { createMcpHttpHandler } from '../mcp-server/factory'
import { registerDashboardRoutes } from '../web-dashboard/routes'
import { apiGuard, hostGuard, type GuardOptions } from './guards'

export interface AppHooks {
  /** Called by `POST /api/admin/shutdown` (the `stop` command). */
  readonly onShutdown: () => void
}

/** The daemon's HTTP surface (WebSocket upgrades are handled on the Node server, see server.ts). */
export function createApp(ctx: DaemonContext, hooks: AppHooks): Hono {
  const app = new Hono()
  const guards: GuardOptions = {
    port: ctx.port,
    apiToken: () => ctx.apiToken,
    sessions: ctx.sessions,
    activity: ctx.activity,
    allowedApiOrigins: ctx.allowedApiOrigins,
    extraHosts: ctx.extraAllowedHosts,
  }
  const tooLarge = bodyLimit({ maxSize: 32 * 1024 * 1024, onError: (c) => c.json({ error: { message: 'Request body too large.', type: 'request_too_large' } }, 413) })

  app.use('*', hostGuard(guards))
  app.use('*', async (c, next) => {
    await next()
    c.header('x-content-type-options', 'nosniff')
  })

  app.get('/health', (c) =>
    c.json({ ok: true, name: HEALTH_NAME, version: VERSION, protocolVersion: PROTOCOL_VERSION, port: ctx.port, browserConnected: ctx.hub.connected, pid: process.pid }),
  )

  // OpenAI- and Anthropic-compatible LLM gateway
  app.use('/v1/*', tooLarge, apiGuard(guards))
  registerGatewayRoutes(app, { router: ctx.router, activity: ctx.activity, logger: ctx.logger, startedAt: ctx.startedAt })

  // MCP over Streamable HTTP, both protocol eras, stateless
  const mcp = createMcpHttpHandler(
    (name, args, signal) => ctx.executor.call(name, args, signal),
    (error) => ctx.logger.warn('mcp http error', { error: error.message }),
  )
  app.use('/mcp', tooLarge, apiGuard(guards))
  app.all('/mcp', (c) => mcp.fetch(c.req.raw))

  // Tool calls forwarded by `universal-connector mcp` (stdio proxies)
  app.use('/api/tools/*', tooLarge, apiGuard(guards))
  app.post('/api/tools/call', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; arguments?: unknown } | null
    if (body === null || typeof body.name !== 'string') return c.json({ error: { message: 'expected {name, arguments}' } }, 400)
    return c.json(await ctx.executor.call(body.name, body.arguments ?? {}, c.req.raw.signal))
  })

  // CLI administration
  app.use('/api/admin/*', apiGuard(guards))
  app.post('/api/admin/login-code', (c) => c.json({ url: `${ctx.baseUrl()}/login?code=${ctx.sessions.createLoginCode()}` }))
  app.post('/api/admin/shutdown', (c) => {
    setTimeout(hooks.onShutdown, 50)
    return c.json({ ok: true })
  })

  registerDashboardRoutes(app, ctx, guards)

  app.notFound((c) => c.json({ error: { message: 'Not found', type: 'not_found_error' } }, 404))
  app.onError((error, c) => {
    ctx.logger.error('unhandled request error', { path: c.req.path, error: error.message })
    return c.json({ error: { message: 'Internal error', type: 'api_error' } }, 500)
  })
  return app
}
