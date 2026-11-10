import { describe, expect, it } from 'vitest'
import { MASK, headerValue, isSecretHeader, redactBodyText, redactHeaders, redactJsonText, scrubAddressesInText, scrubUrl } from '../src/redact'

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

describe('redactJsonText keeps what it does not mask', () => {
  it('returns a body with nothing to mask byte for byte, large integers included', () => {
    const body = '{ "id": 12345678901234567890, "price": 1.50, "name": "x" }'
    expect(redactJsonText(body)).toBe(body)
  })

  it('re-serializes only a body that has something to mask, and is idempotent', () => {
    const once = redactJsonText('{"user": "a", "token": "t0k", "otp": 123456}')
    expect(JSON.parse(once)).toEqual({ user: 'a', token: MASK, otp: MASK })
    expect(redactJsonText(once)).toBe(once)
  })

  it('masks a secret repeated under a duplicate key', () => {
    expect(redactJsonText(`{"token":"leaked","token":"${MASK}"}`)).not.toContain('leaked')
  })
})

describe('redactBodyText', () => {
  it('masks the secret parameters of a form body and keeps every other byte', () => {
    const body = 'username=ann%40example.com&password=hunter2&remember=1'
    expect(redactBodyText(body, 'application/x-www-form-urlencoded; charset=UTF-8')).toBe(`username=ann%40example.com&password=${MASK}&remember=1`)
  })

  it('decodes parameter names like the URL standard does', () => {
    const out = redactBodyText('pass%77ord=a&client+secret=b&page=2', 'application/x-www-form-urlencoded')
    expect(out).toBe(`pass%77ord=${MASK}&client+secret=${MASK}&page=2`)
  })

  it('treats a form-shaped body without a content type as a form', () => {
    const out = redactBodyText('grant_type=authorization_code&code=abc&code_verifier=xyz', '')
    expect(out).toBe(`grant_type=authorization_code&code=${MASK}&code_verifier=${MASK}`)
  })

  it('is idempotent on forms and leaves JSON to the JSON rules', () => {
    const once = redactBodyText('password=hunter2&x=1', 'application/x-www-form-urlencoded')
    expect(redactBodyText(once, 'application/x-www-form-urlencoded')).toBe(once)
    expect(JSON.parse(redactBodyText('{"password":"p"}', 'application/json'))).toEqual({ password: MASK })
    expect(redactBodyText('plain text, password=hunter2 inside', '')).toBe('plain text, password=hunter2 inside')
  })
})

describe('scrubAddressesInText', () => {
  it('masks credentials in addresses written in text and keeps the rest byte for byte', () => {
    const out = scrubAddressesInText('GET https://api.example.com/v1/items?token=abc&page=2 failed (401)')
    expect(out).not.toContain('abc')
    expect(out.startsWith('GET https://api.example.com/v1/items?token=')).toBe(true)
    expect(out.endsWith('&page=2 failed (401)')).toBe(true)
    expect(scrubAddressesInText('see https://user:pw@example.com/x')).not.toContain('user:pw')
  })

  it('leaves an address without credentials exactly as written', () => {
    const text = 'Loaded https://Example.com/a?b=1&c=%20 and wss://example.com/socket'
    expect(scrubAddressesInText(text)).toBe(text)
  })

  it('is idempotent', () => {
    const once = scrubAddressesInText('x https://example.com/cb?access_token=abc y')
    expect(scrubAddressesInText(once)).toBe(once)
  })
})

describe('headerValue', () => {
  it('finds a header whatever the case of its name', () => {
    expect(headerValue({ 'Content-Type': 'application/json' }, 'content-type')).toBe('application/json')
    expect(headerValue({ accept: '*/*' }, 'content-type')).toBeUndefined()
    expect(headerValue(undefined, 'content-type')).toBeUndefined()
  })
})
