import type Protocol from 'devtools-protocol'
import { MASK, SECRET_FIELD_FRAGMENTS } from '@corsen-ai/shared'

/**
 * Compact accessibility tree (CDP `Accessibility.getFullAXTree`) for agents: interactive controls get
 * a `[ref=eN]`, landmarks and headings give structure, generic wrappers are transparent. Pure.
 */

type AXNode = Protocol.Accessibility.AXNode

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'listbox', 'textField', 'TextField', 'PopUpButton', 'ToggleButton',
])
const STRUCTURAL = new Set([
  'heading', 'dialog', 'alertdialog', 'alert', 'navigation', 'main', 'banner', 'contentinfo', 'form', 'region', 'search', 'tablist',
  'menu', 'menubar', 'table', 'row', 'cell', 'columnheader', 'rowheader', 'list', 'listitem', 'img', 'image', 'figure', 'article', 'status',
  'paragraph', 'complementary', 'tree', 'grid', 'group', 'toolbar',
])
const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'GenericContainer', 'Section', 'Pre', 'LabelText', 'superscript', 'subscript'])
const TEXT = new Set(['StaticText', 'text'])

function axString(value: Protocol.Accessibility.AXValue | undefined): string {
  if (value === undefined || value.value === undefined || value.value === null) return ''
  return String(value.value).replace(/\s+/g, ' ').trim()
}

function property(node: AXNode, name: string): unknown {
  return node.properties?.find((prop) => prop.name === name)?.value.value
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export interface AxFormatResult {
  readonly text: string
  readonly refCount: number
  readonly truncated: boolean
}

/**
 * @param mintRef returns the ref for a backend DOM node (stable per node), e.g. "e12".
 */
export function formatAxTree(nodes: readonly AXNode[], mintRef: (backendNodeId: number) => string, maxChars: number): AxFormatResult {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const root = nodes.find((node) => node.parentId === undefined) ?? nodes[0]
  const lines: string[] = []
  let size = 0
  let refCount = 0
  let truncated = false

  const push = (depth: number, line: string): void => {
    if (truncated) return
    const text = `${'  '.repeat(depth)}- ${line}`
    if (size + text.length + 1 > maxChars) {
      truncated = true
      return
    }
    lines.push(text)
    size += text.length + 1
  }

  const visit = (node: AXNode, depth: number, parentName: string): void => {
    if (truncated) return
    const role = axString(node.role)
    const name = axString(node.name)
    let childDepth = depth
    let nextParentName = parentName
    if (!node.ignored) {
      if (role === 'RootWebArea' || role === 'WebArea') {
        push(depth, `page "${clip(name, 200)}"`)
        childDepth = depth + 1
      } else if (INTERACTIVE.has(role)) {
        const states: string[] = []
        if (property(node, 'disabled') === true) states.push('disabled')
        const checked = property(node, 'checked')
        if (checked === true || checked === 'true') states.push('checked')
        if (checked === 'mixed') states.push('mixed')
        const expanded = property(node, 'expanded')
        if (expanded === true) states.push('expanded')
        if (expanded === false) states.push('collapsed')
        if (property(node, 'selected') === true) states.push('selected')
        if (property(node, 'required') === true) states.push('required')
        if (property(node, 'focused') === true) states.push('focused')
        let value = axString(node.value)
        if (value !== '' && SECRET_FIELD_FRAGMENTS.some((fragment) => name.toLowerCase().includes(fragment))) value = MASK
        const ref = node.backendDOMNodeId !== undefined ? ` [ref=${mintRef(node.backendDOMNodeId)}]` : ''
        if (ref !== '') refCount += 1
        push(depth, `${role}${name !== '' ? ` "${clip(name, 160)}"` : ''}${value !== '' ? ` = "${clip(value, 200)}"` : ''}${states.length > 0 ? ` (${states.join(', ')})` : ''}${ref}`)
        nextParentName = name
        // Children of a control repeat its name; skip them.
        return
      } else if (TEXT.has(role)) {
        if (name !== '' && name !== parentName) push(depth, `text "${clip(name, 300)}"`)
        return
      } else if (STRUCTURAL.has(role)) {
        const level = property(node, 'level')
        const interesting = name !== '' || role === 'heading' || role === 'dialog' || role === 'main' || role === 'navigation' || role === 'form' || role === 'table' || role === 'list'
        if (interesting) {
          push(depth, `${role}${name !== '' ? ` "${clip(name, 200)}"` : ''}${typeof level === 'number' ? ` [level=${level}]` : ''}`)
          childDepth = depth + 1
          nextParentName = name
        }
      } else if (!TRANSPARENT.has(role) && name !== '' && name !== parentName) {
        push(depth, `${role} "${clip(name, 200)}"`)
        childDepth = depth + 1
        nextParentName = name
      }
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child !== undefined) visit(child, childDepth, nextParentName)
      if (truncated) return
    }
  }

  if (root !== undefined) visit(root, 0, '')
  if (truncated) lines.push('- …[truncated: raise max_chars]')
  return { text: lines.join('\n'), refCount, truncated }
}
