import { parseArgs } from 'node:util'

export const COMMANDS = ['start', 'mcp', 'setup', 'unlink', 'restore', 'status', 'token', 'dashboard', 'stop', 'help', 'version'] as const
export type Command = (typeof COMMANDS)[number]

export interface CliArgs {
  readonly command: Command
  readonly positionals: readonly string[]
  readonly port: string | undefined
  readonly open: boolean
  readonly agents: readonly string[]
  readonly all: boolean
  readonly yes: boolean
  readonly list: boolean
  readonly rotate: boolean
  readonly show: boolean
  readonly json: boolean
  readonly allowHosts: readonly string[]
  readonly allowOrigins: readonly string[]
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export const HELP = `Universal AI Agent Chrome Connector — by Corsen AI

Usage: universal-connector [command] [options]

Commands
  start               Start the local daemon (default) and open the dashboard
  mcp                 Run the MCP stdio server (agents launch this; starts the daemon if needed)
  setup               Detect your agents and connect them in one step (with .bak backups)
  unlink <agent>      Remove the connector from an agent (or --all)
  restore <agent>     Put back the last backup of an agent's config
  status              Show daemon, browser and agent status
  token               Show the pairing code and API key (--rotate to replace both)
  dashboard           Open the local dashboard with a fresh one-time login link
  stop                Stop the running daemon

Options
  --port <n>          Port (default 43110, env CORSEN_CONNECTOR_PORT)
  --no-open           Do not open the dashboard in the browser
  --agent <id>        setup: agent to connect (repeatable): claude-code, cursor, windsurf,
                      devin, claude-desktop, cline, roo-code, opencode
  --all               setup/unlink: every detected agent
  --yes               setup: no confirmation prompt
  --list              setup: only list detected agents
  --rotate            token: generate a new pairing code and API key
  --show              token/start: print the full API key
  --json              status: machine-readable output
  --allow-host <h>    start: also accept this Host header (e.g. a tunnel); off by default
  --allow-origin <o>  start: also accept API calls from this browser origin; off by default
  --log-level <l>     debug | info | warn | error (default info)
  -h, --help          Show this help
  -v, --version       Show the version
`

export function parseCli(argv: readonly string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      agent: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      list: { type: 'boolean' },
      rotate: { type: 'boolean' },
      show: { type: 'boolean' },
      json: { type: 'boolean' },
      'allow-host': { type: 'string', multiple: true },
      'allow-origin': { type: 'string', multiple: true },
      'log-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
  let command: Command = 'start'
  const rest = [...positionals]
  const first = rest[0]
  if (first !== undefined) {
    if (!(COMMANDS as readonly string[]).includes(first)) throw new Error(`unknown command "${first}" (see --help)`)
    command = first as Command
    rest.shift()
  }
  if (values.help === true) command = 'help'
  if (values.version === true) command = 'version'
  const level = values['log-level'] ?? 'info'
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new Error(`invalid --log-level "${level}"`)
  return {
    command,
    positionals: rest,
    port: values.port,
    open: values['no-open'] !== true,
    agents: values.agent ?? [],
    all: values.all === true,
    yes: values.yes === true,
    list: values.list === true,
    rotate: values.rotate === true,
    show: values.show === true,
    json: values.json === true,
    allowHosts: values['allow-host'] ?? [],
    allowOrigins: values['allow-origin'] ?? [],
    logLevel: level as CliArgs['logLevel'],
  }
}
