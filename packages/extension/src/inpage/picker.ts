/**
 * Visual "click-to-select" picker, executed INSIDE the page (isolated world). Self-contained.
 * Shows a banner and a highlight box; resolves with a robust CSS selector for the clicked element
 * (or, for an answer, a selector matching every answer of the same kind), or null on Escape/timeout.
 */

export interface PickOptions {
  readonly kind: 'input' | 'send' | 'stop' | 'response'
  readonly label: string
  readonly timeoutMs: number
}

export interface PickResult {
  readonly selector: string
  readonly tag: string
  readonly text: string
  readonly matches: number
}

export function corsenPick(options: PickOptions): Promise<PickResult | null> {
  const unique = (selector: string): boolean => {
    try {
      return document.querySelectorAll(selector).length === 1
    } catch {
      return false
    }
  }
  const count = (selector: string): number => {
    try {
      return document.querySelectorAll(selector).length
    } catch {
      return 0
    }
  }
  const quote = (value: string): string => `"${value.replace(/["\\]/g, '\\$&')}"`
  const stableClass = (name: string): boolean => /^[a-zA-Z][a-zA-Z0-9_-]{2,40}$/.test(name) && !/\d{3,}/.test(name) && !/^(css|sc|jsx|tw)-/.test(name) && !/[A-Z].*[a-z].*[A-Z]/.test(name)

  const simpleSelectors = (el: Element): string[] => {
    const tag = el.tagName.toLowerCase()
    const out: string[] = []
    if (el.id !== '' && /^[A-Za-z][\w-]*$/.test(el.id) && !/\d{4,}/.test(el.id)) out.push(`#${CSS.escape(el.id)}`)
    for (const attribute of ['data-testid', 'data-test-id', 'data-qa', 'aria-label', 'name', 'placeholder', 'role', 'type']) {
      const value = el.getAttribute(attribute)
      if (value !== null && value !== '' && value.length <= 80) out.push(`${tag}[${attribute}=${quote(value)}]`)
    }
    for (const attribute of [...el.attributes].map((attr) => attr.name).filter((name) => name.startsWith('data-') && name.length <= 40)) {
      const value = el.getAttribute(attribute) ?? ''
      out.push(value !== '' && value.length <= 40 ? `${tag}[${attribute}=${quote(value)}]` : `${tag}[${attribute}]`)
    }
    const classes = [...el.classList].filter(stableClass).slice(0, 3)
    if (classes.length > 0) out.push(`${tag}.${classes.map((name) => CSS.escape(name)).join('.')}`)
    if ((el as HTMLElement).isContentEditable) out.push(`${tag}[contenteditable="true"]`)
    return out
  }

  const pathSelector = (el: Element): string => {
    const parts: string[] = []
    let current: Element | null = el
    for (let depth = 0; current !== null && current !== document.body && depth < 6; depth += 1) {
      const anchor = simpleSelectors(current).find(unique)
      if (anchor !== undefined) {
        parts.unshift(anchor)
        break
      }
      const parent: Element | null = current.parentElement
      const tag = current.tagName.toLowerCase()
      if (parent === null) {
        parts.unshift(tag)
        break
      }
      const sameTag = [...parent.children].filter((child) => child.tagName === current?.tagName)
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(current) + 1})` : tag)
      current = parent
    }
    return parts.join(' > ')
  }

  const selectorFor = (el: Element): string => simpleSelectors(el).find(unique) ?? pathSelector(el)

  /** For answers: the most specific selector matching this element (or an ancestor) and its siblings of the same kind. */
  const answerSelector = (el: Element): { selector: string; matches: number } => {
    let best: { selector: string; matches: number; score: number } | null = null
    let current: Element | null = el
    for (let depth = 0; current !== null && current !== document.body && depth < 8; depth += 1) {
      for (const selector of simpleSelectors(current)) {
        const matches = count(selector)
        if (matches === 0) continue
        const score = (matches >= 2 ? 10 : 0) - depth - (selector.startsWith('#') ? 20 : 0) + (selector.includes('[data-') ? 3 : 0)
        if (best === null || score > best.score) best = { selector, matches, score }
      }
      current = current.parentElement
    }
    return best ?? { selector: pathSelector(el), matches: 1 }
  }

  return new Promise((resolve) => {
    const banner = document.createElement('div')
    const box = document.createElement('div')
    banner.setAttribute('data-corsen-picker', '')
    box.setAttribute('data-corsen-picker', '')
    banner.textContent = `Corsen Connector — click the ${options.label}. Press Esc to cancel.`
    Object.assign(banner.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647', padding: '10px 16px',
      background: '#111827', color: '#e6edf7', border: '2px solid #8b5cf6', borderRadius: '10px', font: '600 14px system-ui, sans-serif',
      boxShadow: '0 8px 30px rgba(0,0,0,.35)', pointerEvents: 'none',
    })
    Object.assign(box.style, {
      position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', border: '2px solid #22d3ee', background: 'rgba(34,211,238,.12)',
      borderRadius: '6px', transition: 'all 60ms linear', display: 'none',
    })
    document.documentElement.append(banner, box)

    let done = false
    const finish = (result: PickResult | null): void => {
      if (done) return
      done = true
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey, true)
      clearTimeout(timer)
      banner.remove()
      box.remove()
      resolve(result)
    }
    const target = (event: Event): Element | null => {
      const el = event.composedPath().find((node): node is Element => node instanceof Element && !node.hasAttribute('data-corsen-picker'))
      return el ?? null
    }
    const onMove = (event: MouseEvent): void => {
      const el = target(event)
      if (el === null) return
      const rect = el.getBoundingClientRect()
      Object.assign(box.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    }
    const onClick = (event: MouseEvent): void => {
      const el = target(event)
      if (el === null) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().slice(0, 120)
      if (options.kind === 'response') {
        const answer = answerSelector(el)
        finish({ selector: answer.selector, tag: el.tagName.toLowerCase(), text, matches: answer.matches })
        return
      }
      const control = options.kind === 'input' ? (el.closest('textarea, input, [contenteditable="true"]') ?? el) : (el.closest('button, [role="button"]') ?? el)
      const selector = selectorFor(control)
      finish({ selector, tag: control.tagName.toLowerCase(), text, matches: count(selector) })
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      }
    }
    const timer = setTimeout(() => finish(null), options.timeoutMs)
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKey, true)
  })
}
