/**
 * DOM → Markdown distiller, executed INSIDE the page (isolated world) through
 * `Runtime.callFunctionOn`. It must stay self-contained: it may only use its parameters, its own
 * inner functions and browser globals — never a module-scope identifier (the function source is
 * serialized). Types below are erased at build time.
 *
 * Modes:
 * - `page`: the whole page (or its main region) as structured Markdown, with `[ref=eN]` after every
 *   interactive element and secret field values masked (rules from `@corsen-ai/shared` redaction).
 * - `element`: one element (last match of `selector`) as Markdown blocks, for web-LLM answers.
 *
 * Refs live in this world's globals: an element keeps its ref across snapshots, numbers are never
 * reused (the service worker passes `startIndex`, the highest number it has handed out for the tab).
 */

export interface DistillRedaction {
  readonly mask: string
  readonly secretParamFragments: readonly string[]
  readonly secretAutocomplete: readonly string[]
  readonly secretFieldFragments: readonly string[]
  readonly secretInputTypes: readonly string[]
}

export interface DistillOptions {
  readonly mode: 'page' | 'element'
  readonly startIndex: number
  readonly maxChars: number
  readonly scope: 'full' | 'main'
  readonly redaction: DistillRedaction
  readonly selector?: string
  /** element mode: which match of `selector` to convert (default: the last one). */
  readonly index?: number
}

export interface DistillResult {
  readonly found: boolean
  readonly markdown: string
  readonly blocks: string[]
  readonly title: string
  readonly url: string
  readonly refCount: number
  readonly nextIndex: number
  readonly truncated: boolean
  readonly sourceChars: number
}

export function corsenDistill(options: DistillOptions): DistillResult {
  const MAX_NODES = 25_000
  const MAX_MS = 4_000
  const started = Date.now()
  const page = options.mode === 'page'
  const red = options.redaction
  let visited = 0
  let truncated = false

  type RefState = { next: number; ids: WeakMap<Element, number>; refs: Map<number, WeakRef<Element>> }
  const g = globalThis as unknown as { __corsenRefState?: RefState; __corsenDistill?: unknown }
  g.__corsenDistill = corsenDistill
  const state: RefState = g.__corsenRefState ?? { next: 1, ids: new WeakMap(), refs: new Map() }
  g.__corsenRefState = state
  state.next = Math.max(state.next, Math.floor(options.startIndex) || 1)
  if (state.refs.size > 5_000) {
    for (const [id, ref] of state.refs) {
      const el = ref.deref()
      if (el === undefined || !el.isConnected) state.refs.delete(id)
    }
  }
  const usedRefs = new Set<number>()

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG', 'CANVAS', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK', 'MAP'])
  const BLOCK = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIALOG', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
    'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
    'TABLE', 'UL', 'SUMMARY', 'BODY', 'TR', 'MENU', 'SEARCH',
  ])
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'treeitem'])
  // Answer extraction (element mode) ignores the chrome chat UIs draw around content: copy and
  // download buttons, toolbars, code-block header rows and line-number gutters.
  const CONTROL_ROLES = new Set(['button', 'toolbar', 'menu', 'menubar', 'menuitem', 'tooltip'])
  const CONTROLS = 'button, [role="button"], [role="toolbar"], [role="menu"], [role="menubar"], [role="menuitem"], [role="tooltip"]'
  const CHROME_WORDS = new Set(['copy', 'copied', 'code', 'download', 'run', 'edit', 'wrap', 'unwrap', 'expand', 'collapse', 'copier', 'copié', 'le', 'télécharger'])
  const PROSE = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'DL', 'TABLE', 'BLOCKQUOTE'])
  const LABEL = /^[\w+#.-]+(?: [\w+#.-]+){0,2}$/

  const outOfBudget = (): boolean => {
    if (truncated) return true
    visited += 1
    if (visited > MAX_NODES || (visited % 256 === 0 && Date.now() - started > MAX_MS)) truncated = true
    return truncated
  }

  const collapse = (text: string): string => text.replace(/[\s ]+/g, ' ')
  const clean = (text: string): string => collapse(text).trim()
  const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

  const isSecretParam = (name: string): boolean => red.secretParamFragments.some((fragment) => name.toLowerCase().includes(fragment))
  const scrubUrl = (raw: string): string => {
    if (raw === '') return ''
    let url: URL
    try {
      url = new URL(raw, document.baseURI)
    } catch {
      return '[unparseable URL]'
    }
    if (!['http:', 'https:', 'ftp:', 'file:', 'mailto:', 'tel:'].includes(url.protocol)) return `${url.protocol}[opaque URL]`
    if (url.protocol === 'mailto:' || url.protocol === 'tel:') return url.protocol
    url.username = ''
    url.password = ''
    for (const name of [...url.searchParams.keys()]) if (isSecretParam(name)) url.searchParams.set(name, red.mask)
    if (url.hash.includes('=')) {
      const fragment = new URLSearchParams(url.hash.slice(1))
      let changed = false
      for (const name of [...fragment.keys()]) {
        if (isSecretParam(name)) {
          fragment.set(name, red.mask)
          changed = true
        }
      }
      if (changed) url.hash = `#${fragment.toString()}`
    }
    return url.toString()
  }

  const isHidden = (el: Element): boolean => {
    if ((el as HTMLElement).hidden === true) return true
    if (el.getAttribute('aria-hidden') === 'true') return true
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
    if (style === null) return false
    return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
  }

  /** Children in the rendered (flat) tree: open shadow roots, slots, same-origin iframes. */
  const childrenOf = (node: Node): Node[] => {
    if (node instanceof Element) {
      if (node.shadowRoot !== null) return [...node.shadowRoot.childNodes]
      if (node.tagName === 'SLOT') {
        const assigned = (node as HTMLSlotElement).assignedNodes({ flatten: true })
        if (assigned.length > 0) return assigned
      }
      if (node.tagName === 'IFRAME') {
        try {
          const body = (node as HTMLIFrameElement).contentDocument?.body
          return body ? [body] : []
        } catch {
          return []
        }
      }
    }
    return [...node.childNodes]
  }

  const role = (el: Element): string => (el.getAttribute('role') ?? '').trim().toLowerCase().slice(0, 40)

  const isInteractive = (el: Element): boolean => {
    const tag = el.tagName
    if (tag === 'A') return (el as HTMLAnchorElement).hasAttribute('href')
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true
    if (tag === 'INPUT') return (el as HTMLInputElement).type !== 'hidden'
    if ((el as HTMLElement).isContentEditable === true && el.getAttribute('contenteditable') !== null) return true
    return INTERACTIVE_ROLES.has(role(el))
  }

  const isChromeControl = (el: Element): boolean => el.tagName === 'BUTTON' || CONTROL_ROLES.has(role(el))

  const isGutter = (el: Element): boolean => {
    if (/(?:^|[\s_-])(?:line-?numbers?|gutters?)(?:$|[\s_-])/i.test(el.getAttribute('class') ?? '')) return true
    const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined
    return style !== undefined && (style.getPropertyValue('user-select') === 'none' || style.getPropertyValue('-webkit-user-select') === 'none')
  }

  /** The words of a code-block header minus control words: '' when none, null when not a label. */
  const headerLabel = (raw: string): string | null => {
    const label = clean(raw)
      .split(' ')
      .filter((word) => word !== '' && !CHROME_WORDS.has(word.toLowerCase().replace(/[!.:…]+$/, '')))
      .join(' ')
    if (label === '') return ''
    return label.length <= 30 && LABEL.test(label) ? label.toLowerCase().replace(/ /g, '') : null
  }

  /** Text of `root` outside `exclude` and outside controls: a code block's header row. */
  const textOutside = (root: Element, exclude: Element): string => {
    let out = ''
    const walk = (node: Node): void => {
      for (const child of childrenOf(node)) {
        if (child === exclude) continue
        if (child.nodeType === Node.TEXT_NODE) {
          out += ` ${child.textContent ?? ''}`
          continue
        }
        if (!(child instanceof Element) || SKIP.has(child.tagName.toUpperCase()) || isChromeControl(child)) continue
        walk(child)
      }
    }
    walk(root)
    return clean(out)
  }

  /** Code text without gutters or controls; block children (one div per line) become lines. */
  const codeText = (root: Element): string => {
    let out = ''
    const walk = (node: Node): void => {
      for (const child of childrenOf(node)) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.textContent ?? ''
          continue
        }
        if (!(child instanceof Element)) continue
        const tag = child.tagName.toUpperCase()
        if (SKIP.has(tag) || isChromeControl(child) || isGutter(child) || child.getAttribute('aria-hidden') === 'true') continue
        if (tag === 'BR') {
          out += '\n'
          continue
        }
        const line = tag === 'DIV' || tag === 'P' || tag === 'LI'
        if (line && out !== '' && !out.endsWith('\n')) out += '\n'
        walk(child)
        if (line && out !== '' && !out.endsWith('\n')) out += '\n'
      }
    }
    walk(root)
    return out.replace(/\n+$/, '')
  }

  /**
   * A chat UI's code widget around exactly one <pre>: controls (copy, download) plus at most a
   * language label, and nothing that reads like prose. Returns the <pre> and its label, else null.
   */
  const codeWidget = (el: Element): { pre: Element; label: string } | null => {
    const pre = el.querySelector('pre')
    if (pre === null || el.querySelectorAll('pre').length !== 1) return null
    let controls = 0
    let prose = false
    let rest = ''
    const walk = (node: Node): void => {
      for (const child of childrenOf(node)) {
        if (prose || child === pre) continue
        if (child.nodeType === Node.TEXT_NODE) {
          rest += ` ${child.textContent ?? ''}`
          continue
        }
        if (!(child instanceof Element) || SKIP.has(child.tagName.toUpperCase()) || isHidden(child)) continue
        if (isChromeControl(child)) {
          controls += 1
          continue
        }
        if (PROSE.has(child.tagName)) {
          prose = true
          continue
        }
        walk(child)
      }
    }
    walk(el)
    if (prose || controls === 0) return null
    const label = headerLabel(rest)
    return label === null ? null : { pre, label }
  }

  const refTag = (el: Element): string => {
    if (!page) return ''
    let id = state.ids.get(el)
    if (id === undefined) {
      id = state.next
      state.next += 1
      state.ids.set(el, id)
    }
    state.refs.set(id, new WeakRef(el))
    usedRefs.add(id)
    return ` [ref=e${id}]`
  }

  const labelOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label')
    if (aria !== null && aria.trim() !== '') return clean(aria)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy !== null) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
      if (clean(text) !== '') return clean(text)
    }
    const id = el.getAttribute('id')
    if (id !== null && id !== '') {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (label !== null && clean(label.textContent ?? '') !== '') return clean(label.textContent ?? '')
      } catch {
        // invalid id for a selector
      }
    }
    const wrapping = el.closest('label')
    if (wrapping !== null && clean(wrapping.textContent ?? '') !== '') return clean(wrapping.textContent ?? '')
    return clean(el.getAttribute('placeholder') ?? el.getAttribute('title') ?? el.getAttribute('name') ?? '')
  }

  const isSecretField = (el: Element): boolean => {
    const type = (el.getAttribute('type') ?? '').toLowerCase()
    if (red.secretInputTypes.includes(type)) return true
    const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase()
    if (autocomplete.split(/\s+/).some((token) => red.secretAutocomplete.includes(token))) return true
    const haystack = [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), labelOf(el)]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.slice(0, 4096).toLowerCase())
      .join(' ')
    return red.secretFieldFragments.some((fragment) => haystack.includes(fragment))
  }

  const controlToken = (el: Element): string => {
    const tag = el.tagName
    const label = clip(labelOf(el), 120)
    const named = label !== '' ? ` "${label}"` : ''
    const disabled = (el as HTMLInputElement).disabled === true ? ' (disabled)' : ''
    if (tag === 'SELECT') {
      const select = el as HTMLSelectElement
      const chosen = select.selectedOptions[0]?.textContent ?? ''
      const options = [...select.options].slice(0, 30).map((option) => clean(option.textContent ?? '')).filter((text) => text !== '')
      const more = select.options.length > 30 ? `, … ${select.options.length - 30} more` : ''
      return `[select${named} = "${clip(clean(chosen), 100)}" (options: ${options.join(', ')}${more})${disabled}]${refTag(el)}`
    }
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color'].includes((el as HTMLInputElement).type))) {
      const input = el as HTMLInputElement
      const kind = tag === 'TEXTAREA' ? 'textarea' : input.type === 'search' ? 'searchbox' : `textbox type=${input.type || 'text'}`
      const value = input.value ?? ''
      const shown = value === '' ? '' : isSecretField(el) ? ` = "${red.mask}"` : ` = "${clip(value.replace(/\s+/g, ' '), 200)}"`
      return `[${kind}${named}${shown}${disabled}]${refTag(el)}`
    }
    if (tag === 'INPUT') {
      const input = el as HTMLInputElement
      if (input.type === 'checkbox' || input.type === 'radio') return `[${input.type}${named}${input.checked ? ' checked' : ''}${disabled}]${refTag(el)}`
      if (input.type === 'file') return `[file input${named}${disabled}]${refTag(el)}`
      if (input.type === 'range') return `[slider${named} = ${input.value}${disabled}]${refTag(el)}`
      const text = clean(input.value || label || input.type)
      return `[button "${clip(text, 120)}"${disabled}]${refTag(el)}`
    }
    if ((el as HTMLElement).isContentEditable === true) {
      const text = clip(clean((el as HTMLElement).innerText ?? el.textContent ?? ''), 200)
      return `[editor${named}${text !== '' ? ` = "${text}"` : ''}]${refTag(el)}`
    }
    return ''
  }

  /** A <pre> as a Markdown fence. `hint` is the label of a header row drawn outside the <pre>. */
  const fence = (pre: Element, hint = ''): string => {
    const code = pre.querySelector('code')
    let lang = ''
    for (const candidate of [code, pre]) {
      if (candidate === null) continue
      const match = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(candidate.getAttribute('class') ?? '')
      if (match?.[1] !== undefined) {
        lang = match[1]
        break
      }
      const data = candidate.getAttribute('data-language')
      if (data !== null && /^[\w+#.-]{1,30}$/.test(data)) {
        lang = data
        break
      }
    }
    // Without <code>, a <pre> that also holds controls keeps its code in its largest control-free block.
    let container: Element = code ?? pre
    if (code === null && pre.querySelector(CONTROLS) !== null) {
      let longest = -1
      for (const candidate of pre.querySelectorAll('div')) {
        if (isChromeControl(candidate) || candidate.querySelector(CONTROLS) !== null) continue
        const length = (candidate.textContent ?? '').length
        if (length > longest) {
          longest = length
          container = candidate
        }
      }
    }
    if (lang === '') lang = hint
    if (lang === '' && container !== pre) lang = headerLabel(textOutside(pre, container)) ?? ''
    const text = codeText(container)
    const marker = text.includes('```') ? '~~~~' : '```'
    return `${marker}${lang}\n${text}\n${marker}`
  }

  const renderTable = (table: Element): string => {
    const rows = [...table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr, :scope > tfoot > tr')].slice(0, 60)
    const matrix = rows.map((row) =>
      [...row.children].slice(0, 20).map((cell) => clean(flatten(cell)).replace(/\|/g, '\\|') || ' '),
    )
    if (matrix.length === 0) return ''
    const width = Math.max(...matrix.map((row) => row.length))
    const pad = (row: string[]): string[] => [...row, ...Array<string>(width - row.length).fill(' ')]
    const header = pad(matrix[0] ?? [])
    const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...matrix.slice(1).map((row) => `| ${pad(row).join(' | ')} |`)]
    return lines.join('\n')
  }

  const renderList = (list: Element): string => {
    const ordered = list.tagName === 'OL'
    let counter = Number(list.getAttribute('start') ?? '1') || 1
    const lines: string[] = []
    for (const item of [...list.children]) {
      if (outOfBudget()) break
      if (item.tagName !== 'LI' || isHidden(item)) continue
      const marker = ordered ? `${counter}.` : '-'
      counter += 1
      const body = renderChildren(item).join('\n')
      const itemLines = (body === '' ? '' : body).split('\n')
      itemLines.forEach((line, index) => lines.push(index === 0 ? `${marker} ${line}`.trimEnd() : `${' '.repeat(marker.length + 1)}${line}`))
    }
    return lines.join('\n')
  }

  /** Inline rendering: whatever the element contains, flattened to one line. */
  const flatten = (el: Element): string => renderChildren(el).join(' ')

  const inline = (el: Element): string => {
    const tag = el.tagName
    if (tag === 'BR') return '\n'
    if (tag === 'IMG') {
      const alt = clean(el.getAttribute('alt') ?? '')
      if (alt === '') return ''
      const src = el.getAttribute('src') ?? ''
      return src === '' || src.startsWith('data:') ? `![${alt}]` : `![${alt}](${scrubUrl(src)})`
    }
    if (page && (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || ((el as HTMLElement).isContentEditable === true && el.getAttribute('contenteditable') !== null))) {
      return controlToken(el)
    }
    if (!page && (isChromeControl(el) || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')) return ''
    const text = clean(flatten(el))
    if (tag === 'A' && el.hasAttribute('href')) {
      const href = scrubUrl((el as HTMLAnchorElement).href)
      const label = text !== '' ? text : clean(el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '')
      if (label === '') return page ? `[link](${href})${refTag(el)}` : ''
      return href.startsWith('javascript') || href === '' ? `${label}${page ? refTag(el) : ''}` : `[${label}](${href})${page ? refTag(el) : ''}`
    }
    if (page && (tag === 'BUTTON' || tag === 'SUMMARY' || (isInteractive(el) && tag !== 'A'))) {
      const label = text !== '' ? text : labelOf(el)
      const kind = tag === 'BUTTON' || tag === 'SUMMARY' ? 'button' : role(el) || 'control'
      const extra = el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' ? ' selected' : ''
      const expanded = el.getAttribute('aria-expanded')
      return `[${kind} "${clip(label, 120)}"${extra}${expanded !== null ? (expanded === 'true' ? ' expanded' : ' collapsed') : ''}${(el as HTMLButtonElement).disabled === true ? ' (disabled)' : ''}]${refTag(el)}`
    }
    if (text === '') return ''
    if (tag === 'STRONG' || tag === 'B') return `**${text}**`
    if (tag === 'EM' || tag === 'I') return `*${text}*`
    if (tag === 'DEL' || tag === 'S') return `~~${text}~~`
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
    return text
  }

  const isBlock = (el: Element): boolean => {
    if (BLOCK.has(el.tagName)) return true
    if (el.shadowRoot !== null) return true
    // A <pre> forces a block whatever the element is styled as (custom elements default to inline).
    if ((!page || el.tagName.includes('-')) && el.querySelector('pre') !== null) return true
    const display = typeof getComputedStyle === 'function' ? getComputedStyle(el).display : ''
    return display === 'block' || display === 'flex' || display === 'grid' || display === 'list-item' || display === 'table'
  }

  const block = (el: Element): string[] => {
    const tag = el.tagName
    if (/^H[1-6]$/.test(tag)) {
      const text = clean(flatten(el))
      return text === '' ? [] : [`${'#'.repeat(Number(tag[1]))} ${text}`]
    }
    if (tag === 'PRE') return [fence(el)]
    if (tag === 'UL' || tag === 'OL' || tag === 'MENU') {
      const list = renderList(el)
      return list === '' ? [] : [list]
    }
    if (tag === 'TABLE') {
      const table = renderTable(el)
      return table === '' ? [] : [table]
    }
    if (tag === 'HR') return ['---']
    if (tag === 'BLOCKQUOTE') {
      const inner = renderChildren(el).join('\n\n')
      return inner === '' ? [] : [inner.split('\n').map((line) => `> ${line}`).join('\n')]
    }
    if (page && isInteractive(el) && tag !== 'DETAILS') {
      const token = inline(el)
      return token === '' ? [] : [token]
    }
    if (!page) {
      const widget = codeWidget(el)
      if (widget !== null) return [fence(widget.pre, widget.label)]
    }
    return renderChildren(el)
  }

  function renderChildren(node: Node): string[] {
    const blocks: string[] = []
    let line = ''
    const flush = (): void => {
      const text = line
        .split('\n')
        .map((part) => part.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .trim()
      if (text !== '') blocks.push(text)
      line = ''
    }
    for (const child of childrenOf(node)) {
      if (outOfBudget()) break
      if (child.nodeType === Node.TEXT_NODE) {
        line += collapse(child.textContent ?? '')
        continue
      }
      if (!(child instanceof Element)) continue
      if (SKIP.has(child.tagName.toUpperCase()) || isHidden(child)) continue
      if (!page && isChromeControl(child)) continue
      if (isBlock(child) && !(child.tagName === 'A' && page)) {
        flush()
        blocks.push(...block(child))
      } else {
        const token = inline(child)
        if (token !== '') line += line !== '' && !/\s$/.test(line) && !/^[\s.,;:!?)]/.test(token) ? ` ${token}` : token
      }
    }
    flush()
    return blocks
  }

  // ---- entry ------------------------------------------------------------------------------
  let root: Element | null = null
  if (options.mode === 'element') {
    let matches: Element[] = []
    try {
      matches = options.selector !== undefined ? [...document.querySelectorAll(options.selector)] : []
    } catch {
      matches = []
    }
    root = matches.length > 0 ? (matches[options.index ?? matches.length - 1] ?? null) : null
  } else {
    root = options.scope === 'main' ? (document.querySelector('main, [role="main"], article') ?? document.body) : document.body
  }
  if (root === null) {
    return { found: false, markdown: '', blocks: [], title: document.title, url: page ? scrubUrl(location.href) : '', refCount: 0, nextIndex: state.next, truncated: false, sourceChars: 0 }
  }

  const blocks = block(root)
  let markdown = blocks.join('\n\n')
  if (markdown.length > options.maxChars) {
    markdown = `${markdown.slice(0, options.maxChars)}\n\n…[truncated: ${markdown.length - options.maxChars} more characters]`
    truncated = true
  } else if (truncated) {
    markdown += '\n\n…[truncated: page too large to walk completely]'
  }
  return {
    found: true,
    markdown,
    blocks,
    title: clip(document.title, 1000),
    url: page ? scrubUrl(location.href) : '',
    refCount: usedRefs.size,
    nextIndex: state.next,
    truncated,
    sourceChars: page ? (document.documentElement?.outerHTML.length ?? 0) : 0,
  }
}
