import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_PORT, ENV_HOME, ENV_PORT } from '@corsen-ai/shared'

/**
 * Where the daemon keeps its state. One directory, so an uninstall is a single removal and nothing
 * here can be confused with an agent's own files. `CORSEN_CONNECTOR_HOME` overrides it (tests always
 * do, so they never touch the real home).
 */
export function connectorHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_HOME]
  if (override !== undefined && override.trim() !== '') return resolve(override)
  return join(homedir(), '.corsen-connector')
}

export interface ConnectorPaths {
  readonly home: string
  readonly credentials: string
  readonly pid: string
  readonly log: string
  readonly backups: string
  readonly launchLock: string
}

export function connectorPaths(home: string): ConnectorPaths {
  return {
    home,
    credentials: join(home, 'credentials.json'),
    pid: join(home, 'daemon.pid'),
    log: join(home, 'daemon.log'),
    backups: join(home, 'backups.json'),
    launchLock: join(home, 'daemon.launch.lock'),
  }
}

/** Port precedence: explicit flag > `CORSEN_CONNECTOR_PORT` > default 43110. */
export function resolvePort(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const raw = flag ?? env[ENV_PORT]
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port "${raw}" (expected an integer between 1 and 65535)`)
  }
  return port
}
