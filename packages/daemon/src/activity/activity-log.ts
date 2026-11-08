import { randomUUID } from 'node:crypto'
import type { ActivityEntry, ActivityTotals } from '@corsen-ai/shared'

type Listener = (entry: ActivityEntry, totals: ActivityTotals) => void

export interface ActivityStart {
  readonly kind: ActivityEntry['kind']
  readonly title: string
  readonly detail?: string | undefined
  readonly model?: string | undefined
  readonly targetId?: string | undefined
}

export interface ActivityFinish {
  readonly status: 'ok' | 'error'
  readonly detail?: string | undefined
  readonly tokensSaved?: number | undefined
  readonly model?: string | undefined
  readonly targetId?: string | undefined
}

/**
 * Ring buffer of the live activity feed (LLM requests, MCP calls, security events) plus running
 * totals. Subscribers (dashboard SSE, extension link) receive every entry update.
 */
export class ActivityLog {
  readonly #entries: ActivityEntry[] = []
  readonly #listeners = new Set<Listener>()
  readonly #capacity: number
  #totals: ActivityTotals = { llmRequests: 0, mcpCalls: 0, errors: 0, tokensSaved: 0 }

  constructor(capacity = 500) {
    this.#capacity = capacity
  }

  /** Record a running entry; call the returned function exactly once to settle it. */
  start(input: ActivityStart): (finish: ActivityFinish) => ActivityEntry {
    const started = Date.now()
    const entry: ActivityEntry = {
      id: randomUUID(),
      ts: started,
      kind: input.kind,
      status: 'running',
      title: input.title.slice(0, 200),
      ...(input.detail !== undefined ? { detail: input.detail.slice(0, 1000) } : {}),
      ...(input.model !== undefined ? { model: input.model.slice(0, 200) } : {}),
      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
    }
    if (input.kind === 'llm') this.#totals = { ...this.#totals, llmRequests: this.#totals.llmRequests + 1 }
    if (input.kind === 'mcp') this.#totals = { ...this.#totals, mcpCalls: this.#totals.mcpCalls + 1 }
    this.#push(entry)
    let settled = false
    return (finish) => {
      if (settled) return entry
      settled = true
      const done: ActivityEntry = {
        ...entry,
        status: finish.status,
        durationMs: Date.now() - started,
        ...(finish.detail !== undefined ? { detail: finish.detail.slice(0, 1000) } : {}),
        ...(finish.tokensSaved !== undefined && finish.tokensSaved > 0 ? { tokensSaved: Math.round(finish.tokensSaved) } : {}),
        ...(finish.model !== undefined ? { model: finish.model.slice(0, 200) } : {}),
        ...(finish.targetId !== undefined ? { targetId: finish.targetId } : {}),
      }
      this.#totals = {
        ...this.#totals,
        errors: this.#totals.errors + (finish.status === 'error' ? 1 : 0),
        tokensSaved: this.#totals.tokensSaved + (done.tokensSaved ?? 0),
      }
      this.#replace(done)
      return done
    }
  }

  /** Record an instantaneous event (security refusal, browser connected…). */
  note(kind: ActivityEntry['kind'], title: string, status: 'ok' | 'error', detail?: string): ActivityEntry {
    const entry: ActivityEntry = {
      id: randomUUID(),
      ts: Date.now(),
      kind,
      status,
      title: title.slice(0, 200),
      ...(detail !== undefined ? { detail: detail.slice(0, 1000) } : {}),
    }
    if (status === 'error') this.#totals = { ...this.#totals, errors: this.#totals.errors + 1 }
    this.#push(entry)
    return entry
  }

  recent(limit = 100): ActivityEntry[] {
    return this.#entries.slice(-limit)
  }

  totals(): ActivityTotals {
    return this.#totals
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #push(entry: ActivityEntry): void {
    this.#entries.push(entry)
    if (this.#entries.length > this.#capacity) this.#entries.splice(0, this.#entries.length - this.#capacity)
    this.#emit(entry)
  }

  #replace(entry: ActivityEntry): void {
    const index = this.#entries.findIndex((item) => item.id === entry.id)
    if (index >= 0) this.#entries[index] = entry
    else this.#entries.push(entry)
    this.#emit(entry)
  }

  #emit(entry: ActivityEntry): void {
    for (const listener of this.#listeners) {
      try {
        listener(entry, this.#totals)
      } catch {
        // A broken subscriber must not break logging.
      }
    }
  }
}
