/**
 * Redaction rules applied before page data crosses the extension trust boundary, and again in the
 * daemon (defense in depth). Pure: no DOM, no network. The in-page distiller receives
 * {@link redactionConfig} as a JSON argument and applies the same lists inside the page.
 *
 * Conservative, not perfect: a field the page gives no signal about cannot be detected.
 *
 * Field and URL rules ported from Corsen AI DeepSeek Harness Connector v0.1.0
 * (`extension/src/redact.js`); header and JSON-body rules are new.
 */

/** Fixed width so a masked value never leaks the original length. */
export const MASK = '••••••••'

/** Query-parameter name fragments whose value is a credential (substring match, lowercased). */
export const SECRET_PARAM_FRAGMENTS: readonly string[] = Object.freeze([
  'access_token', 'id_token', 'refresh_token', 'api_key', 'apikey', 'auth', 'bearer', 'credential',
  'jwt', 'otp', 'passwd', 'password', 'private_key', 'secret', 'session', 'sig', 'signature', 'token',
  'code', 'key',
])

/** `autocomplete` values whose field is always masked (the browser's own declaration). */
export const SECRET_AUTOCOMPLETE: readonly string[] = Object.freeze([
  'current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp',
  'cc-exp-month', 'cc-exp-year', 'cc-name', 'cc-given-name', 'cc-family-name', 'cc-type',
])

/** Fragments in a field's name, id, label or placeholder that mark it as secret-bearing. */
export const SECRET_FIELD_FRAGMENTS: readonly string[] = Object.freeze([
  'password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'api-key', 'api_key', 'otp', 'one-time',
  'onetime', 'totp', 'mfa', '2fa', 'verification-code', 'verificationcode', 'security-code',
  'securitycode', 'cvv', 'cvc', 'csc', 'card-number', 'cardnumber', 'creditcard', 'credit-card',
  'iban', 'routing', 'ssn', 'social-security', 'pin',
])

/** Input types whose value is never read. */
export const SECRET_INPUT_TYPES: readonly string[] = Object.freeze(['password', 'hidden'])

/** Header names that always carry credentials. */
export const SECRET_HEADER_NAMES: readonly string[] = Object.freeze([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key',
  'x-auth-token', 'x-csrf-token', 'x-xsrf-token', 'x-amz-security-token', 'x-goog-api-key',
  'x-session-id', 'x-access-token', 'x-refresh-token',
])

/** Header name fragments that mark a credential (substring, lowercased). */
export const SECRET_HEADER_FRAGMENTS: readonly string[] = Object.freeze([
  'token', 'secret', 'auth', 'session', 'cookie', 'password', 'apikey', 'api-key', 'signature', 'credential',
])

/** JSON property name fragments whose values are masked in captured bodies. */
export const SECRET_JSON_KEY_FRAGMENTS: readonly string[] = Object.freeze([
  'password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'api-key', 'authorization',
  'cookie', 'session', 'private_key', 'privatekey', 'otp', 'cvv', 'cvc', 'card_number', 'cardnumber', 'iban', 'ssn',
])

const REPORTABLE_SCHEMES: readonly string[] = Object.freeze([
  'http:', 'https:', 'ftp:', 'ws:', 'wss:', 'file:', 'about:', 'chrome:', 'chrome-extension:', 'edge:',
  'view-source:',
])

export function isSecretParam(name: string): boolean {
  const lowered = String(name ?? '').toLowerCase()
  return SECRET_PARAM_FRAGMENTS.some((fragment) => lowered.includes(fragment))
}

/**
 * Remove credentials from a URL: user info, secret query parameters, secret fragment parameters.
 * Opaque schemes (`javascript:`, `data:`, `blob:` …) are reported as the scheme alone.
 */
export function scrubUrl(raw: string): string {
  const value = String(raw ?? '')
  if (value === '') return ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(value)
    return match ? `${match[1]}:[unparseable URL]` : '[unparseable URL]'
  }
  if (!REPORTABLE_SCHEMES.includes(url.protocol.toLowerCase())) return `${url.protocol}[opaque URL]`
  url.username = ''
  url.password = ''
  for (const name of [...url.searchParams.keys()]) {
    if (isSecretParam(name)) url.searchParams.set(name, MASK)
  }
  if (url.hash.includes('=')) {
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
    let changed = false
    for (const name of [...fragment.keys()]) {
      if (isSecretParam(name)) {
        fragment.set(name, MASK)
        changed = true
      }
    }
    if (changed) url.hash = `#${fragment.toString()}`
  }
  return url.toString()
}

export function isSecretHeader(name: string): boolean {
  const lowered = String(name ?? '').toLowerCase()
  if (SECRET_HEADER_NAMES.includes(lowered)) return true
  return SECRET_HEADER_FRAGMENTS.some((fragment) => lowered.includes(fragment))
}

/** Copy a header map with credential values masked and oversized values cut. */
export function redactHeaders(headers: Readonly<Record<string, unknown>> | undefined, maxValueChars = 2000): Record<string, string> {
  const out: Record<string, string> = {}
  if (headers === undefined || headers === null) return out
  for (const [name, value] of Object.entries(headers)) {
    const text = typeof value === 'string' ? value : String(value)
    out[name] = isSecretHeader(name) ? MASK : text.slice(0, maxValueChars)
  }
  return out
}

function isSecretJsonKey(key: string): boolean {
  const lowered = key.toLowerCase()
  return SECRET_JSON_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment))
}

function maskJsonValue(value: unknown, depth: number): unknown {
  if (depth > 64) return value
  if (Array.isArray(value)) return value.map((item) => maskJsonValue(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretJsonKey(key) && (typeof inner === 'string' || typeof inner === 'number') ? MASK : maskJsonValue(inner, depth + 1)
    }
    return out
  }
  return value
}

/**
 * Mask secret-looking JSON properties in a captured body. Valid JSON is parsed and re-serialized;
 * anything else gets a regex pass over `"key": "value"` pairs. Never throws.
 */
export function redactJsonText(text: string): string {
  if (text === '') return text
  try {
    return JSON.stringify(maskJsonValue(JSON.parse(text), 0))
  } catch {
    return text.replace(/"([^"\\]{1,80})"\s*:\s*"((?:[^"\\]|\\.)*)"/g, (whole, key: string) =>
      isSecretJsonKey(key) ? `"${key}":"${MASK}"` : whole,
    )
  }
}

/** Plain-JSON configuration handed to in-page functions (they cannot import modules). */
export interface RedactionConfig {
  readonly mask: string
  readonly secretParamFragments: readonly string[]
  readonly secretAutocomplete: readonly string[]
  readonly secretFieldFragments: readonly string[]
  readonly secretInputTypes: readonly string[]
}

export function redactionConfig(): RedactionConfig {
  return {
    mask: MASK,
    secretParamFragments: SECRET_PARAM_FRAGMENTS,
    secretAutocomplete: SECRET_AUTOCOMPLETE,
    secretFieldFragments: SECRET_FIELD_FRAGMENTS,
    secretInputTypes: SECRET_INPUT_TYPES,
  }
}
