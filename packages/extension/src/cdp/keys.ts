/**
 * Key descriptions for CDP `Input.dispatchKeyEvent`. Named keys follow the DOM `key` values; the
 * modifier bit mask is Alt=1, Ctrl=2, Meta=4, Shift=8 (CDP Input domain). Pure.
 * Key table ported from Corsen AI Hermes Connector v0.2.4 (`extension/src/cdp.js`), extended.
 */

export interface KeyStroke {
  readonly key: string
  readonly code: string
  readonly windowsVirtualKeyCode: number
  readonly text?: string
  readonly modifiers: number
}

const NAMED: Readonly<Record<string, { code: string; vk: number; text?: string }>> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  PageDown: { code: 'PageDown', vk: 34 },
  PageUp: { code: 'PageUp', vk: 33 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  Space: { code: 'Space', vk: 32, text: ' ' },
  ' ': { code: 'Space', vk: 32, text: ' ' },
  F5: { code: 'F5', vk: 116 },
}

const ALIASES: Readonly<Record<string, string>> = { esc: 'Escape', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: 'Space' }

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const

/** Parse "Control+Shift+K", "Enter", "a" into one keystroke; throws on an empty or unknown key. */
export function parseKeyCombo(combo: string, platform: 'mac' | 'other'): KeyStroke {
  const parts = combo.split('+').map((part) => part.trim()).filter((part) => part !== '')
  const last = parts.pop()
  if (last === undefined) throw new Error('empty key')
  let modifiers = 0
  for (const raw of parts) {
    const name = raw.toLowerCase()
    if (name === 'alt' || name === 'option') modifiers |= MODIFIER_BITS.Alt
    else if (name === 'control' || name === 'ctrl') modifiers |= MODIFIER_BITS.Control
    else if (name === 'meta' || name === 'cmd' || name === 'command') modifiers |= MODIFIER_BITS.Meta
    else if (name === 'shift') modifiers |= MODIFIER_BITS.Shift
    else if (name === 'mod' || name === 'controlormeta') modifiers |= platform === 'mac' ? MODIFIER_BITS.Meta : MODIFIER_BITS.Control
    else throw new Error(`unknown modifier "${raw}"`)
  }
  const keyName = ALIASES[last.toLowerCase()] ?? last
  const named = NAMED[keyName]
  if (named !== undefined) {
    return { key: keyName === 'Space' ? ' ' : keyName, code: named.code, windowsVirtualKeyCode: named.vk, ...(named.text !== undefined && (modifiers & ~MODIFIER_BITS.Shift) === 0 ? { text: named.text } : {}), modifiers }
  }
  if ([...keyName].length === 1) {
    const char = keyName
    const upper = char.toUpperCase()
    const isLetter = /^[a-z]$/i.test(char)
    const isDigit = /^[0-9]$/.test(char)
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${char}` : ''
    const vk = isLetter || isDigit ? upper.charCodeAt(0) : 0
    const printable = (modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt)) === 0
    return { key: char, code, windowsVirtualKeyCode: vk, ...(printable ? { text: (modifiers & MODIFIER_BITS.Shift) !== 0 ? upper : char } : {}), modifiers }
  }
  if (/^F\d{1,2}$/.test(keyName)) return { key: keyName, code: keyName, windowsVirtualKeyCode: 111 + Number(keyName.slice(1)), modifiers }
  throw new Error(`unknown key "${last}"`)
}

/** Select-all is Cmd+A on macOS and Ctrl+A elsewhere (a wrong modifier silently appends instead of replacing). */
export function selectAllStroke(platform: 'mac' | 'other'): KeyStroke {
  return parseKeyCombo(platform === 'mac' ? 'Meta+a' : 'Control+a', platform)
}
