import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_LOG_BYTES = 5 * 1024 * 1024

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface LoggerOptions {
  readonly level?: LogLevel
  /** Append JSON lines to this file (rotated at 5 MiB, one previous file kept). */
  readonly file?: string | undefined
  /** Human-readable lines on stderr. Never stdout: stdout belongs to MCP stdio. */
  readonly stderr?: boolean
}

/**
 * Minimal structured logger. Callers must never pass secrets (tokens, pairing code, page content):
 * log identifiers and sizes instead.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = RANK[options.level ?? 'info']
  const file = options.file
  let fileReady = false

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (RANK[level] < threshold) return
    const ts = new Date().toISOString()
    if (options.stderr === true) {
      const extra = fields !== undefined && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ''
      process.stderr.write(`${ts} ${level.toUpperCase().padEnd(5)} ${message}${extra}\n`)
    }
    if (file !== undefined) {
      try {
        if (!fileReady) {
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
          fileReady = true
        }
        try {
          if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`)
        } catch {
          // no file yet
        }
        appendFileSync(file, `${JSON.stringify({ ts, level, message, ...fields })}\n`, { mode: 0o600 })
      } catch {
        // Logging must never take the daemon down.
      }
    }
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  }
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
