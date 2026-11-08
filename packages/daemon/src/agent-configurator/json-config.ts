import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { AgentId } from '@corsen-ai/shared'
import { backupStamp, type BackupStore } from './backups'

/**
 * Safe, comment-preserving edits of agent configuration files (JSON or JSONC):
 * - a file that does not parse is never touched (we refuse instead of clobbering it);
 * - every change of an existing file is preceded by a timestamped `.bak` copy recorded in the manifest;
 * - writes are atomic (temporary file + rename) and keep the file mode;
 * - symlinked files (dotfile managers) are edited through the link, never replaced by a regular file.
 */

export class ConfigFileError extends Error {
  readonly file: string

  constructor(file: string, message: string) {
    super(message)
    this.name = 'ConfigFileError'
    this.file = file
  }
}

export interface ReadResult {
  readonly exists: boolean
  readonly text: string
  readonly data: unknown
}

export function readJsonc(file: string): ReadResult {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '', data: undefined }
    throw new ConfigFileError(file, `cannot read ${file}: ${(cause as Error).message}`)
  }
  if (text.trim() === '') return { exists: true, text, data: undefined }
  const errors: ParseError[] = []
  const data: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    const first = errors[0]
    throw new ConfigFileError(file, `${file} is not valid JSON (${first !== undefined ? `${printParseErrorCode(first.error)} at offset ${first.offset}` : 'parse error'}); fix it first — it was not modified`)
  }
  return { exists: true, text, data }
}

/** Value at a property path, or undefined. */
export function valueAt(data: unknown, path: readonly string[]): unknown {
  let current: unknown = data
  for (const key of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function detectIndent(text: string): { insertSpaces: boolean; tabSize: number } {
  const match = /\n([ \t]+)\S/.exec(text)
  if (match?.[1] === undefined) return { insertSpaces: true, tabSize: 2 }
  if (match[1].startsWith('\t')) return { insertSpaces: false, tabSize: 1 }
  return { insertSpaces: true, tabSize: Math.min(8, Math.max(1, match[1].length)) }
}

function realTarget(file: string): string {
  try {
    if (lstatSync(file).isSymbolicLink()) return realpathSync(file)
  } catch {
    // does not exist yet
  }
  return file
}

export interface EditOptions {
  readonly agentId: AgentId
  readonly reason: 'connect' | 'unlink' | 'restore'
  readonly backups: BackupStore
  readonly now?: Date
}

export interface EditResult {
  readonly changed: boolean
  readonly backupPath: string | null
}

/** Copy `file` to a timestamped sibling and record it. Returns the backup path. */
export function backupFile(file: string, options: EditOptions): string {
  const target = realTarget(file)
  let backupPath = `${target}.corsen-backup-${backupStamp(options.now ?? new Date())}.bak`
  for (let suffix = 1; ; suffix += 1) {
    try {
      statSync(backupPath)
      backupPath = `${target}.corsen-backup-${backupStamp(options.now ?? new Date())}-${suffix}.bak`
    } catch {
      break
    }
  }
  copyFileSync(target, backupPath)
  if (process.platform !== 'win32') chmodSync(backupPath, statSync(target).mode & 0o777)
  options.backups.add({ agentId: options.agentId, file, backup: backupPath, createdAt: new Date().toISOString(), reason: options.reason })
  return backupPath
}

/** Atomically write text to `file` (through symlinks), creating parent directories. */
export function writeAtomically(file: string, text: string): void {
  const target = realTarget(file)
  mkdirSync(dirname(target), { recursive: true })
  let mode = 0o600
  try {
    mode = statSync(target).mode & 0o777
  } catch {
    // new file
  }
  const temporary = `${target}.corsen-tmp-${process.pid}`
  writeFileSync(temporary, text, { encoding: 'utf8', mode })
  if (process.platform !== 'win32') chmodSync(temporary, mode)
  renameSync(temporary, target)
}

/**
 * Set (`value` defined) or remove (`value` undefined) the property at `path`. Parent objects are
 * created as needed. No-op (and no backup) when nothing would change.
 */
export function editJsonc(file: string, path: readonly string[], value: unknown, options: EditOptions): EditResult {
  const current = readJsonc(file)
  if (current.data !== undefined && (current.data === null || typeof current.data !== 'object' || Array.isArray(current.data))) {
    throw new ConfigFileError(file, `${file} does not contain a JSON object; it was not modified`)
  }
  if (value === undefined && valueAt(current.data, path) === undefined) return { changed: false, backupPath: null }
  const base = current.text.trim() === '' ? '{}\n' : current.text
  const eol = base.includes('\r\n') ? '\r\n' : '\n'
  const edits = modify(base, [...path], value, { formattingOptions: { ...detectIndent(base), eol } })
  let next = applyEdits(base, edits)
  if (!next.endsWith(eol)) next += eol
  if (next === current.text) return { changed: false, backupPath: null }
  const backupPath = current.exists && current.text !== '' ? backupFile(file, options) : null
  writeAtomically(file, next)
  return { changed: true, backupPath }
}
