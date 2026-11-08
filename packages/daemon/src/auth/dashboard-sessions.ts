import { randomBytes } from 'node:crypto'
import { secretsMatch } from './hmac'

/**
 * Dashboard authentication: the CLI mints a one-time login code and opens
 * `/login?code=…`; the daemon trades it for an `HttpOnly; SameSite=Strict` session cookie, so the
 * URL left in browser history only holds a spent code. Everything is in memory: a daemon restart
 * simply asks for a new link (`universal-connector dashboard`).
 */
export const SESSION_COOKIE = 'corsen_session'

const LOGIN_CODE_TTL_MS = 10 * 60_000
const SESSION_TTL_MS = 12 * 60 * 60_000
const MAX_LOGIN_CODES = 32
const MAX_SESSIONS = 64

export class DashboardSessions {
  readonly #loginCodes = new Map<string, number>()
  readonly #sessions = new Map<string, number>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Mint a single-use login code valid for ten minutes. */
  createLoginCode(): string {
    this.#prune()
    if (this.#loginCodes.size >= MAX_LOGIN_CODES) {
      const oldest = this.#loginCodes.keys().next().value
      if (oldest !== undefined) this.#loginCodes.delete(oldest)
    }
    const code = randomBytes(24).toString('base64url')
    this.#loginCodes.set(code, this.#now() + LOGIN_CODE_TTL_MS)
    return code
  }

  /** Consume a login code; returns a new session id or null. */
  redeemLoginCode(code: string): string | null {
    this.#prune()
    let matched: string | undefined
    for (const candidate of this.#loginCodes.keys()) {
      if (secretsMatch(candidate, code)) matched = candidate
    }
    if (matched === undefined) return null
    this.#loginCodes.delete(matched)
    return this.createSession()
  }

  createSession(): string {
    this.#prune()
    if (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value
      if (oldest !== undefined) this.#sessions.delete(oldest)
    }
    const id = randomBytes(32).toString('base64url')
    this.#sessions.set(id, this.#now() + SESSION_TTL_MS)
    return id
  }

  isValidSession(id: string | undefined): boolean {
    if (id === undefined || id === '') return false
    this.#prune()
    for (const candidate of this.#sessions.keys()) {
      if (secretsMatch(candidate, id)) return true
    }
    return false
  }

  revokeSession(id: string): void {
    this.#sessions.delete(id)
  }

  revokeAll(): void {
    this.#sessions.clear()
    this.#loginCodes.clear()
  }

  #prune(): void {
    const now = this.#now()
    for (const [code, expires] of this.#loginCodes) if (expires <= now) this.#loginCodes.delete(code)
    for (const [id, expires] of this.#sessions) if (expires <= now) this.#sessions.delete(id)
  }
}
