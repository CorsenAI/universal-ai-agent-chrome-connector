import { describe, expect, it } from 'vitest'
import { MASK, type CapturedCall, type DevtoolsEntry, type ReadPageResult } from '@corsen-ai/shared'
import { secondPassCalls, secondPassDevtools, secondPassPage, secondPassTargets } from '../src/mcp-server/second-pass'

/** What an extension that skipped its own redaction would send. */
const rawFailure: DevtoolsEntry = {
  id: 1,
  kind: 'network',
  level: 'error',
  timestamp: 1,
  message: 'POST https://app.example/login?session=s3ss → HTTP 401 Unauthorized',
  url: 'https://app.example/login?session=s3ss',
  stack: 'at submit (https://cdn.example/app.js?sig=abc:10:4)\n         at onClick (https://cdn.example/app.js:20:1)',
  network: {
    method: 'POST',
    url: 'https://app.example/login?session=s3ss',
    status: 401,
    statusText: 'Unauthorized',
    resourceType: 'Document',
    mimeType: 'application/json',
    requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'sid=1' },
    responseHeaders: { 'Set-Cookie': 'sid=2', 'Content-Type': 'application/json' },
    requestBody: 'username=ann&password=hunter2',
    responseBody: '{"error":"bad password","session":"s3ss"}',
  },
}

const rawCall: CapturedCall = {
  id: 1,
  kind: 'json',
  method: 'POST',
  url: 'https://auth.example/token?client_secret=cs',
  status: 200,
  mimeType: 'application/json',
  timestamp: 1,
  requestHeaders: { 'content-type': 'application/x-www-form-urlencoded', Authorization: 'Bearer abc' },
  requestBody: 'grant_type=authorization_code&code=c0de&code_verifier=v',
  responseBody: '{"access_token":"at","id":12345678901234567890}',
  responseBodyTruncated: false,
}

const rawPage: ReadPageResult = {
  title: 'Account',
  url: 'https://app.example/account?token=t0k',
  mode: 'markdown',
  content: '# Account\n[Reset](https://app.example/reset?token=t0k) [ref=e1]\n![Avatar](https://img.example/a.png?sig=s1g)\n[Home](https://app.example/) [ref=e2]\nVisible text: https://docs.example/?api_key=EXAMPLE',
  refCount: 2,
  truncated: false,
  sourceChars: 1000,
  outputChars: 200,
}

describe('daemon second redaction pass', () => {
  it('masks what an extension left in DevTools entries', () => {
    const [entry] = secondPassDevtools([rawFailure])
    const text = JSON.stringify(entry)
    for (const secret of ['s3ss', 'sig=abc', 'hunter2', 'sid=1', 'sid=2']) expect(text).not.toContain(secret)
    expect(entry?.network?.requestBody).toBe(`username=ann&password=${MASK}`)
    expect(entry?.network?.requestHeaders?.['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(entry?.stack).toContain(':10:4)')
    expect(entry?.stack).toContain('(https://cdn.example/app.js:20:1)')
    expect(entry?.network?.responseBody).toContain('bad password')
  })

  it('masks what an extension left in captured API calls', () => {
    const [call] = secondPassCalls([rawCall])
    const text = JSON.stringify(call)
    for (const secret of ['client_secret=cs', 'Bearer abc', 'c0de', 'code_verifier=v', '"at"']) expect(text).not.toContain(secret)
    expect(call?.requestBody).toBe(`grant_type=authorization_code&code=${MASK}&code_verifier=${MASK}`)
    expect(JSON.parse(call?.responseBody ?? '{}').access_token).toBe(MASK)
  })

  it('masks page and link addresses but leaves the visible text of the page as it is', () => {
    const page = secondPassPage(rawPage)
    expect(page.url).not.toContain('t0k')
    expect(page.content).not.toContain('reset?token=t0k')
    expect(page.content).not.toContain('sig=s1g')
    expect(page.content).toContain('[Home](https://app.example/) [ref=e2]')
    expect(page.content).toContain('Visible text: https://docs.example/?api_key=EXAMPLE')
    expect(secondPassTargets([{ targetId: '7', title: 'A', url: 'https://app.example/?token=t0k', consoleErrors: 0, networkErrors: 0, active: true }])[0]?.url).not.toContain('t0k')
  })

  it('changes nothing in data the extension already masked', () => {
    const entries = secondPassDevtools([rawFailure])
    const calls = secondPassCalls([rawCall])
    const page = secondPassPage(rawPage)
    expect(secondPassDevtools(entries)).toEqual(entries)
    expect(secondPassCalls(calls)).toEqual(calls)
    expect(secondPassPage(page)).toEqual(page)
    const clean: CapturedCall = { ...rawCall, url: 'https://api.example/items?page=2', requestHeaders: { Accept: '*/*' }, requestBody: '{"q":"shoes"}', responseBody: '{ "id": 12345678901234567890 }' }
    expect(secondPassCalls([clean])).toEqual([clean])
  })
})
