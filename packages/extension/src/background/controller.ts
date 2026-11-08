import {
  ConnectorError,
  EMPTY_TOTALS,
  isRestrictedUrl,
  normalizePairingCode,
  scrubUrl,
  targetIdForTab,
  toWireError,
  type ActivityEntry,
  type ActivityTotals,
  type BrowserState,
  type DaemonInfo,
  type ExtensionParams,
  type LlmEvent,
  type TabRole,
} from '@corsen-ai/shared'
import { DebuggerManager } from '../cdp/debugger-manager'
import { TrustedInput } from '../cdp/input'
import { IsolatedWorlds } from '../cdp/world'
import { HarnessDriver } from '../harnesses/driver'
import { detectHarness, hostOf } from '../harnesses/registry'
import { corsenPick } from '../inpage/picker'
import { performAction } from '../mcp-executor/actions'
import { DevtoolsFeed } from '../mcp-executor/devtools-feed'
import { NetworkTap } from '../mcp-executor/network-tap'
import { readPage } from '../mcp-executor/read-page'
import { RefRegistry } from '../mcp-executor/refs'
import { screenshot } from '../mcp-executor/screenshot'
import type { UiRequest, UiResponse, UiState, UiTab } from '../messages'
import { DaemonLink } from './daemon-link'
import { getSettings, loadRoles, patchSettings, saveRoles, setFlags, setHarnessOverride, type RoleRecord } from './storage'

const PICK_LABELS = { input: 'prompt input box', send: 'send button', stop: 'stop button', response: 'answer of the assistant (any previous answer)' } as const

/**
 * The service worker's brain: tab roles (fail closed), debugger sessions, the MCP executor, the
 * web-LLM driver, the daemon link, and the live state pushed to the daemon and to the UI.
 */
export class Controller {
  readonly debugger = new DebuggerManager()
  readonly worlds = new IsolatedWorlds(this.debugger)
  readonly input = new TrustedInput(this.debugger)
  readonly refs = new RefRegistry()
  readonly feed: DevtoolsFeed
  readonly tap: NetworkTap
  readonly driver: HarnessDriver
  readonly link: DaemonLink
  #roles = new Map<number, RoleRecord>()
  readonly #ready: Promise<void>
  readonly #navigations = new Map<number, number>()
  readonly #ports = new Set<chrome.runtime.Port>()
  #activity: ActivityEntry[] = []
  #totals: ActivityTotals = EMPTY_TOTALS
  #daemonInfo: DaemonInfo | null = null
  #pushTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.feed = new DevtoolsFeed(this.debugger, (tabId) => this.roleOf(tabId) === 'mcp', () => this.schedulePush())
    this.tap = new NetworkTap(this.debugger, this.feed, (tabId) => this.roleOf(tabId) === 'mcp')
    this.driver = new HarnessDriver({
      debugger: this.debugger,
      worlds: this.worlds,
      input: this.input,
      overrides: async () => (await getSettings()).harnessOverrides,
      onBusyChange: () => this.schedulePush(),
    })
    this.link = new DaemonLink(
      (method, params, io) => this.handleRpc(method, params, io),
      () => this.browserState(),
    )
    this.link.onChange((snapshot) => {
      if (snapshot.status === 'connected') void this.refreshDaemonInfo()
      else this.#daemonInfo = null
      this.schedulePush()
    })
    this.link.onActivity((entries, totals) => {
      for (const entry of entries) {
        const index = this.#activity.findIndex((item) => item.id === entry.id)
        if (index >= 0) this.#activity[index] = entry
        else this.#activity.push(entry)
      }
      if (this.#activity.length > 200) this.#activity.splice(0, this.#activity.length - 200)
      this.#totals = totals
      this.schedulePush(false)
    })
    this.debugger.onEvent((tabId, method, params) => {
      if (method === 'Page.frameNavigated' && (params['frame'] as { parentId?: string } | undefined)?.parentId === undefined) {
        this.#navigations.set(tabId, (this.#navigations.get(tabId) ?? 0) + 1)
      }
    })
    this.debugger.onDetach((tabId, reason) => {
      this.refs.forget(tabId)
      this.worlds.forget(tabId)
      // The user cancelled the "is debugging this browser" banner: respect it, the tab becomes private.
      if (reason === 'canceled_by_user' && this.#roles.delete(tabId)) void saveRoles(this.#roles)
      this.schedulePush()
    })
    this.#ready = loadRoles().then((roles) => {
      this.#roles = roles
    })
  }

  /** After a service-worker restart: drop roles of closed tabs and re-attach the others. */
  async init(): Promise<void> {
    await this.#ready
    for (const [tabId, record] of [...this.#roles]) {
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      if (tab === null || isRestrictedUrl(tab.url ?? '')) {
        this.#roles.delete(tabId)
        continue
      }
      await this.debugger.ensure(tabId, record.role).catch(() => this.#roles.delete(tabId))
    }
    await saveRoles(this.#roles)
    await this.link.ensureConnected()
    this.schedulePush()
  }

  roleOf(tabId: number): TabRole {
    return this.#roles.get(tabId)?.role ?? 'ignored'
  }

  async setRole(tabId: number, role: TabRole): Promise<void> {
    await this.#ready
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (tab === null) throw new ConnectorError('TAB_GONE', `tab ${tabId} does not exist`)
    const previous = this.roleOf(tabId)
    if (role !== 'ignored') {
      if (isRestrictedUrl(tab.url ?? '')) throw new ConnectorError('RESTRICTED_PAGE', 'Chrome does not allow extensions to control this page.')
      if (role === 'brain' && detectHarness(tab.url ?? '', (await getSettings()).harnessOverrides) === null) {
        throw new ConnectorError('INVALID_ARGUMENT', `${hostOf(tab.url ?? '')} is not a known chat. Calibrate it first (Tab Manager › Calibrate).`)
      }
    }
    if (previous === role) return
    if (previous !== 'ignored') await this.debugger.release(tabId, previous)
    this.feed.forget(tabId)
    this.tap.forget(tabId)
    if (role === 'ignored') {
      this.#roles.delete(tabId)
    } else {
      await this.debugger.ensure(tabId, role)
      this.#roles.set(tabId, { role, setAt: Date.now() })
    }
    await saveRoles(this.#roles)
    this.schedulePush()
  }

  async panic(): Promise<number> {
    const detached = await this.debugger.detachAll()
    this.#roles.clear()
    await saveRoles(this.#roles)
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id === undefined) continue
      this.feed.forget(tab.id)
      this.tap.forget(tab.id)
      this.refs.forget(tab.id)
    }
    this.schedulePush()
    return detached
  }

  async forgetTab(tabId: number): Promise<void> {
    if (this.#roles.delete(tabId)) await saveRoles(this.#roles)
    this.feed.forget(tabId)
    this.tap.forget(tabId)
    this.refs.forget(tabId)
    this.#navigations.delete(tabId)
    this.schedulePush()
  }

  async #requireRole(tabId: number, role: 'brain' | 'mcp'): Promise<void> {
    await this.#ready
    if (this.roleOf(tabId) !== role) {
      throw new ConnectorError('NO_TARGET', role === 'mcp' ? `tab ${tabId} is not exposed to MCP` : `tab ${tabId} is not an LLM Brain`)
    }
    await this.debugger.ensure(tabId, role)
  }

  /** Daemon → extension RPC dispatcher (params already validated against the shared contract). */
  async handleRpc(method: string, params: unknown, io: { signal: AbortSignal; emit: (event: unknown) => void }): Promise<unknown> {
    switch (method) {
      case 'targets.list': {
        await this.#ready
        const targets = []
        for (const [tabId, record] of this.#roles) {
          if (record.role !== 'mcp') continue
          const tab = await chrome.tabs.get(tabId).catch(() => null)
          if (tab === null) continue
          const counts = this.feed.counts(tabId)
          targets.push({ targetId: targetIdForTab(tabId), title: (tab.title ?? '').slice(0, 500), url: scrubUrl(tab.url ?? ''), consoleErrors: counts.console, networkErrors: counts.network, active: tab.active === true })
        }
        return { targets }
      }
      case 'page.read': {
        const p = params as ExtensionParams<'page.read'>
        await this.#requireRole(p.tabId, 'mcp')
        return readPage(this, p)
      }
      case 'page.act': {
        const p = params as ExtensionParams<'page.act'>
        await this.#requireRole(p.tabId, 'mcp')
        return performAction({ debugger: this.debugger, worlds: this.worlds, input: this.input, refs: this.refs, navigations: (tabId) => this.#navigations.get(tabId) ?? 0 }, p.tabId, p.act)
      }
      case 'devtools.errors': {
        const p = params as ExtensionParams<'devtools.errors'>
        await this.#requireRole(p.tabId, 'mcp')
        return this.feed.query(p.tabId, p)
      }
      case 'network.capture': {
        const p = params as ExtensionParams<'network.capture'>
        await this.#requireRole(p.tabId, 'mcp')
        return this.tap.query(p.tabId, p)
      }
      case 'page.screenshot': {
        const p = params as ExtensionParams<'page.screenshot'>
        await this.#requireRole(p.tabId, 'mcp')
        return screenshot(this.debugger, p)
      }
      case 'llm.generate': {
        const p = params as ExtensionParams<'llm.generate'>
        await this.#requireRole(p.tabId, 'brain')
        return this.driver.generate(p, { signal: io.signal, emit: (event: LlmEvent) => io.emit(event) })
      }
      case 'tabs.setRole': {
        const p = params as ExtensionParams<'tabs.setRole'>
        await this.setRole(p.tabId, p.role)
        return { tab: (await this.browserState()).tabs.find((tab) => tab.tabId === p.tabId) ?? null }
      }
      case 'system.panic':
        return { detached: await this.panic() }
      case 'system.echo':
        return { nonce: (params as { nonce: string }).nonce, extensionVersion: chrome.runtime.getManifest().version }
      default:
        throw new ConnectorError('UNSUPPORTED', `unknown method ${method}`)
    }
  }

  async browserState(): Promise<BrowserState> {
    await this.#ready
    const all = await chrome.tabs.query({})
    const overrides = (await getSettings()).harnessOverrides
    const tabs = []
    for (const tab of all) {
      if (tab.id === undefined) continue
      const record = this.#roles.get(tab.id)
      if (record === undefined) continue
      const counts = this.feed.counts(tab.id)
      tabs.push({
        tabId: tab.id,
        windowId: tab.windowId,
        title: (tab.title ?? '').slice(0, 500),
        url: scrubUrl(tab.url ?? '').slice(0, 2048),
        role: record.role,
        harnessId: record.role === 'brain' ? detectHarness(tab.url ?? '', overrides) : null,
        attached: this.debugger.isAttached(tab.id),
        busy: this.driver.isBusy(tab.id),
        consoleErrors: counts.console,
        networkErrors: counts.network,
        active: tab.active === true,
      })
    }
    return {
      extensionVersion: chrome.runtime.getManifest().version,
      browserName: 'Chrome',
      tabs,
      hiddenTabCount: all.length - tabs.length,
      updatedAt: Date.now(),
    }
  }

  async uiState(): Promise<UiState> {
    await this.#ready
    const settings = await getSettings()
    const tabs: UiTab[] = []
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id === undefined) continue
      const url = tab.url ?? ''
      const counts = this.feed.counts(tab.id)
      tabs.push({
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title ?? '',
        url,
        host: hostOf(url),
        favIconUrl: tab.favIconUrl?.startsWith('https://') === true || tab.favIconUrl?.startsWith('data:image/') === true ? tab.favIconUrl : '',
        role: this.roleOf(tab.id),
        harnessId: detectHarness(url, settings.harnessOverrides),
        restricted: isRestrictedUrl(url),
        attached: this.debugger.isAttached(tab.id),
        busy: this.driver.isBusy(tab.id),
        consoleErrors: counts.console,
        networkErrors: counts.network,
        active: tab.active === true,
      })
    }
    const snapshot = this.link.snapshot()
    return {
      version: chrome.runtime.getManifest().version,
      link: { ...snapshot, paired: settings.pairingSecret !== '' },
      tabs,
      activity: [...this.#activity].reverse().slice(0, 100),
      totals: this.#totals,
      daemon: this.#daemonInfo,
      calibrations: settings.harnessOverrides,
    }
  }

  async refreshDaemonInfo(): Promise<void> {
    try {
      this.#daemonInfo = await this.link.call('daemon.info', {})
      const recent = await this.link.call('activity.recent', { limit: 100 })
      this.#activity = [...recent.entries]
      this.#totals = recent.totals
    } catch {
      this.#daemonInfo = null
    }
    this.schedulePush(false)
  }

  addPort(port: chrome.runtime.Port): void {
    this.#ports.add(port)
    port.onDisconnect.addListener(() => this.#ports.delete(port))
    void this.uiState().then((state) => port.postMessage({ type: 'state', state }))
  }

  /** Debounced push of the state to the daemon (optional) and to every open UI. */
  schedulePush(toDaemon = true): void {
    if (this.#pushTimer !== null) clearTimeout(this.#pushTimer)
    this.#pushTimer = setTimeout(() => {
      this.#pushTimer = null
      if (toDaemon) void this.link.pushState()
      if (this.#ports.size > 0) {
        void this.uiState().then((state) => {
          for (const port of this.#ports) port.postMessage({ type: 'state', state })
        })
      }
    }, 120)
  }

  async calibrate(tabId: number, kind: keyof typeof PICK_LABELS): Promise<unknown> {
    const tab = await chrome.tabs.get(tabId)
    if (isRestrictedUrl(tab.url ?? '')) throw new ConnectorError('RESTRICTED_PAGE', 'Chrome does not allow extensions to control this page.')
    await chrome.tabs.update(tabId, { active: true })
    await this.debugger.ensure(tabId, 'brain')
    try {
      const pick = await this.worlds.call(tabId, corsenPick, [{ kind, label: PICK_LABELS[kind], timeoutMs: 60_000 }])
      if (pick === null) throw new ConnectorError('CANCELLED', 'calibration cancelled')
      await setHarnessOverride(hostOf(tab.url ?? ''), { [kind]: pick.selector })
      this.schedulePush()
      return pick
    } finally {
      if (this.roleOf(tabId) !== 'brain') await this.debugger.release(tabId, 'brain')
    }
  }

  /** Requests from the popup and the side panel. */
  async handleUi(request: UiRequest): Promise<UiResponse> {
    try {
      switch (request.type) {
        case 'getState':
          return { ok: true, result: await this.uiState() }
        case 'setRole':
          await this.setRole(request.tabId, request.role)
          return { ok: true, result: await this.uiState() }
        case 'setPairing': {
          const secret = normalizePairingCode(request.code)
          if (secret === '') return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'That is not a valid pairing code (5 groups of 4 characters).' } }
          this.link.disconnect('connecting')
          await patchSettings({ pairingSecret: secret, ...(request.port !== undefined ? { port: request.port } : {}) })
          await setFlags({ superseded: false })
          await this.link.ensureConnected({ takeover: true })
          return { ok: true, result: await this.uiState() }
        }
        case 'forgetPairing':
          this.link.disconnect('unpaired', 'Pairing removed.')
          await patchSettings({ pairingSecret: '' })
          return { ok: true, result: await this.uiState() }
        case 'reconnect':
          this.link.disconnect('connecting')
          await this.link.ensureConnected({ takeover: request.takeover })
          return { ok: true, result: await this.uiState() }
        case 'daemonCall': {
          const result = await this.link.call(request.method, request.params as never, request.method === 'daemon.selftest' ? 60_000 : 30_000)
          if (request.method.startsWith('agents.')) void this.refreshDaemonInfo()
          return { ok: true, result }
        }
        case 'panic':
          return { ok: true, result: { detached: await this.panic() } }
        case 'calibrate':
          return { ok: true, result: await this.calibrate(request.tabId, request.kind) }
        case 'clearCalibration':
          await setHarnessOverride(request.host, null)
          this.schedulePush()
          return { ok: true, result: await this.uiState() }
      }
    } catch (error) {
      const wire = toWireError(error)
      return { ok: false, error: { code: wire.code, message: wire.message } }
    }
  }
}
