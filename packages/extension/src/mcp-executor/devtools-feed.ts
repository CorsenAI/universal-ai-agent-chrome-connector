import type Protocol from 'devtools-protocol'
import { LIMITS, scrubUrl, type DevtoolsEntry, type DevtoolsKind, type DevtoolsTotals } from '@corsen-ai/shared'
import type { DebuggerManager } from '../cdp/debugger-manager'

type NewEntry = Omit<DevtoolsEntry, 'id'>

interface TabFeed {
  entries: DevtoolsEntry[]
  nextId: number
  totals: { console: number; exception: number; log: number; network: number }
}

const clip = (text: string, max = LIMITS.MAX_ENTRY_TEXT_CHARS): string => (text.length > max ? `${text.slice(0, max)}…` : text)

function remoteText(object: Protocol.Runtime.RemoteObject): string {
  if (object.value !== undefined) return typeof object.value === 'string' ? object.value : JSON.stringify(object.value)
  if (object.unserializableValue !== undefined) return object.unserializableValue
  return object.description ?? object.type
}

export function formatStack(stack: Protocol.Runtime.StackTrace | undefined): string | undefined {
  if (stack === undefined || stack.callFrames.length === 0) return undefined
  return stack.callFrames
    .slice(0, 12)
    .map((frame) => `at ${frame.functionName || '<anonymous>'} (${scrubUrl(frame.url)}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`)
    .join('\n')
}

/**
 * DevTools Error Feeder: console errors/warnings, uncaught exceptions and browser log errors captured
 * live on MCP target tabs (network failures are added by the NetworkTap). Ring buffer per tab.
 */
export class DevtoolsFeed {
  readonly #tabs = new Map<number, TabFeed>()
  readonly #isTarget: (tabId: number) => boolean
  readonly #onChange: (tabId: number) => void

  constructor(manager: DebuggerManager, isTarget: (tabId: number) => boolean, onChange: (tabId: number) => void) {
    this.#isTarget = isTarget
    this.#onChange = onChange
    manager.onEvent((tabId, method, params) => {
      if (!this.#isTarget(tabId)) return
      if (method === 'Runtime.consoleAPICalled') this.#onConsole(tabId, params as unknown as Protocol.Runtime.ConsoleAPICalledEvent)
      else if (method === 'Runtime.exceptionThrown') this.#onException(tabId, params as unknown as Protocol.Runtime.ExceptionThrownEvent)
      else if (method === 'Log.entryAdded') this.#onLog(tabId, (params as unknown as Protocol.Log.EntryAddedEvent).entry)
    })
  }

  #feed(tabId: number): TabFeed {
    let feed = this.#tabs.get(tabId)
    if (feed === undefined) {
      feed = { entries: [], nextId: 1, totals: { console: 0, exception: 0, log: 0, network: 0 } }
      this.#tabs.set(tabId, feed)
    }
    return feed
  }

  add(tabId: number, entry: NewEntry): void {
    const feed = this.#feed(tabId)
    feed.entries.push({ ...entry, id: feed.nextId })
    feed.nextId += 1
    if (entry.level === 'error') feed.totals[entry.kind] += 1
    if (feed.entries.length > LIMITS.MAX_DEVTOOLS_ENTRIES) feed.entries.splice(0, feed.entries.length - LIMITS.MAX_DEVTOOLS_ENTRIES)
    this.#onChange(tabId)
  }

  query(tabId: number, options: { kinds: readonly DevtoolsKind[]; sinceId: number; limit: number; clear: boolean }): { entries: DevtoolsEntry[]; totals: DevtoolsTotals; lastId: number } {
    const feed = this.#feed(tabId)
    const kinds = options.kinds.length > 0 ? new Set(options.kinds) : null
    const matching = feed.entries.filter((entry) => entry.id > options.sinceId && (kinds === null || kinds.has(entry.kind)))
    const entries = matching.slice(-options.limit)
    const result = { entries, totals: { ...feed.totals }, lastId: feed.nextId - 1 }
    if (options.clear) {
      feed.entries = []
      this.#onChange(tabId)
    }
    return result
  }

  /** Error counters shown next to each MCP target. */
  counts(tabId: number): { console: number; network: number } {
    const totals = this.#tabs.get(tabId)?.totals
    return { console: (totals?.console ?? 0) + (totals?.exception ?? 0) + (totals?.log ?? 0), network: totals?.network ?? 0 }
  }

  forget(tabId: number): void {
    this.#tabs.delete(tabId)
  }

  #onConsole(tabId: number, event: Protocol.Runtime.ConsoleAPICalledEvent): void {
    const level = event.type === 'error' || event.type === 'assert' ? 'error' : event.type === 'warning' ? 'warning' : null
    if (level === null) return
    const top = event.stackTrace?.callFrames[0]
    const stack = formatStack(event.stackTrace)
    this.add(tabId, {
      kind: 'console',
      level,
      timestamp: event.timestamp,
      message: clip(event.args.map(remoteText).join(' ') || `console.${event.type}`),
      ...(top !== undefined ? { url: scrubUrl(top.url), line: top.lineNumber, column: top.columnNumber } : {}),
      ...(stack !== undefined ? { stack: clip(stack) } : {}),
    })
  }

  #onException(tabId: number, event: Protocol.Runtime.ExceptionThrownEvent): void {
    const details = event.exceptionDetails
    const stack = formatStack(details.stackTrace)
    this.add(tabId, {
      kind: 'exception',
      level: 'error',
      timestamp: event.timestamp,
      message: clip(details.exception?.description ?? details.text),
      ...(details.url !== undefined ? { url: scrubUrl(details.url) } : {}),
      line: details.lineNumber,
      column: details.columnNumber,
      ...(stack !== undefined ? { stack: clip(stack) } : {}),
    })
  }

  #onLog(tabId: number, entry: Protocol.Log.LogEntry): void {
    if (entry.level !== 'error' || entry.source === 'network') return // network failures come with full details from the NetworkTap
    this.add(tabId, {
      kind: 'log',
      level: 'error',
      timestamp: entry.timestamp,
      message: clip(`[${entry.source}] ${entry.text}`),
      ...(entry.url !== undefined ? { url: scrubUrl(entry.url) } : {}),
      ...(entry.lineNumber !== undefined ? { line: entry.lineNumber } : {}),
    })
  }
}
