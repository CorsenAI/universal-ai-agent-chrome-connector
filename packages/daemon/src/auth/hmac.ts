import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { browserProofMessage, daemonProofMessage } from '@corsen-ai/shared'

/**
 * Role-bound mutual authentication over loopback (the handshake of Corsen AI's Hermes Connector and DeepSeek Harness Connector).
 * The role is part of the signed message, so a proof can only be used for the role it was made for,
 * and each side's nonce makes the other side's proof single-use.
 *
 * Ported from Corsen AI DeepSeek Harness Connector v0.1.0 (`companion/src/auth.ts`).
 */

export function createNonce(): string {
  return randomBytes(16).toString('hex')
}

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex')
}

/** The proof the extension must present for `serverNonce`. */
export function expectedBrowserProof(secret: string, browserId: string, serverNonce: string): string {
  return hmacHex(secret, browserProofMessage(browserId, serverNonce))
}

/** The proof the daemon returns so the extension knows it is talking to the real daemon. */
export function daemonProof(secret: string, browserId: string, clientNonce: string): string {
  return hmacHex(secret, daemonProofMessage(browserId, clientNonce))
}

/** Constant-time string comparison (lengths are not secret: every proof has the same length). */
export function secretsMatch(left: string, right: string): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
