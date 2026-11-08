import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentId } from '@corsen-ai/shared'

export interface BackupRecord {
  readonly agentId: AgentId
  readonly file: string
  readonly backup: string
  readonly createdAt: string
  readonly reason: 'connect' | 'unlink' | 'restore'
}

const MAX_RECORDS = 300

/** Manifest of every `.bak` copy the configurator made, so "Restore" can find the right one. */
export class BackupStore {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  list(agentId?: AgentId): BackupRecord[] {
    let records: BackupRecord[] = []
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
      if (Array.isArray(parsed)) records = parsed.filter(isRecord)
    } catch {
      records = []
    }
    return agentId === undefined ? records : records.filter((record) => record.agentId === agentId)
  }

  add(record: BackupRecord): void {
    const records = [...this.list(), record].slice(-MAX_RECORDS)
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 })
    const temporary = `${this.#path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.#path)
  }

  latest(agentId: AgentId, file: string): BackupRecord | undefined {
    return this.list(agentId)
      .filter((record) => record.file === file)
      .at(-1)
  }
}

function isRecord(value: unknown): value is BackupRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['agentId'] === 'string' && typeof record['file'] === 'string' && typeof record['backup'] === 'string'
}

/** `20261108-173012` style stamp (local time), safe in file names on every OS. */
export function backupStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
