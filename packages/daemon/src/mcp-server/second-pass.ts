import {
  headerValue,
  redactBodyText,
  redactHeaders,
  scrubAddressesInText,
  scrubUrl,
  type CapturedCall,
  type DevtoolsEntry,
  type McpTarget,
  type NetworkFailure,
  type ReadPageResult,
} from '@corsen-ai/shared'

/**
 * The daemon's second redaction pass over what the extension returns, before an agent receives it.
 * The extension applies the same rules first (`@corsen-ai/shared` redaction); this pass makes sure a
 * faulty or outdated extension is not enough to hand a credential to an agent.
 *
 * It covers what has a structure the daemon can read: addresses, header maps, captured bodies,
 * addresses written in DevTools messages and stack frames, and the link and image targets of a
 * Markdown page. Form
 * field values are masked inside the page by the distiller, which only the page can do, and the
 * visible text of a page is not rewritten. Every rule is idempotent: what the extension already
 * masked comes out unchanged.
 */

/** The header schema's own cap, so this pass never cuts a value the extension kept. */
const HEADER_VALUE_CHARS = 8_000

/** `](target)` in Markdown: the address of a link or an image. */
const MARKDOWN_TARGET = /\]\(([^\s)]+)\)/g

/** `(address:line:column)`: a frame of a stack as the extension writes it. */
const STACK_FRAME = /\((\S+?)(:\d+:\d+)\)/g

/** Scrub the address of each frame, keeping its line and column out of the address. */
function scrubStack(stack: string): string {
  return stack.replace(STACK_FRAME, (whole, address: string, position: string) => {
    const scrubbed = scrubAddressesInText(address)
    return scrubbed === address ? whole : `(${scrubbed}${position})`
  })
}

export function secondPassTargets(targets: readonly McpTarget[]): McpTarget[] {
  return targets.map((target) => ({ ...target, url: scrubUrl(target.url) }))
}

export function secondPassPage(page: ReadPageResult): ReadPageResult {
  const content =
    page.mode === 'markdown'
      ? page.content.replace(MARKDOWN_TARGET, (whole, target: string) => {
          const scrubbed = scrubAddressesInText(target)
          return scrubbed === target ? whole : `](${scrubbed})`
        })
      : page.content
  return { ...page, url: scrubUrl(page.url), content }
}

function secondPassFailure(network: NetworkFailure): NetworkFailure {
  const requestType = headerValue(network.requestHeaders, 'content-type') ?? ''
  return {
    ...network,
    url: scrubUrl(network.url),
    ...(network.requestHeaders !== undefined ? { requestHeaders: redactHeaders(network.requestHeaders, HEADER_VALUE_CHARS) } : {}),
    ...(network.responseHeaders !== undefined ? { responseHeaders: redactHeaders(network.responseHeaders, HEADER_VALUE_CHARS) } : {}),
    ...(network.requestBody !== undefined ? { requestBody: redactBodyText(network.requestBody, requestType) } : {}),
    ...(network.responseBody !== undefined ? { responseBody: redactBodyText(network.responseBody, network.mimeType ?? '') } : {}),
  }
}

export function secondPassDevtools(entries: readonly DevtoolsEntry[]): DevtoolsEntry[] {
  return entries.map((entry) => ({
    ...entry,
    message: scrubAddressesInText(entry.message),
    ...(entry.url !== undefined ? { url: scrubUrl(entry.url) } : {}),
    ...(entry.stack !== undefined ? { stack: scrubStack(entry.stack) } : {}),
    ...(entry.network !== undefined ? { network: secondPassFailure(entry.network) } : {}),
  }))
}

export function secondPassCalls(calls: readonly CapturedCall[]): CapturedCall[] {
  return calls.map((call) => {
    const requestType = headerValue(call.requestHeaders, 'content-type') ?? ''
    return {
      ...call,
      url: scrubUrl(call.url),
      ...(call.requestHeaders !== undefined ? { requestHeaders: redactHeaders(call.requestHeaders, HEADER_VALUE_CHARS) } : {}),
      ...(call.requestBody !== undefined ? { requestBody: redactBodyText(call.requestBody, requestType) } : {}),
      ...(call.responseBody !== undefined ? { responseBody: redactBodyText(call.responseBody, call.mimeType) } : {}),
    }
  })
}
