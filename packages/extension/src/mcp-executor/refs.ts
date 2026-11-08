/**
 * Per-tab element references `e<N>` (D-006). One counter per tab that never restarts while the tab is
 * attached: DOM refs are minted inside the page by the distiller (starting at `startIndex`), AX refs
 * here; a backend node keeps its AX ref across snapshots. Numbers are never reused, so a stale ref
 * fails instead of pointing at another element. Pure (no chrome.* access).
 */
export type RefTarget = { readonly kind: 'ax'; readonly backendNodeId: number } | { readonly kind: 'dom'; readonly index: number }

interface TabRefs {
  next: number
  readonly byBackend: Map<number, number>
  readonly axTargets: Map<number, number>
}

export class RefRegistry {
  readonly #tabs = new Map<number, TabRefs>()

  #tab(tabId: number): TabRefs {
    let refs = this.#tabs.get(tabId)
    if (refs === undefined) {
      refs = { next: 1, byBackend: new Map(), axTargets: new Map() }
      this.#tabs.set(tabId, refs)
    }
    return refs
  }

  startIndex(tabId: number): number {
    return this.#tab(tabId).next
  }

  /** After a DOM snapshot: the page minted refs up to `next - 1`. */
  advanceTo(tabId: number, next: number): void {
    const refs = this.#tab(tabId)
    refs.next = Math.max(refs.next, Math.floor(next))
  }

  axRef(tabId: number, backendNodeId: number): string {
    const refs = this.#tab(tabId)
    let index = refs.byBackend.get(backendNodeId)
    if (index === undefined) {
      index = refs.next
      refs.next += 1
      refs.byBackend.set(backendNodeId, index)
      refs.axTargets.set(index, backendNodeId)
    }
    return `e${index}`
  }

  lookup(tabId: number, ref: string): RefTarget | null {
    const match = /^e(\d{1,9})$/.exec(ref)
    if (match?.[1] === undefined) return null
    const index = Number(match[1])
    const refs = this.#tabs.get(tabId)
    if (refs === undefined || index >= refs.next) return null
    const backendNodeId = refs.axTargets.get(index)
    return backendNodeId !== undefined ? { kind: 'ax', backendNodeId } : { kind: 'dom', index }
  }

  forget(tabId: number): void {
    this.#tabs.delete(tabId)
  }
}
