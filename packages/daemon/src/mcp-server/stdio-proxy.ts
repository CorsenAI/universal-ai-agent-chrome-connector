import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { readCredentials } from '../auth/credentials'
import { connectorPaths } from '../config/paths'
import { ensureDaemon } from '../daemon/lifecycle'
import type { Logger } from '../util/logger'
import type { ToolCallResult } from './executor'
import { createMcpServerFactory } from './factory'

/** The daemon answered 401: this proxy's API key is not the daemon's (rotated, or another home). */
export class DaemonAuthError extends Error {
  constructor() {
    super('the connector daemon refused the API key')
    this.name = 'DaemonAuthError'
  }
}

/** HTTP client the stdio proxy uses to reach the daemon's tool executor. */
export class DaemonClient {
  readonly #base: string
  readonly #token: string

  constructor(base: string, token: string) {
    this.#base = base
    this.#token = token
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<ToolCallResult> {
    const timeout = AbortSignal.timeout(120_000)
    const response = await fetch(`${this.#base}/api/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({ name, arguments: args ?? {} }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (response.status === 401) throw new DaemonAuthError()
    const body = (await response.json().catch(() => null)) as ToolCallResult | { error?: { message?: string } } | null
    if (response.ok && body !== null && 'content' in body) return body
    const message = body !== null && 'error' in body ? (body.error?.message ?? `HTTP ${response.status}`) : `HTTP ${response.status}`
    return { content: [{ type: 'text', text: `INTERNAL: the connector daemon refused the call: ${message}` }], isError: true }
  }
}

export interface StdioOptions {
  readonly port: number
  readonly home: string
  readonly entry: string
  readonly logger: Logger
}

/**
 * `universal-connector mcp`: an MCP stdio server (both protocol eras) whose tools forward to the
 * long-lived daemon (D-002). It starts the daemon when none answers, and retries once if the daemon
 * went away between calls or refused the API key (credentials are read again: `token --rotate`
 * replaces them while agent sessions keep running). Stdout carries only MCP frames; logs go to stderr.
 */
export async function runStdioProxy(options: StdioOptions): Promise<void> {
  const paths = connectorPaths(options.home)
  let client: DaemonClient | null = null

  const connect = async (): Promise<DaemonClient> => {
    await ensureDaemon({ port: options.port, home: options.home, entry: options.entry, logger: options.logger })
    const credentials = readCredentials(paths.credentials)
    if (credentials === null) throw new Error(`no credentials at ${paths.credentials}`)
    return new DaemonClient(`http://127.0.0.1:${options.port}`, credentials.apiToken)
  }

  const invoke = async (name: string, args: unknown, signal?: AbortSignal): Promise<ToolCallResult> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        client ??= await connect()
        return await client.callTool(name, args, signal)
      } catch (error) {
        client = null
        if (attempt === 1 || signal?.aborted === true) {
          if (error instanceof DaemonAuthError) {
            const text = `UNAUTHENTICATED: the connector daemon on port ${options.port} does not accept the API key in ${paths.credentials}. It was started with other credentials (another CORSEN_CONNECTOR_HOME): restart it from this home, or point CORSEN_CONNECTOR_HOME and CORSEN_CONNECTOR_PORT at the daemon you use.`
            return { content: [{ type: 'text', text }], isError: true }
          }
          return { content: [{ type: 'text', text: `NO_BROWSER: the connector daemon is unreachable (${(error as Error).message}).` }], isError: true }
        }
      }
    }
    return { content: [{ type: 'text', text: 'INTERNAL: unreachable' }], isError: true }
  }

  try {
    client = await connect()
  } catch (error) {
    // Keep serving: tools will report the problem and retry on each call.
    options.logger.warn('daemon not reachable yet', { error: (error as Error).message })
  }

  const handle = serveStdio(createMcpServerFactory(invoke), {
    legacy: 'serve',
    onerror: (error) => options.logger.warn('mcp stdio error', { error: error.message }),
  })
  const stop = (): void => {
    void handle.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
