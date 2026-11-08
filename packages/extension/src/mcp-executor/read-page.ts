import { redactionConfig, scrubUrl, type ExtensionParams, type ReadPageResult } from '@corsen-ai/shared'
import type { DebuggerManager } from '../cdp/debugger-manager'
import type { IsolatedWorlds } from '../cdp/world'
import { corsenDistill } from '../inpage/distiller'
import { formatAxTree } from './ax-tree'
import type { RefRegistry } from './refs'

export interface ReadDeps {
  readonly debugger: DebuggerManager
  readonly worlds: IsolatedWorlds
  readonly refs: RefRegistry
}

/** `page.read`: Markdown (distiller in the isolated world) or compact accessibility tree (CDP). */
export async function readPage(deps: ReadDeps, params: ExtensionParams<'page.read'>): Promise<ReadPageResult> {
  const tab = await chrome.tabs.get(params.tabId)
  const url = scrubUrl(tab.url ?? '')
  if (params.mode === 'markdown') {
    const result = await deps.worlds.call(params.tabId, corsenDistill, [
      { mode: 'page', startIndex: deps.refs.startIndex(params.tabId), maxChars: params.maxChars, scope: params.scope, redaction: redactionConfig() },
    ])
    deps.refs.advanceTo(params.tabId, result.nextIndex)
    return {
      title: (result.title || tab.title || '').slice(0, 1000),
      url,
      mode: 'markdown',
      content: result.markdown,
      refCount: result.refCount,
      truncated: result.truncated,
      sourceChars: result.sourceChars,
      outputChars: result.markdown.length,
    }
  }
  await deps.debugger.enable(params.tabId, 'Accessibility')
  const { nodes } = await deps.debugger.send(params.tabId, 'Accessibility.getFullAXTree', {})
  const formatted = formatAxTree(nodes, (backendNodeId) => deps.refs.axRef(params.tabId, backendNodeId), params.maxChars)
  const sourceChars = await deps.worlds.call(params.tabId, () => document.documentElement?.outerHTML.length ?? 0, [])
  return {
    title: (tab.title ?? '').slice(0, 1000),
    url,
    mode: 'accessibility',
    content: formatted.text,
    refCount: formatted.refCount,
    truncated: formatted.truncated,
    sourceChars,
    outputChars: formatted.text.length,
  }
}
