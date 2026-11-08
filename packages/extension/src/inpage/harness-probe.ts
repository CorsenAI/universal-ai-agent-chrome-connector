/**
 * Web-chat probe, executed INSIDE the chat page (isolated world) through `Runtime.callFunctionOn`.
 * Self-contained (serialized): only parameters, inner functions and browser globals.
 *
 * The service worker drives the chat with trusted CDP input; this probe only observes: where the
 * input / send / stop controls are (viewport rectangles for clicks), and what the newest assistant
 * answer currently says (Markdown blocks produced by the distiller installed in the same world).
 */

export interface ProbeSelectors {
  readonly input: readonly string[]
  readonly send: readonly string[]
  readonly stop: readonly string[]
  readonly response: readonly string[]
  /** Containers that are not the answer (reasoning panels): matches inside them are skipped. */
  readonly exclude: readonly string[]
  /** Attribute on (or above) the answer whose value is "true" while the answer streams. */
  readonly streamingAttribute?: string | undefined
}

export interface ProbeOptions extends ProbeSelectors {
  readonly op: 'locate' | 'prepare' | 'poll' | 'readInput'
  readonly maxChars: number
}

export interface Rect {
  readonly x: number
  readonly y: number
}

export interface ProbeResult {
  readonly ok: boolean
  readonly needsDistiller: boolean
  readonly input: Rect | null
  readonly inputTag: string
  readonly inputText: string
  readonly send: Rect | null
  readonly stop: Rect | null
  readonly responseCount: number
  readonly newest: { readonly blocks: string[]; readonly textLength: number; readonly streaming: boolean } | null
  readonly url: string
}

export function corsenHarnessProbe(options: ProbeOptions): ProbeResult {
  type Baseline = { counts: Record<string, number>; last: Record<string, WeakRef<Element> | null> }
  const g = globalThis as unknown as {
    __corsenHarness?: Baseline
    __corsenDistill?: (opts: unknown) => { found: boolean; blocks: string[] }
  }

  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity || '1') > 0.05
  }

  const query = (selector: string): Element[] => {
    try {
      return [...document.querySelectorAll(selector)]
    } catch {
      return []
    }
  }

  const lastVisible = (selectors: readonly string[]): Element | null => {
    for (const selector of selectors) {
      const found = query(selector).filter(visible)
      const last = found[found.length - 1]
      if (last !== undefined) return last
    }
    return null
  }

  const center = (el: Element | null): Rect | null => {
    if (el === null) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }

  const textOf = (el: Element | null): string => {
    if (el === null) return ''
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value
    return (el as HTMLElement).innerText ?? el.textContent ?? ''
  }

  const input = lastVisible(options.input)
  const base: Omit<ProbeResult, 'ok' | 'needsDistiller' | 'responseCount' | 'newest'> = {
    input: options.op === 'locate' || options.op === 'prepare' ? center(input) : null,
    inputTag: input === null ? '' : input.tagName.toLowerCase() + ((input as HTMLElement).isContentEditable ? '[contenteditable]' : ''),
    inputText: options.op === 'readInput' || options.op === 'prepare' ? textOf(input).slice(0, 2_000_000) : '',
    send: options.op === 'locate' || options.op === 'prepare' || options.op === 'poll' ? center(lastVisible(options.send)) : null,
    stop: lastVisible(options.stop) !== null ? center(lastVisible(options.stop)) : null,
    url: location.href,
  }

  if (options.op === 'prepare') {
    const baseline: Baseline = { counts: {}, last: {} }
    for (const selector of options.response) {
      const found = query(selector)
      baseline.counts[selector] = found.length
      const last = found[found.length - 1]
      baseline.last[selector] = last !== undefined ? new WeakRef(last) : null
    }
    g.__corsenHarness = baseline
  }

  if (options.op !== 'poll') {
    return { ok: input !== null, needsDistiller: false, responseCount: 0, newest: null, ...base }
  }

  const distill = g.__corsenDistill
  if (typeof distill !== 'function') return { ok: false, needsDistiller: true, responseCount: 0, newest: null, ...base }
  const baseline = g.__corsenHarness ?? { counts: {}, last: {} }

  const excluded = (el: Element): boolean =>
    options.exclude.some((selector) => {
      try {
        return el.closest(selector) !== null
      } catch {
        return false
      }
    })

  for (const selector of options.response) {
    const found = query(selector)
    // newest match that is not inside a reasoning panel and not the composer
    let index = found.length - 1
    while (index >= 0) {
      const candidate = found[index]
      if (candidate !== undefined && !excluded(candidate) && !(input !== null && candidate.contains(input))) break
      index -= 1
    }
    const last = index >= 0 ? found[index] : undefined
    if (last === undefined) continue
    const wasCount = baseline.counts[selector] ?? 0
    const wasLast = baseline.last[selector]?.deref() ?? null
    const isNew = found.length > wasCount || (wasLast !== null && wasLast !== last) || (wasLast === null && found.length > 0 && wasCount === 0)
    if (!isNew) continue
    const result = distill({
      mode: 'element',
      selector,
      index,
      startIndex: 1,
      maxChars: options.maxChars,
      scope: 'full',
      redaction: { mask: '', secretParamFragments: [], secretAutocomplete: [], secretFieldFragments: [], secretInputTypes: [] },
    })
    const attribute = options.streamingAttribute
    const streamingHost = attribute !== undefined ? last.closest(`[${attribute}]`) : null
    const streaming = streamingHost !== null && attribute !== undefined ? streamingHost.getAttribute(attribute) === 'true' : false
    const textLength = result.blocks.reduce((sum, blockText) => sum + blockText.length, 0)
    return { ok: true, needsDistiller: false, responseCount: found.length, newest: { blocks: result.blocks, textLength, streaming }, ...base }
  }
  return { ok: true, needsDistiller: false, responseCount: 0, newest: null, ...base }
}
