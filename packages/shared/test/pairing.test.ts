import { describe, expect, it } from 'vitest'
import {
  PAIRING_ALPHABET,
  PAIRING_SECRET_CHARS,
  browserProofMessage,
  daemonProofMessage,
  formatPairingCode,
  normalizePairingCode,
  secretFromRandomBytes,
} from '../src/pairing'

const SAMPLE = 'ACDE' + 'FGHJ' + 'KMNP' + 'QRTU' + 'VWXY'

describe('pairing code', () => {
  it('normalizes case, spaces and dashes to the canonical secret', () => {
    expect(normalizePairingCode(formatPairingCode(SAMPLE).toLowerCase())).toBe(SAMPLE)
    expect(normalizePairingCode(` ${SAMPLE.slice(0, 10)} - ${SAMPLE.slice(10)} `)).toBe(SAMPLE)
  })

  it('rejects wrong lengths and confusable characters', () => {
    expect(normalizePairingCode(SAMPLE.slice(1))).toBe('')
    expect(normalizePairingCode(`${SAMPLE}A`)).toBe('')
    expect(normalizePairingCode(SAMPLE.replace('A', '0'))).toBe('')
    expect(normalizePairingCode(SAMPLE.replace('A', 'O'))).toBe('')
    expect(normalizePairingCode('')).toBe('')
  })

  it('formats as five groups of four', () => {
    expect(formatPairingCode(SAMPLE)).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/)
  })

  it('draws uniformly with rejection sampling and only alphabet symbols', () => {
    let counter = 0
    // Deterministic byte stream covering the full byte range, including rejected values (>= 250).
    const bytes = (count: number) => Uint8Array.from({ length: count }, () => counter++ % 256)
    const secret = secretFromRandomBytes(bytes)
    expect(secret).toHaveLength(PAIRING_SECRET_CHARS)
    for (const char of secret) expect(PAIRING_ALPHABET).toContain(char)
    expect(normalizePairingCode(secret)).toBe(secret)
  })

  it('skips bytes above the rejection limit', () => {
    const rejected = (count: number) => new Uint8Array(count).fill(255)
    let calls = 0
    const mixed = (count: number) => {
      calls += 1
      return calls === 1 ? rejected(count) : new Uint8Array(count).fill(0)
    }
    expect(secretFromRandomBytes(mixed)).toBe(PAIRING_ALPHABET[0]!.repeat(PAIRING_SECRET_CHARS))
    expect(calls).toBe(2)
  })

  it('keeps browser and daemon proof message spaces disjoint', () => {
    expect(browserProofMessage('b1', 'n')).not.toBe(daemonProofMessage('b1', 'n'))
    expect(daemonProofMessage('b1', 'n').startsWith('daemon:')).toBe(true)
  })
})
