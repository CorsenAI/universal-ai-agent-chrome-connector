import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_PORT, ENV_HOME, ENV_PORT, PACKAGE_NAME } from '@corsen-ai/shared'

/** How an agent should start our stdio MCP server. */
export interface LaunchCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface LaunchContext {
  readonly platform: NodeJS.Platform
  /** Absolute path of the running CLI entry (`dist/index.js`). */
  readonly entry: string
  /** Absolute path of the running Node.js binary. */
  readonly nodePath: string
  readonly version: string
  readonly port: number
  readonly connectorHome: string
  readonly defaultConnectorHome: string
}

/**
 * Resolve the launch command written into agent configs.
 *
 * - Running from an npx cache (`…/_npx/…`): that directory is temporary, so agents call
 *   `npx -y @corsen-ai/universal-connector@<version> mcp`, with the absolute npx path when it sits next
 *   to node (GUI apps such as Claude Desktop on macOS do not inherit the shell PATH), and the `cmd /c`
 *   wrapper on Windows (npx is a .cmd script there).
 * - Otherwise (local checkout or global install): the absolute node binary and script path — no PATH
 *   dependency at all.
 * Non-default home/port are passed through env so the proxy finds the same daemon and credentials.
 */
export function resolveLaunchCommand(ctx: LaunchContext): LaunchCommand {
  const env: Record<string, string> = {}
  if (ctx.connectorHome !== ctx.defaultConnectorHome) env[ENV_HOME] = ctx.connectorHome
  if (ctx.port !== DEFAULT_PORT) env[ENV_PORT] = String(ctx.port)

  if (/[\\/]_npx[\\/]/.test(ctx.entry)) {
    const args = ['-y', `${PACKAGE_NAME}@${ctx.version}`, 'mcp']
    const nodeDir = dirname(ctx.nodePath)
    if (ctx.platform === 'win32') {
      const npxCmd = join(nodeDir, 'npx.cmd')
      return { command: 'cmd', args: ['/c', existsSync(npxCmd) ? npxCmd : 'npx', ...args], env }
    }
    const npx = join(nodeDir, 'npx')
    return { command: existsSync(npx) ? npx : 'npx', args, env }
  }
  return { command: ctx.nodePath, args: [ctx.entry, 'mcp'], env }
}
