import {
  ActInput,
  ConnectorError,
  DevtoolsErrorsInput,
  LIMITS,
  MCP_TOOLS,
  NetworkCaptureInput,
  ReadPageInput,
  ScreenshotInput,
  estimateTokens,
  isMcpToolName,
  tabIdFromTargetId,
  targetIdForTab,
  toWireError,
  type ActParams,
  type McpToolName,
} from '@corsen-ai/shared'
import type * as z from 'zod'
import type { ActivityLog } from '../activity/activity-log'
import type { Logger } from '../util/logger'
import type { BrowserHub } from '../ws-hub/hub'
import { formatDevtools, formatNetwork, formatReadPage, formatTargets } from './format'

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface ToolCallResult {
  content: ToolContent[]
  isError?: boolean
}

/**
 * Implements the six MCP browser tools against the extension. Shared by the Streamable HTTP endpoint
 * and the `/api/tools/call` route used by stdio proxies, so both transports behave identically.
 *
 * Target resolution fails closed: a named target must be an exposed tab; with no name, exactly one
 * exposed tab must exist. The extension re-checks the role before touching the tab.
 */
export class McpToolExecutor {
  readonly #hub: BrowserHub
  readonly #activity: ActivityLog
  readonly #logger: Logger

  constructor(hub: BrowserHub, activity: ActivityLog, logger: Logger) {
    this.#hub = hub
    this.#activity = activity
    this.#logger = logger
  }

  async call(name: string, args: unknown, signal?: AbortSignal): Promise<ToolCallResult> {
    if (!isMcpToolName(name)) return errorResult('UNSUPPORTED', `Unknown tool "${name}".`)
    const tool = MCP_TOOLS.find((item) => item.name === name)
    const parsed = tool?.inputSchema.safeParse(args ?? {})
    if (parsed === undefined || !parsed.success) {
      return errorResult('INVALID_ARGUMENT', `Invalid arguments for ${name}: ${parsed?.error.issues.map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ') ?? ''}`)
    }
    const targetHint = typeof (parsed.data as { target_id?: unknown }).target_id === 'string' ? (parsed.data as { target_id: string }).target_id : undefined
    const finish = this.#activity.start({ kind: 'mcp', title: name, targetId: targetHint })
    try {
      const { result, tokensSaved, targetId } = await this.#dispatch(name, parsed.data, signal)
      finish({ status: 'ok', tokensSaved, targetId })
      return result
    } catch (error) {
      const wire = toWireError(error)
      this.#logger.debug('tool call failed', { tool: name, code: wire.code })
      finish({ status: 'error', detail: `${wire.code}: ${wire.message}` })
      return errorResult(wire.code, wire.message)
    }
  }

  /** Resolve the tab an agent may act on, failing closed. */
  resolveTarget(targetId: string | undefined): { tabId: number; targetId: string } {
    const state = this.#hub.state()
    if (state === null) throw new ConnectorError('NO_BROWSER', 'No browser is connected. Open Chrome with the Corsen extension installed and paired.')
    const targets = state.tabs.filter((tab) => tab.role === 'mcp')
    if (targetId !== undefined) {
      const tabId = tabIdFromTargetId(targetId)
      const match = tabId === null ? undefined : targets.find((tab) => tab.tabId === tabId)
      if (match === undefined) throw new ConnectorError('NO_TARGET', `Tab ${targetId} is not exposed to agents. Call browser_list_targets to see the exposed tabs.`)
      return { tabId: match.tabId, targetId }
    }
    if (targets.length === 0) throw new ConnectorError('NO_TARGET', 'No tab is exposed to agents. Ask the user to click the Corsen icon on the tab and choose "Expose to MCP".')
    if (targets.length > 1) {
      throw new ConnectorError('AMBIGUOUS_TARGET', `${targets.length} tabs are exposed; pass target_id (${targets.map((tab) => `${tab.tabId}: ${tab.title}`).join('; ')}).`)
    }
    const only = targets[0]
    if (only === undefined) throw new ConnectorError('NO_TARGET', 'No tab is exposed to agents.')
    return { tabId: only.tabId, targetId: targetIdForTab(only.tabId) }
  }

  async #dispatch(name: McpToolName, data: unknown, signal: AbortSignal | undefined): Promise<{ result: ToolCallResult; tokensSaved?: number; targetId?: string }> {
    const timeoutMs = LIMITS.RPC_TIMEOUT_MS
    switch (name) {
      case 'browser_list_targets': {
        const { targets } = await this.#hub.call('targets.list', {}, { timeoutMs, signal })
        return { result: text(formatTargets(targets)) }
      }
      case 'browser_read_page': {
        const input = data as z.infer<typeof ReadPageInput>
        const target = this.resolveTarget(input.target_id)
        const page = await this.#hub.call(
          'page.read',
          { tabId: target.tabId, mode: input.mode ?? 'markdown', maxChars: input.max_chars ?? LIMITS.DEFAULT_PAGE_CHARS, scope: input.scope ?? 'full' },
          { timeoutMs, signal },
        )
        const tokensSaved = Math.max(0, estimateTokens(page.sourceChars) - estimateTokens(page.outputChars))
        return { result: text(formatReadPage(target.targetId, page)), tokensSaved, targetId: target.targetId }
      }
      case 'browser_act': {
        const input = data as z.infer<typeof ActInput>
        const target = this.resolveTarget(input.target_id)
        const act = toActParams(input)
        const outcome = await this.#hub.call('page.act', { tabId: target.tabId, act }, { timeoutMs: Math.max(timeoutMs, (act.timeoutMs ?? 0) + 15_000), signal })
        const lines = [outcome.summary, `Now at: ${outcome.title || '(untitled)'} — ${outcome.url}`]
        if (outcome.navigated) lines.push('The page navigated: refs from earlier reads are stale, call browser_read_page again.')
        return { result: text(lines.join('\n')), targetId: target.targetId }
      }
      case 'browser_get_devtools_errors': {
        const input = data as z.infer<typeof DevtoolsErrorsInput>
        const target = this.resolveTarget(input.target_id)
        const feed = await this.#hub.call(
          'devtools.errors',
          { tabId: target.tabId, kinds: input.kinds ?? [], sinceId: input.since_id ?? 0, limit: input.limit ?? 50, clear: input.clear ?? false },
          { timeoutMs, signal },
        )
        return { result: text(formatDevtools(target.targetId, feed.entries, feed.totals, feed.lastId)), targetId: target.targetId }
      }
      case 'browser_capture_network_api': {
        const input = data as z.infer<typeof NetworkCaptureInput>
        const target = this.resolveTarget(input.target_id)
        const capture = await this.#hub.call(
          'network.capture',
          {
            tabId: target.tabId,
            urlContains: input.url_contains ?? '',
            method: (input.method ?? '').toUpperCase(),
            kind: input.kind ?? 'any',
            sinceId: input.since_id ?? 0,
            limit: input.limit ?? 10,
            includeBodies: input.include_bodies ?? true,
            maxBodyChars: input.max_body_chars ?? 20_000,
          },
          { timeoutMs, signal },
        )
        return { result: text(formatNetwork(target.targetId, capture.calls, capture.lastId)), targetId: target.targetId }
      }
      case 'browser_screenshot': {
        const input = data as z.infer<typeof ScreenshotInput>
        const target = this.resolveTarget(input.target_id)
        const shot = await this.#hub.call(
          'page.screenshot',
          { tabId: target.tabId, format: input.format ?? 'webp', quality: input.quality ?? 80, fullPage: input.full_page ?? false, bringToFront: input.bring_to_front ?? false },
          { timeoutMs, signal },
        )
        return {
          result: {
            content: [
              { type: 'image', data: shot.data, mimeType: shot.mimeType },
              { type: 'text', text: `Screenshot of target ${target.targetId}: ${shot.width}×${shot.height} ${shot.mimeType}. Pixels are not redacted.` },
            ],
          },
          targetId: target.targetId,
        }
      }
    }
  }
}

export function toActParams(input: z.infer<typeof ActInput>): ActParams {
  const act: ActParams = { action: input.action }
  const assign = <K extends keyof ActParams>(key: K, value: ActParams[K] | undefined): void => {
    if (value !== undefined) act[key] = value
  }
  assign('ref', input.ref)
  assign('selector', input.selector)
  assign('text', input.text)
  assign('submit', input.submit)
  assign('clear', input.clear)
  assign('key', input.key)
  assign('direction', input.direction)
  assign('amount', input.amount)
  assign('value', input.value)
  assign('url', input.url)
  assign('timeoutMs', input.timeout_ms)
  return act
}

function text(value: string): ToolCallResult {
  return { content: [{ type: 'text', text: value }] }
}

function errorResult(code: string, message: string): ToolCallResult {
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true }
}
