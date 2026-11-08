import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { ActivityLog } from '../activity/activity-log'
import { SESSION_COOKIE, type DashboardSessions } from '../auth/dashboard-sessions'
import { secretsMatch } from '../auth/hmac'

/**
 * Request guards. Loopback is not a trust boundary: every web page in the user's browser can send
 * requests to 127.0.0.1, and a DNS-rebinding page can even make them look same-origin.
 *
 * - Host must be the loopback address and port we serve (defeats DNS rebinding).
 * - API routes refuse any request carrying a browser Origin (defeats CSRF from web pages) and require
 *   the API token as `Authorization: Bearer` or `x-api-key`.
 * - POST bodies must be `application/json`, which a cross-site page cannot send without a CORS
 *   preflight that we never answer.
 * - Dashboard routes require the session cookie, and state-changing calls must come from the
 *   dashboard's own origin with the `X-Corsen-Dashboard` header.
 */

export interface GuardOptions {
  readonly port: number
  readonly apiToken: () => string
  readonly sessions: DashboardSessions
  readonly activity: ActivityLog
  /** Extra browser origins explicitly allowed on API routes (`--allow-origin`), empty by default. */
  readonly allowedApiOrigins: readonly string[]
  /** Extra Host values explicitly allowed (`--allow-host`, e.g. a tunnel hostname), empty by default. */
  readonly extraHosts: readonly string[]
}

export function allowedHosts(port: number, extra: readonly string[] = []): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...extra.map((host) => host.toLowerCase())])
}

export function dashboardOrigins(port: number): ReadonlySet<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
}

function deny(c: Context, status: 401 | 403 | 415, type: string, message: string): Response {
  return c.json({ error: { message, type, code: type } }, status)
}

export function hostGuard(options: GuardOptions): MiddlewareHandler {
  const hosts = allowedHosts(options.port, options.extraHosts)
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase()
    if (!hosts.has(host)) {
      options.activity.note('security', 'Refused request with a foreign Host header', 'error', host.slice(0, 200) || 'no Host')
      return deny(c, 403, 'forbidden_host', 'This server only answers requests addressed to 127.0.0.1 or localhost.')
    }
    await next()
    return undefined
  }
}

export function extractApiToken(c: Context): string {
  const authorization = c.req.header('authorization') ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim()
  if (bearer !== undefined && bearer !== '') return bearer
  return (c.req.header('x-api-key') ?? '').trim()
}

export function apiGuard(options: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    if (origin !== undefined && !options.allowedApiOrigins.includes(origin)) {
      options.activity.note('security', 'Refused API call from a web page', 'error', origin.slice(0, 200))
      return deny(c, 403, 'forbidden_origin', 'Requests from web pages are refused. Call this API from a local program.')
    }
    if (!secretsMatch(extractApiToken(c), options.apiToken())) {
      return deny(c, 401, 'authentication_error', 'Missing or invalid API key. Use the token shown by `universal-connector token` or in the dashboard.')
    }
    if (c.req.method === 'POST') {
      const type = (c.req.header('content-type') ?? '').toLowerCase()
      if (!type.includes('application/json')) return deny(c, 415, 'unsupported_media_type', 'Send the request body as application/json.')
    }
    await next()
    return undefined
  }
}

export function hasDashboardSession(c: Context, sessions: DashboardSessions): boolean {
  return sessions.isValidSession(getCookie(c, SESSION_COOKIE))
}

export function dashboardGuard(options: GuardOptions): MiddlewareHandler {
  const origins = dashboardOrigins(options.port)
  return async (c, next) => {
    if (!hasDashboardSession(c, options.sessions)) return deny(c, 401, 'authentication_error', 'Dashboard session expired. Run `universal-connector dashboard` to open a new one.')
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin') ?? ''
      if (!origins.has(origin) || c.req.header('x-corsen-dashboard') !== '1') {
        options.activity.note('security', 'Refused dashboard call without same-origin proof', 'error', origin.slice(0, 200) || 'no Origin')
        return deny(c, 403, 'forbidden_origin', 'Dashboard actions must come from the dashboard itself.')
      }
    }
    await next()
    return undefined
  }
}
