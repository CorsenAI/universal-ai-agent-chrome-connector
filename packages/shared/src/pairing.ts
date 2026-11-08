/**
 * Pairing code shape, shared by the daemon (which generates it) and the extension (which normalizes
 * what the user pasted). Generation and HMAC live on each side with its own crypto API.
 *
 * Ported from Corsen AI DeepSeek Harness Connector v0.1.0 (`companion/src/auth.ts`), itself ported
 * from Corsen AI Hermes Connector v0.2.4: same alphabet, same length, same normalization.
 */

export const PAIRING_CODE_GROUPS = 5
export const PAIRING_CODE_GROUP_CHARS = 4
export const PAIRING_SECRET_CHARS = PAIRING_CODE_GROUPS * PAIRING_CODE_GROUP_CHARS

/**
 * Digits and uppercase letters minus the pairs people confuse when reading a code off a screen:
 * `0`/`O`, `1`/`I`/`L`, `8`/`B`, `S`/`5`, `2`/`Z`. 25 symbols, 20 characters ≈ 93 bits.
 */
export const PAIRING_ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY'

const SECRET_PATTERN = new RegExp(`^[${PAIRING_ALPHABET}]{${PAIRING_SECRET_CHARS}}$`)

/** Reduce whatever the user typed (case, spaces, dashes) to the canonical secret, or `''`. */
export function normalizePairingCode(entered: string): string {
  const normalized = String(entered ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  return SECRET_PATTERN.test(normalized) ? normalized : ''
}

/** Display form: five hyphen-separated groups of four. Presentation only. */
export function formatPairingCode(secret: string): string {
  const groups: string[] = []
  for (let index = 0; index < secret.length; index += PAIRING_CODE_GROUP_CHARS) {
    groups.push(secret.slice(index, index + PAIRING_CODE_GROUP_CHARS))
  }
  return groups.join('-')
}

/**
 * Turn random bytes into a uniform secret by rejection sampling (a plain modulo would bias the
 * first symbols). The caller supplies a byte source so this stays pure and testable.
 */
export function secretFromRandomBytes(nextBytes: (count: number) => Uint8Array): string {
  const limit = Math.floor(256 / PAIRING_ALPHABET.length) * PAIRING_ALPHABET.length
  let secret = ''
  while (secret.length < PAIRING_SECRET_CHARS) {
    for (const byte of nextBytes(PAIRING_SECRET_CHARS)) {
      if (byte >= limit) continue
      secret += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]
      if (secret.length === PAIRING_SECRET_CHARS) break
    }
  }
  return secret
}

/** Message signed by the extension (role-bound, single-use through the daemon's nonce). */
export function browserProofMessage(browserId: string, serverNonce: string): string {
  return `browser:${browserId}:${serverNonce}`
}

/** Message signed by the daemon in return; the prefix keeps the two message spaces disjoint. */
export function daemonProofMessage(browserId: string, clientNonce: string): string {
  return `daemon:browser:${browserId}:${clientNonce}`
}
