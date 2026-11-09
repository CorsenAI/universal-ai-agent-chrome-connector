import { createInterface } from 'node:readline/promises'
import { AGENT_IDS, VERSION, formatPairingCode, type AgentId, type AgentStatus } from '@corsen-ai/shared'
import { loadOrCreateCredentials, readCredentials, rotateCredentials } from '../auth/credentials'
import { connectorHome, connectorPaths, resolvePort } from '../config/paths'
import { probeDaemon, readPidFile } from '../daemon/lifecycle'
import { buildConfigurator, cliEntry, runDaemon } from '../daemon/run-daemon'
import { runStdioProxy } from '../mcp-server/stdio-proxy'
import { createLogger } from '../util/logger'
import { openUrl } from '../util/open-url'
import { HELP, type CliArgs } from './args'
import { bold, cyan, dim, green, maskToken, red, startBanner, yellow } from './banner'
import { cliName } from './cli-name'

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`)
}

async function adminPost(port: number, token: string, path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    })
    return response.ok ? ((await response.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function cmdStart(args: CliArgs): Promise<void> {
  const port = resolvePort(args.port)
  const home = connectorHome()
  const paths = connectorPaths(home)
  const existing = await probeDaemon(port)
  if (existing.kind === 'ours') {
    const credentials = loadOrCreateCredentials(paths.credentials)
    out(`${green('●')} The connector daemon is already running on port ${port} (pid ${existing.health.pid}).`)
    const login = await adminPost(port, credentials.apiToken, '/api/admin/login-code')
    if (typeof login?.['url'] === 'string') {
      out(`  Dashboard: ${login['url']}`)
      if (args.open) openUrl(login['url'])
    }
    return
  }
  if (existing.kind === 'foreign') throw new Error(`port ${port} is used by another program; pick another with --port`)

  const logger = createLogger({ level: args.logLevel, file: paths.log, stderr: !args.open || process.stdout.isTTY !== true })
  const handle = await runDaemon({
    port,
    home,
    logger,
    allowedApiOrigins: args.allowOrigins,
    extraAllowedHosts: args.allowHosts,
    onStopped: () => process.exit(0),
  })
  const info = handle.ctx.info()
  out(startBanner({ port, dashboardUrl: info.dashboardUrl, pairingSecret: handle.ctx.pairingSecret, apiToken: handle.ctx.apiToken, showToken: args.show, cli: cliName() }))
  if (args.allowHosts.length > 0) out(yellow(`  ⚠ Extra Host values accepted: ${args.allowHosts.join(', ')} — anyone reaching them still needs the API key.`))
  if (args.open) openUrl(info.dashboardUrl)
  process.on('SIGHUP', () => handle.reloadCredentials())
  const shutdown = (): void => void handle.stop()
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

export async function cmdMcp(args: CliArgs): Promise<void> {
  const home = connectorHome()
  const logger = createLogger({ level: args.logLevel, stderr: true })
  await runStdioProxy({ port: resolvePort(args.port), home, entry: cliEntry(), logger })
}

function agentLine(agent: AgentStatus, index: number): string {
  const state = agent.connected ? green('connected') : agent.detected ? yellow('detected') : dim('not found')
  return `  ${String(index + 1).padStart(2)}. ${bold(agent.name.padEnd(30))} ${state}  ${dim(agent.configPaths.join(', '))}`
}

function parseAgentIds(values: readonly string[]): AgentId[] {
  return values.map((value) => {
    if (!(AGENT_IDS as readonly string[]).includes(value)) throw new Error(`unknown agent "${value}"; expected one of ${AGENT_IDS.join(', ')}`)
    return value as AgentId
  })
}

export async function cmdSetup(args: CliArgs): Promise<void> {
  const port = resolvePort(args.port)
  const home = connectorHome()
  const configurator = buildConfigurator(port, home, createLogger({ level: 'warn', stderr: true }))
  const agents = configurator.list()
  out(bold('Agents on this machine'))
  agents.forEach((agent, index) => out(agentLine(agent, index)))
  out()
  if (args.list) return

  let chosen: AgentId[]
  if (args.agents.length > 0) chosen = parseAgentIds(args.agents)
  else if (args.all || args.yes) chosen = agents.filter((agent) => agent.detected).map((agent) => agent.id)
  else if (process.stdin.isTTY === true) {
    const detected = agents.filter((agent) => agent.detected)
    if (detected.length === 0) {
      out('No supported agent was detected. Use --agent <id> to create a configuration anyway.')
      return
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(`Connect which agents? [Enter = all detected (${detected.length}), numbers like 1,3, or "none"] `)).trim().toLowerCase()
    rl.close()
    if (answer === 'none' || answer === 'n') return
    chosen =
      answer === '' || answer === 'all'
        ? detected.map((agent) => agent.id)
        : answer
            .split(/[\s,]+/)
            .map((token) => agents[Number(token) - 1]?.id)
            .filter((id): id is AgentId => id !== undefined)
  } else {
    out('Non-interactive shell: pass --all, --yes or --agent <id>.')
    return
  }

  for (const id of chosen) {
    try {
      const result = await configurator.connect(id)
      out(`${green('✔')} ${result.message}`)
    } catch (error) {
      out(`${red('✘')} ${id}: ${(error as Error).message}`)
      process.exitCode = 1
    }
  }
  out()
  out(`Start the daemon with ${cyan(cliName())} (agents also start it on demand), then pair the extension from the dashboard.`)
}

export async function cmdUnlink(args: CliArgs): Promise<void> {
  const configurator = buildConfigurator(resolvePort(args.port), connectorHome(), createLogger({ level: 'warn', stderr: true }))
  const ids = args.all ? configurator.list().filter((agent) => agent.connected).map((agent) => agent.id) : parseAgentIds(args.positionals)
  if (ids.length === 0) throw new Error('name an agent (e.g. `unlink cursor`) or pass --all')
  for (const id of ids) {
    const result = await configurator.unlink(id)
    out(`${green('✔')} ${result.message}`)
  }
}

export async function cmdRestore(args: CliArgs): Promise<void> {
  const configurator = buildConfigurator(resolvePort(args.port), connectorHome(), createLogger({ level: 'warn', stderr: true }))
  const ids = parseAgentIds(args.positionals)
  if (ids.length === 0) throw new Error('name an agent, e.g. `restore claude-desktop`')
  for (const id of ids) {
    const result = await configurator.restore(id)
    out(`${result.changed ? green('✔') : yellow('•')} ${result.message}`)
  }
}

export async function cmdStatus(args: CliArgs): Promise<void> {
  const port = resolvePort(args.port)
  const home = connectorHome()
  const probe = await probeDaemon(port)
  const agents = buildConfigurator(port, home, createLogger({ level: 'error', stderr: true })).list()
  if (args.json) {
    out(JSON.stringify({ port, daemon: probe, agents }, null, 2))
    return
  }
  if (probe.kind === 'ours') {
    out(`${green('●')} Daemon v${probe.health.version} running on 127.0.0.1:${port} (pid ${probe.health.pid})`)
    out(`${probe.health.browserConnected ? green('●') : red('●')} Browser extension ${probe.health.browserConnected ? 'connected' : 'not connected'}`)
  } else if (probe.kind === 'foreign') {
    out(`${red('●')} Port ${port} is used by another program`)
  } else {
    const pid = readPidFile(connectorPaths(home).pid)
    out(`${red('●')} Daemon not running${pid !== null ? ` (stale pid file ${pid})` : ''} — start it with ${cyan(cliName())}`)
  }
  out()
  agents.forEach((agent, index) => out(agentLine(agent, index)))
}

export async function cmdToken(args: CliArgs): Promise<void> {
  const home = connectorHome()
  const paths = connectorPaths(home)
  const port = resolvePort(args.port)
  if (args.rotate) {
    const credentials = rotateCredentials(paths.credentials)
    const pid = readPidFile(paths.pid)
    if (pid !== null && process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGHUP')
      } catch {
        // daemon not running
      }
    }
    out(`${green('✔')} New credentials generated. Re-pair the extension and re-run ${cyan(`${cliName()} setup`)} for agents using HTTP.`)
    out(`  Pairing code: ${bold(formatPairingCode(credentials.pairingSecret))}`)
    out(`  API key:      ${credentials.apiToken}`)
    if (process.platform === 'win32') out(dim('  Restart the daemon to apply them.'))
    void port
    return
  }
  const credentials = loadOrCreateCredentials(paths.credentials)
  out(`Pairing code: ${bold(formatPairingCode(credentials.pairingSecret))}`)
  out(`API key:      ${args.show ? credentials.apiToken : `${maskToken(credentials.apiToken)}  ${dim('(add --show to print it)')}`}`)
  out(dim(`Stored in ${paths.credentials} (owner-only).`))
}

export async function cmdDashboard(args: CliArgs): Promise<void> {
  const port = resolvePort(args.port)
  const credentials = readCredentials(connectorPaths(connectorHome()).credentials)
  const probe = await probeDaemon(port)
  if (credentials === null || probe.kind !== 'ours') throw new Error(`the daemon is not running on port ${port}; start it with \`${cliName()}\``)
  const login = await adminPost(port, credentials.apiToken, '/api/admin/login-code')
  if (typeof login?.['url'] !== 'string') throw new Error('the daemon refused to create a login link')
  out(`Dashboard: ${login['url']}`)
  if (args.open) openUrl(login['url'])
}

export async function cmdStop(args: CliArgs): Promise<void> {
  const port = resolvePort(args.port)
  const paths = connectorPaths(connectorHome())
  const probe = await probeDaemon(port)
  if (probe.kind !== 'ours') {
    out('The daemon is not running.')
    return
  }
  const credentials = readCredentials(paths.credentials)
  const stopped = credentials !== null ? await adminPost(port, credentials.apiToken, '/api/admin/shutdown') : null
  if (stopped === null) {
    try {
      process.kill(probe.health.pid, 'SIGTERM')
    } catch (error) {
      throw new Error(`could not stop pid ${probe.health.pid}: ${(error as Error).message}`)
    }
  }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    if ((await probeDaemon(port, 500)).kind !== 'ours') {
      out(`${green('✔')} Daemon stopped.`)
      return
    }
  }
  throw new Error('the daemon did not stop within 5 s')
}

export function cmdHelp(): void {
  out(HELP)
}

export function cmdVersion(): void {
  out(VERSION)
}
