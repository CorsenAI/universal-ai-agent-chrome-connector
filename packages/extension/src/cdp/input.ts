import { ConnectorError } from '@corsen-ai/shared'
import type { DebuggerManager } from './debugger-manager'
import { parseKeyCombo, selectAllStroke, type KeyStroke } from './keys'

let platformPromise: Promise<'mac' | 'other'> | null = null

export function platformKind(): Promise<'mac' | 'other'> {
  platformPromise ??= chrome.runtime.getPlatformInfo().then((info) => (info.os === 'mac' ? 'mac' : 'other'))
  return platformPromise
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Trusted input through CDP `Input.*` (events are `isTrusted`, like a real user). Every action that
 * may open a JS dialog checks afterwards whether the debugger manager had to cancel a confirm/prompt
 * and then fails, instead of reporting a success that did not happen.
 */
export class TrustedInput {
  readonly #debugger: DebuggerManager

  constructor(manager: DebuggerManager) {
    this.#debugger = manager
  }

  #failIfDialog(tabId: number, before: number): void {
    const dialog = this.#debugger.dialogSince(tabId, before)
    if (dialog !== null) throw new ConnectorError('ACTION_FAILED', `the page opened a ${dialog.type} dialog ("${dialog.message}") that was cancelled for safety`, { dialog })
  }

  async click(tabId: number, x: number, y: number, clickCount = 1): Promise<void> {
    const before = this.#debugger.dialogSeq(tabId)
    await this.#debugger.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    // Press and release are queued back to back so a failure cannot leave the button stuck down.
    await Promise.all([
      this.#debugger.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount }),
      this.#debugger.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount }),
    ])
    await settle()
    this.#failIfDialog(tabId, before)
  }

  async hover(tabId: number, x: number, y: number): Promise<void> {
    await this.#debugger.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  }

  async wheel(tabId: number, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.#debugger.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
    await settle(120)
  }

  async stroke(tabId: number, stroke: KeyStroke): Promise<void> {
    const before = this.#debugger.dialogSeq(tabId)
    const base = { key: stroke.key, code: stroke.code, windowsVirtualKeyCode: stroke.windowsVirtualKeyCode, nativeVirtualKeyCode: stroke.windowsVirtualKeyCode, modifiers: stroke.modifiers }
    await this.#debugger.send(tabId, 'Input.dispatchKeyEvent', { type: stroke.text !== undefined ? 'keyDown' : 'rawKeyDown', ...base, ...(stroke.text !== undefined ? { text: stroke.text, unmodifiedText: stroke.text } : {}) })
    await this.#debugger.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await settle()
    this.#failIfDialog(tabId, before)
  }

  async press(tabId: number, combo: string): Promise<void> {
    let stroke: KeyStroke
    try {
      stroke = parseKeyCombo(combo, await platformKind())
    } catch (error) {
      throw new ConnectorError('INVALID_ARGUMENT', (error as Error).message)
    }
    await this.stroke(tabId, stroke)
  }

  async selectAll(tabId: number): Promise<void> {
    await this.stroke(tabId, selectAllStroke(await platformKind()))
  }

  /** Type text into the focused element (replaces the selection). */
  async insertText(tabId: number, text: string): Promise<void> {
    const before = this.#debugger.dialogSeq(tabId)
    await this.#debugger.send(tabId, 'Input.insertText', { text })
    await settle()
    this.#failIfDialog(tabId, before)
  }
}
