import { describe, expect, it } from 'vitest'
import { MASK } from '@corsen-ai/shared'
import type { DebuggerManager, EventListener } from '../src/cdp/debugger-manager'
import { DevtoolsFeed } from '../src/mcp-executor/devtools-feed'
import { NetworkTap } from '../src/mcp-executor/network-tap'

const TAB = 7

/** The two DebuggerManager members the feed and the tap use: CDP events in, commands answered from a table. */
class FakeDebugger {
  readonly #listeners: EventListener[] = []
  readonly answers = new Map<string, unknown>()

  onEvent(listener: EventListener): () => void {
    this.#listeners.push(listener)
    return () => undefined
  }

  async send(_tabId: number, method: string, params?: { requestId?: string }): Promise<unknown> {
    const key = `${method}:${params?.requestId ?? ''}`
    if (!this.answers.has(key)) throw new Error(`no answer for ${key}`)
    return this.answers.get(key)
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of this.#listeners) listener(TAB, method, params)
  }
}

function setup(): { cdp: FakeDebugger; feed: DevtoolsFeed; tap: NetworkTap } {
  const cdp = new FakeDebugger()
  const manager = cdp as unknown as DebuggerManager
  const feed = new DevtoolsFeed(manager, () => true, () => undefined)
  const tap = new NetworkTap(manager, feed, () => true)
  return { cdp, feed, tap }
}

/** Run one request through the CDP events the tap listens to, then let its async body reads settle. */
async function exchange(cdp: FakeDebugger, id: string, request: Record<string, unknown>, response: Record<string, unknown>, type = 'Fetch'): Promise<void> {
  cdp.emit('Network.requestWillBeSent', { requestId: id, type, timestamp: 1, wallTime: 1_700_000_000, request })
  cdp.emit('Network.responseReceived', { requestId: id, type, response })
  cdp.emit('Network.loadingFinished', { requestId: id, timestamp: 2 })
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const errors = (feed: DevtoolsFeed) => feed.query(TAB, { kinds: [], sinceId: 0, limit: 50, clear: false }).entries

describe('network tap and DevTools feed redaction', () => {
  it('masks the password of a failed form login', async () => {
    const { cdp, feed } = setup()
    cdp.answers.set('Network.getResponseBody:r1', { body: '<p>Wrong password</p>', base64Encoded: false })
    await exchange(
      cdp,
      'r1',
      { url: 'https://app.example/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, postData: 'username=ann&password=hunter2', hasPostData: true },
      { status: 401, statusText: 'Unauthorized', mimeType: 'text/html', headers: { 'Set-Cookie': 'sid=1' } },
      'Document',
    )
    const [entry] = errors(feed)
    expect(entry?.network?.requestBody).toBe(`username=ann&password=${MASK}`)
    expect(entry?.network?.responseHeaders?.['Set-Cookie']).toBe(MASK)
  })

  it('keeps a JSON body with nothing to mask exactly as the page received it', async () => {
    const { cdp, tap } = setup()
    const body = '{ "id": 12345678901234567890, "name": "item" }'
    cdp.answers.set('Network.getResponseBody:r2', { body, base64Encoded: false })
    await exchange(cdp, 'r2', { url: 'https://api.example/items/1', method: 'GET', headers: { Accept: 'application/json' } }, { status: 200, statusText: 'OK', mimeType: 'application/json', headers: {} })
    const { calls } = tap.query(TAB, { urlContains: '', method: '', kind: 'any', sinceId: 0, limit: 10, includeBodies: true, maxBodyChars: 20_000 })
    expect(calls[0]?.responseBody).toBe(body)
  })

  it('omits a request body Chrome can only give as base64', async () => {
    const { cdp, feed } = setup()
    cdp.answers.set('Network.getRequestPostData:r3', { postData: 'AAEC', base64Encoded: true })
    cdp.answers.set('Network.getResponseBody:r3', { body: '{"error":"bad"}', base64Encoded: false })
    await exchange(
      cdp,
      'r3',
      { url: 'https://api.example/upload', method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, hasPostData: true },
      { status: 500, statusText: 'Server Error', mimeType: 'application/json', headers: {} },
    )
    expect(errors(feed)[0]?.network?.requestBody).toBe('[binary body omitted]')
  })

  it('masks credentials in addresses written in console messages', () => {
    const { cdp, feed } = setup()
    cdp.emit('Runtime.consoleAPICalled', { type: 'error', timestamp: 1, executionContextId: 1, args: [{ type: 'string', value: 'GET https://api.example/v1?token=abc failed' }] })
    const [entry] = errors(feed)
    expect(entry?.message).not.toContain('abc')
    expect(entry?.message).toContain('https://api.example/v1?token=')
  })
})
