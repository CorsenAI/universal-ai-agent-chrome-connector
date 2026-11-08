import { describe, expect, it } from 'vitest'
import { LIMITS, PROTOCOL_VERSION } from '../src/constants'
import { parseClientFrame, parseServerFrame } from '../src/protocol'

const hex32 = 'a'.repeat(32)
const hex64 = 'b'.repeat(64)

const hello = {
  type: 'hello',
  role: 'browser',
  browserId: 'browser-1',
  browserName: 'Chrome',
  nonce: hex32,
  proof: hex64,
  protocolVersion: PROTOCOL_VERSION,
  extensionVersion: '0.1.0',
  capabilities: ['targets.list'],
  takeover: false,
}

describe('client frames', () => {
  it('accepts a valid hello', () => {
    const parsed = parseClientFrame(JSON.stringify(hello))
    expect(parsed.ok).toBe(true)
  })

  it('refuses unknown fields (strict) and unknown types', () => {
    expect(parseClientFrame(JSON.stringify({ ...hello, extra: 1 })).ok).toBe(false)
    expect(parseClientFrame(JSON.stringify({ type: 'teleport' })).ok).toBe(false)
  })

  it('refuses a daemon-only frame from the client', () => {
    const challenge = { type: 'challenge', nonce: hex32, protocolVersion: 1, daemonVersion: '0.1.0' }
    expect(parseClientFrame(JSON.stringify(challenge)).ok).toBe(false)
    expect(parseServerFrame(JSON.stringify(challenge)).ok).toBe(true)
  })

  it('requires error exactly when ok is false', () => {
    const good = { type: 'rpc_result', id: 'x1', ok: false, error: { code: 'TIMEOUT', message: 't' } }
    expect(parseClientFrame(JSON.stringify(good)).ok).toBe(true)
    expect(parseClientFrame(JSON.stringify({ type: 'rpc_result', id: 'x1', ok: false })).ok).toBe(false)
    expect(parseClientFrame(JSON.stringify({ type: 'rpc_result', id: 'x1', ok: true, error: { code: 'TIMEOUT', message: 't' } })).ok).toBe(false)
  })

  it('reports malformed JSON and oversize frames with distinct codes', () => {
    const bad = parseClientFrame('{nope')
    expect(bad.ok === false && bad.code).toBe('MALFORMED')
    const huge = parseClientFrame('x'.repeat(LIMITS.MAX_FRAME_BYTES + 1))
    expect(huge.ok === false && huge.code).toBe('TOO_LARGE')
  })

  it('validates identifiers and nonces', () => {
    expect(parseClientFrame(JSON.stringify({ ...hello, nonce: 'XYZ' })).ok).toBe(false)
    expect(parseClientFrame(JSON.stringify({ ...hello, browserId: 'bad id with spaces' })).ok).toBe(false)
  })
})
