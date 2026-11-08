/**
 * Block-safe streaming of a web-LLM answer (D-007). The page is re-read as Markdown blocks every
 * ~150 ms; only text that can no longer change is emitted:
 * - every block except the last one is complete (a new block started after it);
 * - the last block streams only when it is plain prose, up to its last space (words never split);
 * - code fences, lists, tables, headings and quotes are held until they are complete, so the client
 *   never receives a half-formed fence that would later change.
 * Once emitted, text is never retracted; a late change to an already emitted block is reported as a
 * divergence and the final answer remains the source of truth.
 */
export class BlockStreamCommitter {
  #sent = ''
  #diverged = false

  get text(): string {
    return this.#sent
  }

  get diverged(): boolean {
    return this.#diverged
  }

  /** Returns the newly committable text (possibly empty). */
  update(blocks: readonly string[], final: boolean): string {
    const committed = final ? blocks.join('\n\n') : stablePrefix(blocks)
    if (committed.length <= this.#sent.length) {
      if (!this.#sent.startsWith(committed)) this.#diverged = true
      return ''
    }
    if (!committed.startsWith(this.#sent)) {
      this.#diverged = true
      return ''
    }
    const delta = committed.slice(this.#sent.length)
    this.#sent = committed
    return delta
  }
}

export function isProse(block: string): boolean {
  if (block.includes('\n')) return false
  return !/^(```|~~~|\||#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(block.trimStart())
}

export function stablePrefix(blocks: readonly string[]): string {
  if (blocks.length === 0) return ''
  const complete = blocks.slice(0, -1).join('\n\n')
  const last = blocks[blocks.length - 1] ?? ''
  let partial = ''
  if (isProse(last)) {
    const cut = last.lastIndexOf(' ')
    partial = cut > 0 ? last.slice(0, cut) : ''
  }
  if (complete === '') return partial
  return partial === '' ? complete : `${complete}\n\n${partial}`
}
