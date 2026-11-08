import type { CapturedCall, DevtoolsEntry, DevtoolsTotals, McpTarget, ReadPageResult } from '@corsen-ai/shared'

/** Pure formatters turning extension results into compact, LLM-friendly text. */

function kilo(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars)
}

export function formatTargets(targets: readonly McpTarget[]): string {
  if (targets.length === 0) {
    return [
      'No tab is exposed to agents yet.',
      'Ask the user to open the page, click the Corsen extension icon and choose "Expose to MCP" (🛠️ MCP Target).',
    ].join('\n')
  }
  const lines = targets.map((target) => {
    const counters = `console errors: ${target.consoleErrors}, failed requests: ${target.networkErrors}`
    return `- target_id ${target.targetId}${target.active ? ' (active tab)' : ''}: ${target.title || '(untitled)'} — ${target.url} · ${counters}`
  })
  return [`Exposed tabs (${targets.length}):`, ...lines, '', 'Pass target_id to the other browser_* tools (optional when only one tab is exposed).'].join('\n')
}

export function formatReadPage(targetId: string, result: ReadPageResult): string {
  const meta = [
    `target ${targetId}`,
    result.mode,
    `${kilo(result.outputChars)} chars`,
    `${result.refCount} refs`,
    ...(result.truncated ? ['TRUNCATED — raise max_chars or use scope "main"'] : []),
  ].join(' · ')
  return [`# ${result.title || '(untitled)'}`, `URL: ${result.url}`, `(${meta})`, '', result.content].join('\n')
}

function formatEntry(entry: DevtoolsEntry): string {
  const time = new Date(entry.timestamp).toISOString().slice(11, 23)
  const where = entry.url !== undefined ? ` @ ${entry.url}${entry.line !== undefined ? `:${entry.line + 1}` : ''}${entry.column !== undefined ? `:${entry.column + 1}` : ''}` : ''
  const lines = [`#${entry.id} ${time} [${entry.kind}/${entry.level}] ${entry.message}${where}`]
  if (entry.stack !== undefined && entry.stack !== '') lines.push(`  stack: ${entry.stack.split('\n').slice(0, 8).join('\n         ')}`)
  const net = entry.network
  if (net !== undefined) {
    lines.push(`  ${net.method} ${net.url} → ${net.status === 0 ? `failed (${net.errorText ?? 'network error'})` : `${net.status} ${net.statusText}`}${net.durationMs !== undefined ? ` in ${Math.round(net.durationMs)} ms` : ''}`)
    if (net.requestBody !== undefined && net.requestBody !== '') lines.push(`  request body: ${net.requestBody}`)
    if (net.responseBody !== undefined && net.responseBody !== '') lines.push(`  response body${net.responseBodyTruncated === true ? ' (truncated)' : ''}: ${net.responseBody}`)
    if (net.responseHeaders !== undefined) {
      const interesting = Object.entries(net.responseHeaders).filter(([name]) => /^(content-type|x-request-id|www-authenticate|retry-after|location)$/i.test(name))
      if (interesting.length > 0) lines.push(`  response headers: ${interesting.map(([name, value]) => `${name}: ${value}`).join('; ')}`)
    }
  }
  return lines.join('\n')
}

export function formatDevtools(targetId: string, entries: readonly DevtoolsEntry[], totals: DevtoolsTotals, lastId: number): string {
  const header = `DevTools feed for target ${targetId} — totals since attach: console ${totals.console}, exceptions ${totals.exception}, log ${totals.log}, network ${totals.network}. Last id: ${lastId} (pass since_id=${lastId} next time).`
  if (entries.length === 0) return `${header}\n\nNo matching errors. 🎉`
  return [header, '', ...entries.map(formatEntry)].join('\n\n')
}

export function formatNetwork(targetId: string, calls: readonly CapturedCall[], lastId: number): string {
  const header = `Captured API calls for target ${targetId} (${calls.length}). Last id: ${lastId}.`
  if (calls.length === 0) {
    return `${header}\n\nNothing captured yet. Calls are recorded only while the tab is exposed: trigger the action in the page (or browser_act reload) and call again.`
  }
  const blocks = calls.map((call) => {
    const lines = [`#${call.id} [${call.kind}${call.graphqlOperation !== undefined ? ` ${call.graphqlOperation}` : ''}] ${call.method} ${call.url} → ${call.status} (${call.mimeType}${call.durationMs !== undefined ? `, ${Math.round(call.durationMs)} ms` : ''})`]
    if (call.requestBody !== undefined && call.requestBody !== '') lines.push(`request body:\n${call.requestBody}`)
    if (call.responseBody !== undefined) lines.push(`response body${call.responseBodyTruncated ? ' (truncated)' : ''}:\n${call.responseBody}`)
    return lines.join('\n')
  })
  return [header, '', ...blocks].join('\n\n')
}
