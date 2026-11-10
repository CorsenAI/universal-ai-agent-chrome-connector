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

/** `scheme://…` up to a space, quote, bracket or parenthesis: an address written in free text. */
const ADDRESS_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()[\]{}]+/gi

/** One address found in text: rewritten by {@link scrubUrl} only when that changes something. */
function scrubAddress(address: string): string {
  let parsed: URL
  try {
    parsed = new URL(address)
  } catch {
    return address
  }
  const scrubbed = scrubUrl(address)
  return scrubbed === parsed.toString() ? address : scrubbed
}

/**
 * Scrub the addresses written in free text (console messages, log lines, Markdown link targets).
 * An address without credentials is kept byte for byte, and so is the text around it.
 */
export function scrubAddressesInText(text: string): string {
  return text.replace(ADDRESS_IN_TEXT, scrubAddress)
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

/** True when parsed JSON holds a secret-named property whose value is not masked yet. */
function hasUnmaskedSecret(value: unknown, depth: number): boolean {
  if (depth > 64) return false
  if (Array.isArray(value)) return value.some((item) => hasUnmaskedSecret(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, inner]) =>
      isSecretJsonKey(key) && (typeof inner === 'string' || typeof inner === 'number') ? inner !== MASK : hasUnmaskedSecret(inner, depth + 1),
    )
  }
  return false
}

/** Regex pass over `"key": "value"` pairs, for text that is not valid JSON (a cut body, JSON lines). */
function maskJsonPairs(text: string): string {
  return text.replace(/"([^"\\]{1,80})"\s*:\s*"((?:[^"\\]|\\.)*)"/g, (whole, key: string) =>
    isSecretJsonKey(key) ? `"${key}":"${MASK}"` : whole,
  )
}

/**
 * Mask secret-looking JSON properties in a captured body. Valid JSON is re-serialized only when a
 * value has to change: `JSON.parse` turns every number into a double, so re-serializing a body with
 * nothing to mask would round integers above 2^53 (MDN, JSON.parse). Such a body keeps its exact
 * text, still passed through the regex pass (it catches a secret repeated under a duplicate key).
 * Anything that is not valid JSON gets the regex pass alone. Never throws.
 */
export function redactJsonText(text: string): string {
  if (text === '') return text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return maskJsonPairs(text)
  }
  return hasUnmaskedSecret(parsed, 0) ? JSON.stringify(maskJsonValue(parsed, 0)) : maskJsonPairs(text)
}

/**
 * Mask the secret parameters of an `application/x-www-form-urlencoded` body with the address rules
 * ({@link isSecretParam}); every other byte stays as captured. Names are decoded by the URL standard's
 * form parser, so `pass%77ord` and `pass+word` are recognized like in an address.
 */
function maskFormText(text: string): string {
  return text
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=')
      if (separator === -1) return pair
      const rawName = pair.slice(0, separator)
      const name = new URLSearchParams(rawName).keys().next().value ?? ''
      return isSecretParam(name) ? `${rawName}=${MASK}` : pair
    })
    .join('&')
}

const FORM_TYPE = 'application/x-www-form-urlencoded'
/** `name=value(&name=value)*` without spaces: a form body sent without its content type. */
const FORM_SHAPE = /^[^\s&=]+=[^\s&]*(?:&[^\s&=]+=[^\s&]*)*$/

/**
 * Mask a captured request or response body: form bodies by the address rules, everything else by
 * the JSON rules. `contentType` is the request's `Content-Type` or the response's MIME type; without
 * one, a body shaped like a form is treated as a form. Never throws.
 */
export function redactBodyText(text: string, contentType = ''): string {
  if (text === '') return text
  const type = contentType.toLowerCase()
  if (type.includes(FORM_TYPE) || (type === '' && FORM_SHAPE.test(text))) return maskFormText(text)
  return redactJsonText(text)
}

/** A header's value in a captured header map, whatever the case of its name. */
export function headerValue(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value
  return undefined
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
