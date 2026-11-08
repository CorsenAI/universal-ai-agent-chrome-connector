import { describe, expect, it } from 'vitest'
import { MASK, isSecretHeader, redactHeaders, redactJsonText, scrubUrl } from '../src/redact'

describe('scrubUrl', () => {
  it('masks secret query and fragment parameters and user info', () => {
    const out = scrubUrl('https://user:pw@example.com/cb?access_token=abc&page=2#id_token=xyz&state=1')
    expect(out).not.toContain('abc')
    expect(out).not.toContain('xyz')
    expect(out).not.toContain('user:pw')
    expect(out).toContain('page=2')
    expect(out).toContain(encodeURIComponent(MASK))
  })

  it('reports opaque schemes as the scheme alone', () => {
    expect(scrubUrl('javascript:alert(document.cookie)')).toBe('javascript:[opaque URL]')
    expect(scrubUrl('data:text/html,<b>x</b>')).toBe('data:[opaque URL]')
  })

  it('handles unparseable input without throwing', () => {
    expect(scrubUrl('not a url')).toBe('[unparseable URL]')
    expect(scrubUrl('')).toBe('')
  })
})

describe('redactHeaders', () => {
  it('masks credential headers and keeps the rest', () => {
    const out = redactHeaders({ Authorization: 'Bearer s3cret', Cookie: 'sid=1', 'Content-Type': 'application/json', 'X-CSRF-Token': 't' })
    expect(out['Authorization']).toBe(MASK)
    expect(out['Cookie']).toBe(MASK)
    expect(out['X-CSRF-Token']).toBe(MASK)
    expect(out['Content-Type']).toBe('application/json')
  })

  it('classifies headers by name and fragment', () => {
    expect(isSecretHeader('set-cookie')).toBe(true)
    expect(isSecretHeader('X-Upstream-Session')).toBe(true)
    expect(isSecretHeader('accept')).toBe(false)
  })
})

describe('redactJsonText', () => {
  it('masks secret keys in valid JSON, recursively', () => {
    const out = JSON.parse(redactJsonText(JSON.stringify({ user: 'a', password: 'p', nested: { access_token: 't', list: [{ apiKey: 'k' }] } })))
    expect(out.user).toBe('a')
    expect(out.password).toBe(MASK)
    expect(out.nested.access_token).toBe(MASK)
    expect(out.nested.list[0].apiKey).toBe(MASK)
  })

  it('falls back to a regex pass on invalid JSON', () => {
    const out = redactJsonText('{"password": "p", "name": "n", ')
    expect(out).toContain(`"password":"${MASK}"`)
    expect(out).toContain('"name": "n"')
  })
})
