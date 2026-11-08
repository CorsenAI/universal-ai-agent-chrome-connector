import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizePairingCode, secretFromRandomBytes } from '@corsen-ai/shared'

/**
 * The daemon's two secrets:
 * - `pairingSecret`: the code the user gives the extension once; both sides prove knowledge of it
 *   with HMAC, it never crosses the wire.
 * - `apiToken`: the bearer token local agents present to the HTTP API and MCP endpoint.
 *
 * Load-or-create pattern ported from Corsen AI DeepSeek Harness Connector v0.1.0
 * (`companion/src/auth.ts`, `loadOrCreateCredentials`).
 */
export interface Credentials {
  readonly pairingSecret: string
  readonly apiToken: string
  readonly createdAt: string
}

const API_TOKEN_PATTERN = /^csk_[A-Za-z0-9_-]{43}$/

export function createApiToken(): string {
  return `csk_${randomBytes(32).toString('base64url')}`
}

export function createPairingSecret(): string {
  return secretFromRandomBytes((count) => randomBytes(count))
}

function parseCredentials(text: string, path: string): Credentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(`credentials file at ${path} is not valid JSON`, { cause })
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error(`credentials file at ${path} is not an object`)
  const record = parsed as Record<string, unknown>
  const pairingSecret = record['pairingSecret']
  const apiToken = record['apiToken']
  if (typeof pairingSecret !== 'string' || normalizePairingCode(pairingSecret) !== pairingSecret) {
    throw new Error(`credentials file at ${path} holds no usable pairing secret`)
  }
  if (typeof apiToken !== 'string' || !API_TOKEN_PATTERN.test(apiToken)) {
    throw new Error(`credentials file at ${path} holds no usable API token`)
  }
  const createdAt = typeof record['createdAt'] === 'string' ? record['createdAt'] : new Date(0).toISOString()
  return { pairingSecret, apiToken, createdAt }
}

function writeCredentials(path: string, credentials: Credentials): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

/**
 * Load the credentials, creating them on first use. An existing but unreadable or malformed file is
 * a hard error rather than a silent re-pair: regenerating would break every paired browser and every
 * configured agent without telling the user why.
 */
export function loadOrCreateCredentials(path: string): Credentials {
  let text: string | undefined
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  if (text !== undefined) return parseCredentials(text, path)
  const credentials: Credentials = {
    pairingSecret: createPairingSecret(),
    apiToken: createApiToken(),
    createdAt: new Date().toISOString(),
  }
  writeCredentials(path, credentials)
  return credentials
}

/** Read existing credentials without creating them (stdio proxy, status). */
export function readCredentials(path: string): Credentials | null {
  try {
    return parseCredentials(readFileSync(path, 'utf8'), path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
}

/** Replace both secrets (explicit user action: `universal-connector token --rotate`). */
export function rotateCredentials(path: string): Credentials {
  const credentials: Credentials = {
    pairingSecret: createPairingSecret(),
    apiToken: createApiToken(),
    createdAt: new Date().toISOString(),
  }
  writeCredentials(path, credentials)
  return credentials
}
