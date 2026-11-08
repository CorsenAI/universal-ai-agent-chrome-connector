import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connectorPaths } from '../config/paths'
import type { Logger } from '../util/logger'

/** `name` reported by `/health`, so a client can tell our daemon from anything else on the port. */
export const HEALTH_NAME = 'corsen-universal-connector'

export interface Health {
  readonly ok: boolean
  readonly name: string
  readonly version: string
  readonly protocolVersion: number
  readonly port: number
  readonly browserConnected: boolean
  readonly pid: number
}

export type Probe = { kind: 'ours'; health: Health } | { kind: 'foreign' } | { kind: 'down' }

export async function probeDaemon(port: number, timeoutMs = 1_500): Promise<Probe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    const body = (await response.json().catch(() => null)) as Partial<Health> | null
    if (body !== null && body.name === HEALTH_NAME) return { kind: 'ours', health: body as Health }
    return { kind: 'foreign' }
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause
    if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNRESET' || (error as Error).name === 'TimeoutError') return { kind: 'down' }
    return { kind: 'down' }
  }
}

export interface EnsureOptions {
  readonly port: number
  readonly home: string
  /** Absolute path of the CLI entry to spawn (`dist/index.js`). */
  readonly entry: string
  readonly logger: Logger
  readonly timeoutMs?: number
}

function acquireLock(path: string): boolean {
  try {
    const fd = openSync(path, 'wx', 0o600)
    writeFileSync(fd, String(process.pid))
    closeSync(fd)
    return true
  } catch {
    try {
      // A lock older than 30 s belongs to a launcher that died: take it over.
      if (Date.now() - statSync(path).mtimeMs > 30_000) {
        rmSync(path, { force: true })
        return acquireLock(path)
      }
    } catch {
      // vanished meanwhile
    }
    return false
  }
}

/**
 * Make sure a daemon answers on `port`, starting a detached one when nothing does. Several stdio
 * proxies may start at once (one per agent session): a launch lock ensures only one spawns.
 */
export async function ensureDaemon(options: EnsureOptions): Promise<Health> {
  const first = await probeDaemon(options.port)
  if (first.kind === 'ours') return first.health
  if (first.kind === 'foreign') throw new Error(`port ${options.port} is used by another program; set CORSEN_CONNECTOR_PORT to a free port`)

  const paths = connectorPaths(options.home)
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  const locked = acquireLock(paths.launchLock)
  try {
    if (locked) {
      options.logger.info('starting the connector daemon in the background', { port: options.port })
      const errFd = openSync(`${paths.log}.stderr`, 'a', 0o600)
      const child = spawn(process.execPath, [options.entry, 'start', '--no-open', '--port', String(options.port)], {
        detached: true,
        stdio: ['ignore', 'ignore', errFd],
        env: { ...process.env, CORSEN_CONNECTOR_HOME: options.home },
        windowsHide: true,
      })
      child.unref()
      closeSync(errFd)
    }
    const deadline = Date.now() + (options.timeoutMs ?? 15_000)
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const probe = await probeDaemon(options.port, 1_000)
      if (probe.kind === 'ours') return probe.health
      if (probe.kind === 'foreign') throw new Error(`port ${options.port} is used by another program`)
    }
    let stderr = ''
    try {
      stderr = readFileSync(`${paths.log}.stderr`, 'utf8').split('\n').slice(-5).join('\n')
    } catch {
      // nothing logged
    }
    throw new Error(`the connector daemon did not start within ${Math.round((options.timeoutMs ?? 15_000) / 1000)} s${stderr !== '' ? `:\n${stderr}` : ''}`)
  } finally {
    if (locked) rmSync(paths.launchLock, { force: true })
  }
}

export function writePidFile(path: string): void {
  writeFileSync(path, `${process.pid}\n`, { mode: 0o600 })
}

export function readPidFile(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function removePidFile(path: string): void {
  try {
    if (readPidFile(path) === process.pid) rmSync(path, { force: true })
  } catch {
    // ignore
  }
}
