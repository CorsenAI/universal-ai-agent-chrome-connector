import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '@corsen-ai/shared'
import { AgentConfigurator } from '../agent-configurator/configurator'
import { BackupStore } from '../agent-configurator/backups'
import { resolveLaunchCommand, type LaunchCommand } from '../agent-configurator/launch'
import type { PlatformContext } from '../agent-configurator/locations'
import { loadOrCreateCredentials } from '../auth/credentials'
import { connectorPaths } from '../config/paths'
import { startServer, type RunningServer } from '../http/server'
import type { Logger } from '../util/logger'
import { DaemonContext } from './context'
import { removePidFile, writePidFile } from './lifecycle'

/** Absolute path of the running CLI bundle (`dist/index.js`); every module shares it once bundled. */
export function cliEntry(): string {
  return fileURLToPath(import.meta.url)
}

export function defaultConnectorHome(): string {
  return join(homedir(), '.corsen-connector')
}

export function launchCommandFor(port: number, home: string): LaunchCommand {
  return resolveLaunchCommand({
    platform: process.platform,
    entry: cliEntry(),
    nodePath: process.execPath,
    version: VERSION,
    port,
    connectorHome: home,
    defaultConnectorHome: defaultConnectorHome(),
  })
}

export function buildConfigurator(port: number, home: string, logger: Logger, launch: LaunchCommand = launchCommandFor(port, home)): AgentConfigurator {
  const ctx: PlatformContext = { platform: process.platform, home: homedir(), env: process.env }
  return new AgentConfigurator({ ctx, launch, backups: new BackupStore(connectorPaths(home).backups), logger })
}

export interface DaemonHandle {
  readonly ctx: DaemonContext
  readonly server: RunningServer
  stop(): Promise<void>
  /** Re-read credentials from disk (after `token --rotate`). */
  reloadCredentials(): void
}

export interface RunDaemonOptions {
  readonly port: number
  readonly home: string
  readonly logger: Logger
  readonly configurator?: AgentConfigurator
  readonly allowedApiOrigins?: readonly string[]
  readonly extraAllowedHosts?: readonly string[]
  readonly writePid?: boolean
  readonly onStopped?: () => void
}

/** Start one daemon: credentials, services, HTTP + WebSocket server, pid file. */
export async function runDaemon(options: RunDaemonOptions): Promise<DaemonHandle> {
  const paths = connectorPaths(options.home)
  let credentials = loadOrCreateCredentials(paths.credentials)
  const ctx = new DaemonContext({
    port: options.port,
    credentials: () => credentials,
    logger: options.logger,
    configurator: options.configurator ?? buildConfigurator(options.port, options.home, options.logger),
    allowedApiOrigins: options.allowedApiOrigins ?? [],
    extraAllowedHosts: options.extraAllowedHosts ?? [],
  })
  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      options.logger.info('daemon stopping')
      await server.close()
      if (options.writePid !== false) removePidFile(paths.pid)
      options.onStopped?.()
    })()
    return stopping
  }
  const server = await startServer(ctx, () => void stop())
  if (options.writePid !== false) writePidFile(paths.pid)
  options.logger.info('daemon listening', { port: server.port, version: VERSION })
  const reloadCredentials = (): void => {
    credentials = loadOrCreateCredentials(paths.credentials)
    options.logger.info('credentials reloaded')
  }
  return { ctx, server, stop, reloadCredentials }
}
