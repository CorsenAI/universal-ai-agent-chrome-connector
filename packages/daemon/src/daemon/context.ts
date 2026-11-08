import { randomUUID } from 'node:crypto'
import {
  DAEMON_METHODS,
  LIMITS,
  MCP_PATH,
  PROTOCOL_VERSION,
  VERSION,
  type DaemonInfo,
  type DaemonMethod,
} from '@corsen-ai/shared'
import { ActivityLog } from '../activity/activity-log'
import type { Credentials } from '../auth/credentials'
import { DashboardSessions } from '../auth/dashboard-sessions'
import type { AgentConfigurator } from '../agent-configurator/configurator'
import { BrainRouter } from '../llm-gateway/brain-router'
import { McpToolExecutor } from '../mcp-server/executor'
import type { Logger } from '../util/logger'
import { BrowserHub } from '../ws-hub/hub'

export interface DaemonContextOptions {
  readonly port: number
  readonly credentials: () => Credentials
  readonly logger: Logger
  readonly configurator: AgentConfigurator
  readonly allowedApiOrigins?: readonly string[]
  readonly extraAllowedHosts?: readonly string[]
}

/** Every long-lived service of one daemon process, wired together. */
export class DaemonContext {
  readonly port: number
  readonly startedAt = Date.now()
  readonly logger: Logger
  readonly activity = new ActivityLog()
  readonly sessions = new DashboardSessions()
  readonly hub: BrowserHub
  readonly router: BrainRouter
  readonly executor: McpToolExecutor
  readonly configurator: AgentConfigurator
  readonly allowedApiOrigins: readonly string[]
  readonly extraAllowedHosts: readonly string[]
  readonly #credentials: () => Credentials

  constructor(options: DaemonContextOptions) {
    this.port = options.port
    this.logger = options.logger
    this.configurator = options.configurator
    this.allowedApiOrigins = options.allowedApiOrigins ?? []
    this.extraAllowedHosts = options.extraAllowedHosts ?? []
    this.#credentials = options.credentials
    this.hub = new BrowserHub({
      secret: () => this.#credentials().pairingSecret,
      logger: this.logger,
      activity: this.activity,
      handleDaemonRpc: (method, params, signal) => this.handleExtensionRpc(method, params, signal),
    })
    this.router = new BrainRouter(this.hub, this.logger)
    this.executor = new McpToolExecutor(this.hub, this.activity, this.logger)
    this.activity.subscribe((entry, totals) => this.hub.pushActivity(entry, totals))
  }

  get apiToken(): string {
    return this.#credentials().apiToken
  }

  get pairingSecret(): string {
    return this.#credentials().pairingSecret
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  info(): DaemonInfo {
    return {
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      port: this.port,
      apiBaseUrl: `${this.baseUrl()}/v1`,
      anthropicBaseUrl: this.baseUrl(),
      mcpUrl: `${this.baseUrl()}${MCP_PATH}`,
      apiToken: this.apiToken,
      dashboardUrl: `${this.baseUrl()}/login?code=${this.sessions.createLoginCode()}`,
      models: this.router.listModels().map((model) => model.id),
    }
  }

  /** End-to-end bridge test: daemon → extension round trip, MCP target listing, LLM model listing. */
  async selftest(): Promise<{ ok: boolean; steps: Array<{ name: string; ok: boolean; ms: number; detail: string }> }> {
    const steps: Array<{ name: string; ok: boolean; ms: number; detail: string }> = []
    const step = async (name: string, run: () => Promise<string>): Promise<void> => {
      const started = performance.now()
      try {
        const detail = await run()
        steps.push({ name, ok: true, ms: Math.round(performance.now() - started), detail })
      } catch (error) {
        steps.push({ name, ok: false, ms: Math.round(performance.now() - started), detail: (error as Error).message.slice(0, 500) })
      }
    }
    await step('Daemon ↔ extension round trip', async () => {
      const nonce = randomUUID().slice(0, 16)
      const echo = await this.hub.call('system.echo', { nonce }, { timeoutMs: 10_000 })
      if (echo.nonce !== nonce) throw new Error('echo mismatch')
      return `extension ${echo.extensionVersion} answered`
    })
    await step('MCP targets', async () => {
      const { targets } = await this.hub.call('targets.list', {}, { timeoutMs: 10_000 })
      return targets.length === 0 ? 'no tab exposed yet (choose "Expose to MCP" on a tab)' : `${targets.length} exposed tab(s)`
    })
    await step('LLM brains', async () => {
      const brains = this.router.brains()
      return brains.length === 0 ? 'no LLM Brain tab yet (choose "Use as LLM" on a chat tab)' : `${brains.length} brain tab(s): ${brains.map((tab) => tab.harnessId).join(', ')}`
    })
    this.activity.note('system', 'Bridge self-test', steps.every((item) => item.ok) ? 'ok' : 'error', steps.map((item) => `${item.ok ? '✓' : '✗'} ${item.name}`).join(' · '))
    return { ok: steps.every((item) => item.ok), steps }
  }

  /** Requests the side panel / popup send through the extension link. */
  async handleExtensionRpc(method: string, params: unknown, _signal: AbortSignal): Promise<unknown> {
    const name = method as DaemonMethod
    const contract = DAEMON_METHODS[name]
    let result: unknown
    switch (name) {
      case 'daemon.info':
        result = this.info()
        break
      case 'daemon.selftest':
        result = await this.selftest()
        break
      case 'agents.list':
        result = { agents: this.configurator.list() }
        break
      case 'agents.connect':
      case 'agents.unlink':
      case 'agents.restore': {
        const { agentId } = params as { agentId: Parameters<AgentConfigurator['connect']>[0] }
        const finish = this.activity.start({ kind: 'agent', title: `${name.split('.')[1] ?? name} ${agentId}` })
        try {
          result =
            name === 'agents.connect' ? await this.configurator.connect(agentId) : name === 'agents.unlink' ? await this.configurator.unlink(agentId) : await this.configurator.restore(agentId)
          finish({ status: 'ok', detail: (result as { message: string }).message })
        } catch (error) {
          finish({ status: 'error', detail: (error as Error).message })
          throw error
        }
        break
      }
      case 'activity.recent': {
        const { limit } = params as { limit: number }
        result = { entries: this.activity.recent(Math.min(limit, 500)), totals: this.activity.totals() }
        break
      }
    }
    return contract.result.parse(result)
  }

  rpcTimeout(): number {
    return LIMITS.RPC_TIMEOUT_MS
  }
}
