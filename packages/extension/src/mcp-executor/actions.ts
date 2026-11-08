import { ConnectorError, scrubUrl, type ActParams, type ExtensionResult } from '@corsen-ai/shared'
import type { DebuggerManager } from '../cdp/debugger-manager'
import type { TrustedInput } from '../cdp/input'
import type { IsolatedWorlds } from '../cdp/world'
import type { RefRegistry } from './refs'

export interface ActDeps {
  readonly debugger: DebuggerManager
  readonly worlds: IsolatedWorlds
  readonly input: TrustedInput
  readonly refs: RefRegistry
  /** Main-frame navigation counter per tab (incremented on Page.frameNavigated). */
  readonly navigations: (tabId: number) => number
}

type Outcome = ExtensionResult<'page.act'>
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  await sleep(150)
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (tab === null) throw new ConnectorError('TAB_GONE', `tab ${tabId} was closed`)
    if (tab.status === 'complete') return
    await sleep(100)
  }
  throw new ConnectorError('TIMEOUT', `the page did not finish loading within ${timeoutMs} ms`)
}

/** Resolve a ref or selector to a backend DOM node id, failing closed on stale refs. */
async function resolveNode(deps: ActDeps, tabId: number, act: ActParams): Promise<{ backendNodeId: number; label: string }> {
  await deps.debugger.enable(tabId, 'DOM')
  let objectId: string | null = null
  if (act.ref !== undefined) {
    const target = deps.refs.lookup(tabId, act.ref)
    if (target === null) throw new ConnectorError('STALE_REF', `${act.ref} was never issued for this tab; call browser_read_page first`)
    if (target.kind === 'ax') {
      try {
        await deps.debugger.send(tabId, 'DOM.describeNode', { backendNodeId: target.backendNodeId })
      } catch {
        throw new ConnectorError('STALE_REF', `${act.ref} points to an element that no longer exists; read the page again`)
      }
      return { backendNodeId: target.backendNodeId, label: act.ref }
    }
    objectId = await deps.worlds.callForObject(
      tabId,
      (index: number) => {
        const state = (globalThis as unknown as { __corsenRefState?: { refs: Map<number, WeakRef<Element>> } }).__corsenRefState
        const el = state?.refs.get(index)?.deref()
        return el !== undefined && el.isConnected ? el : null
      },
      [target.index],
    )
    if (objectId === null) throw new ConnectorError('STALE_REF', `${act.ref} is from an earlier page or the element is gone; read the page again`)
  } else if (act.selector !== undefined) {
    objectId = await deps.worlds.callForObject(
      tabId,
      (selector: string) => {
        try {
          return document.querySelector(selector)
        } catch {
          return null
        }
      },
      [act.selector],
    )
    if (objectId === null) throw new ConnectorError('NOT_FOUND', `no element matches ${act.selector}`)
  } else {
    throw new ConnectorError('INVALID_ARGUMENT', `${act.action} needs a ref (from browser_read_page) or a selector`)
  }
  const { node } = await deps.debugger.send(tabId, 'DOM.describeNode', { objectId })
  void deps.debugger.send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => undefined)
  return { backendNodeId: node.backendNodeId, label: act.ref ?? act.selector ?? 'element' }
}

async function centerOf(deps: ActDeps, tabId: number, backendNodeId: number): Promise<{ x: number; y: number }> {
  await deps.debugger.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
  const { quads } = await deps.debugger.send(tabId, 'DOM.getContentQuads', { backendNodeId }).catch(() => ({ quads: [] as number[][] }))
  const quad = quads.find((candidate) => candidate.length >= 8)
  if (quad === undefined) throw new ConnectorError('ACTION_FAILED', 'the element has no visible box (hidden, zero-size or detached)')
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number)
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number)
  return { x: xs.reduce((a, b) => a + b, 0) / 4, y: ys.reduce((a, b) => a + b, 0) / 4 }
}

async function finish(deps: ActDeps, tabId: number, navigationsBefore: number, urlBefore: string, summary: string): Promise<Outcome> {
  // Give a click-triggered navigation a moment to start, then let it load.
  await sleep(250)
  const tab = await chrome.tabs.get(tabId)
  const navigated = deps.navigations(tabId) !== navigationsBefore || (tab.url ?? '') !== urlBefore
  if (navigated || tab.status === 'loading') await waitForLoad(tabId, 10_000).catch(() => undefined)
  const settled = await chrome.tabs.get(tabId)
  return { summary, url: scrubUrl(settled.url ?? ''), title: (settled.title ?? '').slice(0, 1000), navigated }
}

/** `page.act`: one deterministic action with trusted input; failures are errors, never fake successes. */
export async function performAction(deps: ActDeps, tabId: number, act: ActParams): Promise<Outcome> {
  const before = await chrome.tabs.get(tabId)
  const urlBefore = before.url ?? ''
  const navigationsBefore = deps.navigations(tabId)
  const timeout = act.timeoutMs ?? 10_000

  switch (act.action) {
    case 'click':
    case 'hover': {
      const { backendNodeId, label } = await resolveNode(deps, tabId, act)
      const point = await centerOf(deps, tabId, backendNodeId)
      if (act.action === 'click') await deps.input.click(tabId, point.x, point.y)
      else await deps.input.hover(tabId, point.x, point.y)
      return finish(deps, tabId, navigationsBefore, urlBefore, `${act.action === 'click' ? 'Clicked' : 'Hovered'} ${label}.`)
    }
    case 'type': {
      if (act.text === undefined) throw new ConnectorError('INVALID_ARGUMENT', 'type needs text')
      const { backendNodeId, label } = await resolveNode(deps, tabId, act)
      try {
        await deps.debugger.send(tabId, 'DOM.focus', { backendNodeId })
      } catch {
        const point = await centerOf(deps, tabId, backendNodeId)
        await deps.input.click(tabId, point.x, point.y)
      }
      if (act.clear !== false) await deps.input.selectAll(tabId)
      await deps.input.insertText(tabId, act.text)
      if (act.submit === true) await deps.input.press(tabId, 'Enter')
      return finish(deps, tabId, navigationsBefore, urlBefore, `Typed ${act.text.length} characters into ${label}${act.submit === true ? ' and pressed Enter' : ''}.`)
    }
    case 'select': {
      if (act.value === undefined) throw new ConnectorError('INVALID_ARGUMENT', 'select needs value (option value or label)')
      const { backendNodeId, label } = await resolveNode(deps, tabId, act)
      const { object } = await deps.debugger.send(tabId, 'DOM.resolveNode', { backendNodeId })
      if (object.objectId === undefined) throw new ConnectorError('STALE_REF', 'the element is gone')
      const response = await deps.debugger.send(tabId, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: function (this: Element, wanted: string) {
          if (!(this instanceof HTMLSelectElement)) return { ok: false, error: 'not a <select> element' }
          const options = [...this.options]
          const match = options.find((option) => option.value === wanted) ?? options.find((option) => option.textContent?.trim().toLowerCase() === wanted.trim().toLowerCase())
          if (match === undefined) return { ok: false, error: `no option "${wanted}" (options: ${options.map((option) => option.textContent?.trim()).slice(0, 20).join(', ')})` }
          this.value = match.value
          this.dispatchEvent(new Event('input', { bubbles: true }))
          this.dispatchEvent(new Event('change', { bubbles: true }))
          return { ok: true, label: match.textContent?.trim() ?? match.value }
        }.toString(),
        arguments: [{ value: act.value }],
        returnByValue: true,
      })
      const value = response.result.value as { ok: boolean; error?: string; label?: string } | undefined
      if (value?.ok !== true) throw new ConnectorError('NOT_FOUND', value?.error ?? 'could not select the option')
      return finish(deps, tabId, navigationsBefore, urlBefore, `Selected "${value.label ?? act.value}" in ${label}.`)
    }
    case 'press_key': {
      if (act.key === undefined) throw new ConnectorError('INVALID_ARGUMENT', 'press_key needs key')
      await deps.input.press(tabId, act.key)
      return finish(deps, tabId, navigationsBefore, urlBefore, `Pressed ${act.key}.`)
    }
    case 'scroll': {
      if (act.ref !== undefined || act.selector !== undefined) {
        const { backendNodeId, label } = await resolveNode(deps, tabId, act)
        await deps.debugger.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
        return finish(deps, tabId, navigationsBefore, urlBefore, `Scrolled ${label} into view.`)
      }
      const metrics = await deps.debugger.send(tabId, 'Page.getLayoutMetrics')
      const amount = act.amount ?? 600
      const direction = act.direction ?? 'down'
      const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0
      await deps.input.wheel(tabId, metrics.cssVisualViewport.clientWidth / 2, metrics.cssVisualViewport.clientHeight / 2, deltaX, deltaY)
      const position = await deps.worlds.call(tabId, () => ({ x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight }), [])
      return finish(deps, tabId, navigationsBefore, urlBefore, `Scrolled ${direction} by ${amount}px (now at y=${position.y} of ${position.height}).`)
    }
    case 'wait_for': {
      const deadline = Date.now() + timeout
      if (act.text === undefined && act.selector === undefined) {
        await sleep(Math.min(timeout, 10_000))
        return finish(deps, tabId, navigationsBefore, urlBefore, `Waited ${Math.min(timeout, 10_000)} ms.`)
      }
      while (Date.now() < deadline) {
        const found = await deps.worlds
          .call(
            tabId,
            (text: string | null, selector: string | null) => {
              if (selector !== null) {
                try {
                  const el = document.querySelector(selector)
                  if (el === null) return false
                  const rect = el.getBoundingClientRect()
                  if (rect.width === 0 && rect.height === 0) return false
                } catch {
                  return false
                }
              }
              if (text !== null) return (document.body?.innerText ?? '').includes(text)
              return true
            },
            [act.text ?? null, act.selector ?? null],
          )
          .catch(() => false)
        if (found) return finish(deps, tabId, navigationsBefore, urlBefore, `Found ${act.text !== undefined ? `"${act.text}"` : act.selector}.`)
        await sleep(250)
      }
      throw new ConnectorError('TIMEOUT', `${act.text !== undefined ? `"${act.text}"` : act.selector} did not appear within ${timeout} ms`)
    }
    case 'navigate': {
      if (act.url === undefined || !/^https?:\/\//i.test(act.url)) throw new ConnectorError('INVALID_ARGUMENT', 'navigate needs an absolute http(s) url')
      const result = await deps.debugger.send(tabId, 'Page.navigate', { url: act.url })
      if (result.errorText !== undefined && result.errorText !== '') throw new ConnectorError('ACTION_FAILED', `navigation failed: ${result.errorText}`)
      await waitForLoad(tabId, timeout)
      return finish(deps, tabId, navigationsBefore, urlBefore, `Navigated to ${scrubUrl(act.url)}.`)
    }
    case 'reload': {
      await deps.debugger.send(tabId, 'Page.reload', {})
      await waitForLoad(tabId, timeout)
      return finish(deps, tabId, navigationsBefore, urlBefore, 'Reloaded the page.')
    }
    case 'back':
    case 'forward': {
      const history = await deps.debugger.send(tabId, 'Page.getNavigationHistory')
      const entry = history.entries[history.currentIndex + (act.action === 'back' ? -1 : 1)]
      if (entry === undefined) throw new ConnectorError('ACTION_FAILED', `there is no ${act.action === 'back' ? 'previous' : 'next'} page in this tab's history`)
      await deps.debugger.send(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id })
      await waitForLoad(tabId, timeout)
      return finish(deps, tabId, navigationsBefore, urlBefore, `Went ${act.action}.`)
    }
  }
}
