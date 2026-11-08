#!/usr/bin/env node
import { parseCli } from './cli/args'
import { cmdDashboard, cmdHelp, cmdMcp, cmdRestore, cmdSetup, cmdStart, cmdStatus, cmdStop, cmdToken, cmdUnlink, cmdVersion } from './cli/commands'

/**
 * `npx @corsen-ai/universal-connector [command]` — Universal AI Agent Chrome Connector, by Corsen AI.
 * Stdout belongs to MCP in `mcp` mode: errors always go to stderr.
 */
async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2))
  switch (args.command) {
    case 'start':
      return cmdStart(args)
    case 'mcp':
      return cmdMcp(args)
    case 'setup':
      return cmdSetup(args)
    case 'unlink':
      return cmdUnlink(args)
    case 'restore':
      return cmdRestore(args)
    case 'status':
      return cmdStatus(args)
    case 'token':
      return cmdToken(args)
    case 'dashboard':
      return cmdDashboard(args)
    case 'stop':
      return cmdStop(args)
    case 'help':
      return cmdHelp()
    case 'version':
      return cmdVersion()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`universal-connector: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
