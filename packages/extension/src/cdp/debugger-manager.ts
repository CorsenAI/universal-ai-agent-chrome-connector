import type ProtocolMapping from 'devtools-protocol/types/protocol-mapping'
import { ConnectorError } from '@corsen-ai/shared'

type Commands = ProtocolMapping.Commands
export type CdpMethod = keyof Commands
export type CdpParams<M extends CdpMethod> = Commands[M]['paramsType'] extends [] ? undefined : Commands[M]['paramsType'][0]
export type CdpResult<M extends CdpMethod> = Commands[M]['returnType']

export type Purpose = 'brain' | 'mcp'
export type EventListener = (tabId: number, method: string, params: Record<string, unknown>) => void
export type DetachListener = (tabId: number, reason: string) => void

interface Attachment {
  readonly purposes: Set<Purpose>
  readonly enabled: Set<string>
  dialogSeq: number
  lastDialog: { type: string; message: string } | null
}

const PROTOCOL_VERSION = '1.3'

function mapError(error: unknown, tabId: number): ConnectorError {
  const message = error instanceof Error ? error.message : String(error)
  if (/No tab with given id|No target with given id|target closed/i.test(message)) return new ConnectorError('TAB_GONE', `tab ${tabId} no longer exists`)
  if (/Another debugger is already attached/i.test(message)) {
    return new ConnectorError('DEBUGGER_DENIED', 'DevTools or another extension is already debugging this tab; close it and retry.')
  }
  if (/Cannot access|Cannot attach|chrome:\/\/|chrome-extension:\/\/|webstore/i.test(message)) return new ConnectorError('RESTRICTED_PAGE', 'Chrome does not allow extensions to control this page.')
  if (/Debugger is not attached/i.test(message)) return new ConnectorError('DEBUGGER_DENIED', 'the debugger session was closed; set the tab role again')
  return new ConnectorError('ACTION_FAILED', message.slice(0, 500))
}

/**
 * Owns every chrome.debugger session (protocol 1.3). A tab is attached only while it has a role;
 * sessions are reused across calls and shared by purposes. Listeners are registered once at module
 * load (top level of the service worker), as MV3 requires.
 *
 * Proven details reused from Corsen Hermes Connector: focus emulation (otherwise CDP input is dropped
 * on unfocused windows) and automatic JS dialog handling (alert/beforeunload accepted, confirm/prompt
 * cancelled and reported, so an action never "succeeds" behind a dialog it caused).
 */
export class DebuggerManager {
  readonly #attached = new Map<number, Attachment>()
  readonly #pending = new Map<number, Promise<void>>()
  readonly #events = new Set<EventListener>()
  readonly #detaches = new Set<DetachListener>()

  constructor() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      const tabId = source.tabId
      if (tabId === undefined || !this.#attached.has(tabId)) return
      const payload = (params ?? {}) as Record<string, unknown>
      if (method === 'Page.javascriptDialogOpening') this.#onDialog(tabId, payload)
      for (const listener of this.#events) {
        try {
          listener(tabId, method, payload)
        } catch {
          // one broken consumer must not stop the others
        }
      }
    })
    chrome.debugger.onDetach.addListener((source, reason) => {
      const tabId = source.tabId
      if (tabId === undefined || !this.#attached.has(tabId)) return
      this.#attached.delete(tabId)
      for (const listener of this.#detaches) listener(tabId, reason)
    })
  }

  isAttached(tabId: number): boolean {
    return this.#attached.has(tabId)
  }

  attachedTabs(): number[] {
    return [...this.#attached.keys()]
  }

  onEvent(listener: EventListener): () => void {
    this.#events.add(listener)
    return () => this.#events.delete(listener)
  }

  onDetach(listener: DetachListener): () => void {
    this.#detaches.add(listener)
    return () => this.#detaches.delete(listener)
  }

  /** Attach (or reuse) the session and enable the domains this purpose needs. */
  async ensure(tabId: number, purpose: Purpose): Promise<void> {
    const inFlight = this.#pending.get(tabId)
    if (inFlight !== undefined) await inFlight.catch(() => undefined)
    let attachment = this.#attached.get(tabId)
    if (attachment === undefined) {
      const attaching = (async () => {
        try {
          await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION)
        } catch (error) {
          throw mapError(error, tabId)
        }
        this.#attached.set(tabId, { purposes: new Set(), enabled: new Set(), dialogSeq: 0, lastDialog: null })
      })()
      this.#pending.set(tabId, attaching)
      try {
        await attaching
      } finally {
        this.#pending.delete(tabId)
      }
      attachment = this.#attached.get(tabId)
      if (attachment === undefined) throw new ConnectorError('DEBUGGER_DENIED', 'the debugger detached immediately')
    }
    attachment.purposes.add(purpose)
    const domains = purpose === 'mcp' ? ['Page', 'Runtime', 'Log', 'Network'] : ['Page', 'Runtime']
    for (const domain of domains) {
      if (attachment.enabled.has(domain)) continue
      const params = domain === 'Network' ? { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024 } : undefined
      await this.#raw(tabId, `${domain}.enable`, params)
      attachment.enabled.add(domain)
    }
    if (!attachment.enabled.has('focus')) {
      await this.#raw(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
      attachment.enabled.add('focus')
    }
  }

  /** Enable an extra domain lazily (DOM, Accessibility). */
  async enable(tabId: number, domain: 'DOM' | 'Accessibility'): Promise<void> {
    const attachment = this.#attached.get(tabId)
    if (attachment === undefined) throw new ConnectorError('DEBUGGER_DENIED', 'the tab is not attached')
    if (attachment.enabled.has(domain)) return
    await this.#raw(tabId, `${domain}.enable`, undefined)
    attachment.enabled.add(domain)
  }

  async release(tabId: number, purpose: Purpose): Promise<void> {
    const attachment = this.#attached.get(tabId)
    if (attachment === undefined) return
    attachment.purposes.delete(purpose)
    if (attachment.purposes.size === 0) await this.detach(tabId)
  }

  async detach(tabId: number): Promise<void> {
    if (!this.#attached.has(tabId)) return
    this.#attached.delete(tabId)
    try {
      await chrome.debugger.detach({ tabId })
    } catch {
      // already gone
    }
    for (const listener of this.#detaches) listener(tabId, 'released')
  }

  async detachAll(): Promise<number> {
    const tabs = this.attachedTabs()
    for (const tabId of tabs) await this.detach(tabId)
    return tabs.length
  }

  /** Typed CDP command on an attached tab. */
  async send<M extends CdpMethod>(tabId: number, method: M, ...params: CdpParams<M> extends undefined ? [] : [CdpParams<M>]): Promise<CdpResult<M>> {
    if (!this.#attached.has(tabId)) throw new ConnectorError('DEBUGGER_DENIED', 'the tab is not attached; set its role again')
    return (await this.#raw(tabId, method, params[0] as object | undefined)) as CdpResult<M>
  }

  dialogSeq(tabId: number): number {
    return this.#attached.get(tabId)?.dialogSeq ?? 0
  }

  /** A confirm/prompt the manager cancelled after `seq`, if any. */
  dialogSince(tabId: number, seq: number): { type: string; message: string } | null {
    const attachment = this.#attached.get(tabId)
    return attachment !== undefined && attachment.dialogSeq > seq ? attachment.lastDialog : null
  }

  async #raw(tabId: number, method: string, params: object | undefined): Promise<unknown> {
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params)
    } catch (error) {
      throw mapError(error, tabId)
    }
  }

  #onDialog(tabId: number, params: Record<string, unknown>): void {
    const type = typeof params['type'] === 'string' ? params['type'] : 'alert'
    const accept = type === 'alert' || type === 'beforeunload'
    void this.#raw(tabId, 'Page.handleJavaScriptDialog', { accept, promptText: '' }).catch(() => undefined)
    if (!accept) {
      const attachment = this.#attached.get(tabId)
      if (attachment !== undefined) {
        attachment.dialogSeq += 1
        attachment.lastDialog = { type, message: String(params['message'] ?? '').slice(0, 300) }
      }
    }
  }
}
