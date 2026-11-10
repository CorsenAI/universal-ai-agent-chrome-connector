import type Protocol from 'devtools-protocol'
import { LIMITS, classifyApiResponse, graphqlOperationName, headerValue, redactBodyText, redactHeaders, scrubUrl, type CapturedCall } from '@corsen-ai/shared'
import type { DebuggerManager } from '../cdp/debugger-manager'
import type { DevtoolsFeed } from './devtools-feed'

interface Pending {
  url: string
  method: string
  requestHeaders: Record<string, string>
  postData: string | undefined
  hasPostData: boolean
  resourceType: string
  startedMonotonic: number
  wallTimeMs: number
  status?: number
  statusText?: string
  mimeType?: string
  responseHeaders?: Record<string, string>
  want: 'failure' | 'api' | null
  apiKind?: 'json' | 'graphql'
}

interface TabCapture {
  readonly pending: Map<string, Pending>
  calls: CapturedCall[]
  nextId: number
}

const FAILURE_BODY_CHARS = 8_000
const API_BODY_CHARS = 400_000
const TEXTUAL = /(json|text|xml|javascript|graphql|html|x-www-form-urlencoded)/i

function decodeBody(body: string, base64: boolean, mimeType: string): string {
  if (!base64) return body
  if (!TEXTUAL.test(mimeType)) return '[binary body omitted]'
  try {
    const bytes = Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return '[undecodable body]'
  }
}

const clip = (text: string, max: number): { text: string; truncated: boolean } => (text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false })

/**
 * Network tap for MCP target tabs: failed requests (HTTP >= 400, network errors) go to the DevTools
 * feed with redacted headers and the response body; JSON / GraphQL exchanges go to the API capture
 * buffer. Bodies are fetched as soon as loading finishes (before Chrome evicts them).
 */
export class NetworkTap {
  readonly #tabs = new Map<number, TabCapture>()
  readonly #debugger: DebuggerManager
  readonly #feed: DevtoolsFeed
  readonly #isTarget: (tabId: number) => boolean

  constructor(manager: DebuggerManager, feed: DevtoolsFeed, isTarget: (tabId: number) => boolean) {
    this.#debugger = manager
    this.#feed = feed
    this.#isTarget = isTarget
    manager.onEvent((tabId, method, params) => {
      if (!this.#isTarget(tabId)) return
      if (method === 'Network.requestWillBeSent') this.#onRequest(tabId, params as unknown as Protocol.Network.RequestWillBeSentEvent)
      else if (method === 'Network.responseReceived') this.#onResponse(tabId, params as unknown as Protocol.Network.ResponseReceivedEvent)
      else if (method === 'Network.loadingFinished') void this.#onFinished(tabId, params as unknown as Protocol.Network.LoadingFinishedEvent)
      else if (method === 'Network.loadingFailed') this.#onFailed(tabId, params as unknown as Protocol.Network.LoadingFailedEvent)
    })
  }

  #tab(tabId: number): TabCapture {
    let capture = this.#tabs.get(tabId)
    if (capture === undefined) {
      capture = { pending: new Map(), calls: [], nextId: 1 }
      this.#tabs.set(tabId, capture)
    }
    return capture
  }

  query(tabId: number, options: { urlContains: string; method: string; kind: 'json' | 'graphql' | 'any'; sinceId: number; limit: number; includeBodies: boolean; maxBodyChars: number }): { calls: CapturedCall[]; lastId: number } {
    const capture = this.#tab(tabId)
    const needle = options.urlContains.toLowerCase()
    const calls = capture.calls
      .filter((call) => call.id > options.sinceId)
      .filter((call) => needle === '' || call.url.toLowerCase().includes(needle))
      .filter((call) => options.method === '' || call.method === options.method)
      .filter((call) => options.kind === 'any' || call.kind === options.kind)
      .slice(-options.limit)
      .map((call) => {
        if (!options.includeBodies) {
          const { requestBody: _request, responseBody: _response, ...rest } = call
          return { ...rest, responseBodyTruncated: false }
        }
        const response = call.responseBody !== undefined ? clip(call.responseBody, options.maxBodyChars) : undefined
        const request = call.requestBody !== undefined ? clip(call.requestBody, options.maxBodyChars).text : undefined
        return {
          ...call,
          ...(request !== undefined ? { requestBody: request } : {}),
          ...(response !== undefined ? { responseBody: response.text, responseBodyTruncated: call.responseBodyTruncated || response.truncated } : {}),
        }
      })
    return { calls, lastId: capture.nextId - 1 }
  }

  forget(tabId: number): void {
    this.#tabs.delete(tabId)
  }

  #onRequest(tabId: number, event: Protocol.Network.RequestWillBeSentEvent): void {
    const capture = this.#tab(tabId)
    if (capture.pending.size > 1_000) {
      const oldest = capture.pending.keys().next().value
      if (oldest !== undefined) capture.pending.delete(oldest)
    }
    capture.pending.set(event.requestId, {
      url: event.request.url,
      method: event.request.method,
      requestHeaders: redactHeaders(event.request.headers),
      postData: event.request.postData,
      hasPostData: event.request.hasPostData === true,
      resourceType: event.type ?? 'Other',
      startedMonotonic: event.timestamp,
      wallTimeMs: Math.round(event.wallTime * 1000),
      want: null,
    })
  }

  #onResponse(tabId: number, event: Protocol.Network.ResponseReceivedEvent): void {
    const pending = this.#tab(tabId).pending.get(event.requestId)
    if (pending === undefined) return
    pending.status = event.response.status
    pending.statusText = event.response.statusText
    pending.mimeType = event.response.mimeType
    pending.responseHeaders = redactHeaders(event.response.headers)
    if (event.response.status >= 400) {
      pending.want = 'failure'
      return
    }
    const kind = classifyApiResponse({ url: pending.url, mimeType: event.response.mimeType, requestBody: pending.postData })
    if (kind !== null && (event.type === 'XHR' || event.type === 'Fetch' || event.type === 'Other')) {
      pending.want = 'api'
      pending.apiKind = kind
    }
  }

  async #body(tabId: number, requestId: string, mimeType: string): Promise<string | undefined> {
    try {
      const response = await this.#debugger.send(tabId, 'Network.getResponseBody', { requestId })
      return decodeBody(response.body, response.base64Encoded, mimeType)
    } catch {
      return undefined
    }
  }

  async #postData(tabId: number, requestId: string, pending: Pending): Promise<string | undefined> {
    if (pending.postData !== undefined || !pending.hasPostData) return pending.postData
    try {
      const sent = await this.#debugger.send(tabId, 'Network.getRequestPostData', { requestId })
      // Chrome answers in base64 only for a body that is not valid UTF-8: binary, not maskable as text.
      return sent.base64Encoded ? '[binary body omitted]' : sent.postData
    } catch {
      return undefined
    }
  }

  async #onFinished(tabId: number, event: Protocol.Network.LoadingFinishedEvent): Promise<void> {
    const capture = this.#tab(tabId)
    const pending = capture.pending.get(event.requestId)
    if (pending === undefined) return
    capture.pending.delete(event.requestId)
    if (pending.want === null) return
    const mimeType = pending.mimeType ?? ''
    const durationMs = Math.max(0, (event.timestamp - pending.startedMonotonic) * 1000)
    const [rawBody, rawPost] = await Promise.all([this.#body(tabId, event.requestId, mimeType), this.#postData(tabId, event.requestId, pending)])
    const requestBody = rawPost !== undefined ? redactBodyText(rawPost, headerValue(pending.requestHeaders, 'content-type') ?? '') : undefined
    if (pending.want === 'failure') {
      const body = rawBody !== undefined ? clip(redactBodyText(rawBody, mimeType), FAILURE_BODY_CHARS) : undefined
      this.#feed.add(tabId, {
        kind: 'network',
        level: 'error',
        timestamp: pending.wallTimeMs,
        message: `${pending.method} ${scrubUrl(pending.url)} → HTTP ${pending.status ?? 0} ${pending.statusText ?? ''}`.trim(),
        url: scrubUrl(pending.url),
        network: {
          method: pending.method,
          url: scrubUrl(pending.url),
          status: pending.status ?? 0,
          statusText: (pending.statusText ?? '').slice(0, 200),
          resourceType: pending.resourceType,
          mimeType: mimeType.slice(0, 200),
          requestHeaders: pending.requestHeaders,
          ...(pending.responseHeaders !== undefined ? { responseHeaders: pending.responseHeaders } : {}),
          ...(requestBody !== undefined ? { requestBody: requestBody.slice(0, 20_000) } : {}),
          ...(body !== undefined ? { responseBody: body.text, responseBodyTruncated: body.truncated } : {}),
          durationMs,
        },
      })
      return
    }
    const body = rawBody !== undefined ? clip(redactBodyText(rawBody, mimeType), API_BODY_CHARS) : undefined
    const operation = pending.apiKind === 'graphql' ? graphqlOperationName(rawPost) : undefined
    capture.calls.push({
      id: capture.nextId,
      kind: pending.apiKind ?? 'json',
      method: pending.method,
      url: scrubUrl(pending.url),
      status: pending.status ?? 0,
      mimeType: mimeType.slice(0, 200),
      timestamp: pending.wallTimeMs,
      durationMs,
      ...(operation !== undefined ? { graphqlOperation: operation } : {}),
      requestHeaders: pending.requestHeaders,
      ...(requestBody !== undefined ? { requestBody: requestBody.slice(0, 100_000) } : {}),
      ...(body !== undefined ? { responseBody: body.text } : {}),
      responseBodyTruncated: body?.truncated ?? false,
    })
    capture.nextId += 1
    if (capture.calls.length > LIMITS.MAX_NETWORK_CALLS) capture.calls.splice(0, capture.calls.length - LIMITS.MAX_NETWORK_CALLS)
  }

  #onFailed(tabId: number, event: Protocol.Network.LoadingFailedEvent): void {
    const capture = this.#tab(tabId)
    const pending = capture.pending.get(event.requestId)
    capture.pending.delete(event.requestId)
    if (pending === undefined) return
    if (event.canceled === true && event.blockedReason === undefined && event.corsErrorStatus === undefined) return
    const reason = event.blockedReason !== undefined ? `blocked: ${event.blockedReason}` : event.corsErrorStatus !== undefined ? `CORS: ${event.corsErrorStatus.corsError}` : event.errorText
    this.#feed.add(tabId, {
      kind: 'network',
      level: 'error',
      timestamp: pending.wallTimeMs,
      message: `${pending.method} ${scrubUrl(pending.url)} → failed (${reason})`,
      url: scrubUrl(pending.url),
      network: {
        method: pending.method,
        url: scrubUrl(pending.url),
        status: pending.status ?? 0,
        statusText: (pending.statusText ?? '').slice(0, 200),
        resourceType: event.type,
        errorText: reason.slice(0, 1000),
        requestHeaders: pending.requestHeaders,
        durationMs: Math.max(0, (event.timestamp - pending.startedMonotonic) * 1000),
      },
    })
  }
}
