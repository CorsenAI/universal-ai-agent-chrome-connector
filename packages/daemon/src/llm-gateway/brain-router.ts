import {
  AUTO_MODEL,
  ConnectorError,
  HARNESS_LABELS,
  LIMITS,
  modelIdForHarness,
  resolveModel,
  type HarnessId,
  type NormalizedChatRequest,
  type NormalizedMessage,
  type TabInfo,
} from '@corsen-ai/shared'
import type { Logger } from '../util/logger'
import type { BrowserHub } from '../ws-hub/hub'
import { buildPrompt, fingerprintMessage, sessionAfterReply, toolsKey, type BuiltPrompt, type ConversationSession } from './prompt-builder'

const MAX_QUEUE_PER_TAB = 4

export interface GenerationHandle {
  readonly tabId: number
  readonly harnessId: HarnessId
  readonly built: BuiltPrompt
  readonly text: string
  readonly finishReason: 'stop' | 'length' | 'cancelled' | 'timeout'
  readonly url: string
}

export interface ModelInfo {
  readonly id: string
  readonly harness: HarnessId | 'auto'
  readonly label: string
  readonly tabs: number
}

/**
 * Chooses which "LLM Brain" tab serves a request, serializes generations per tab (a web chat can only
 * answer one prompt at a time), and keeps per-tab conversation continuity state.
 */
export class BrainRouter {
  readonly #hub: BrowserHub
  readonly #logger: Logger
  readonly #sessions = new Map<number, ConversationSession>()
  readonly #tails = new Map<number, Promise<void>>()
  readonly #depth = new Map<number, number>()

  constructor(hub: BrowserHub, logger: Logger) {
    this.#hub = hub
    this.#logger = logger
    hub.on((event) => {
      if (event === 'disconnected') this.#sessions.clear()
    })
  }

  brains(): TabInfo[] {
    return (this.#hub.state()?.tabs ?? []).filter((tab) => tab.role === 'brain' && tab.harnessId !== null)
  }

  listModels(): ModelInfo[] {
    const brains = this.brains()
    const byHarness = new Map<HarnessId, number>()
    for (const tab of brains) if (tab.harnessId !== null) byHarness.set(tab.harnessId, (byHarness.get(tab.harnessId) ?? 0) + 1)
    const models: ModelInfo[] = [{ id: AUTO_MODEL, harness: 'auto', label: 'Any connected LLM Brain tab', tabs: brains.length }]
    for (const [harness, tabs] of byHarness) models.push({ id: modelIdForHarness(harness), harness, label: HARNESS_LABELS[harness], tabs })
    return models
  }

  #pickTab(request: NormalizedChatRequest): TabInfo {
    if (!this.#hub.connected) throw new ConnectorError('NO_BROWSER', 'No browser is connected. Open Chrome with the Corsen extension installed and paired.')
    const brains = this.brains()
    if (brains.length === 0) {
      throw new ConnectorError('NO_BRAIN', 'No tab is set as "LLM Brain". Open a signed-in chat (DeepSeek, Claude.ai, ChatGPT, Gemini, Qwen, Kimi), click the Corsen icon and choose "Use as LLM".')
    }
    const resolution = resolveModel(request.model)
    let candidates = brains
    if (resolution.harness !== 'auto') {
      const matching = brains.filter((tab) => tab.harnessId === resolution.harness)
      if (matching.length > 0) candidates = matching
      else if (resolution.explicit) {
        throw new ConnectorError('NO_BRAIN', `No tab is set as LLM Brain for ${HARNESS_LABELS[resolution.harness]} (model "${request.model}"). Available: ${this.listModels().map((model) => model.id).join(', ')}`)
      }
    }
    // Prefer the tab whose conversation this request continues, then the least busy one.
    const fingerprints = request.messages.map(fingerprintMessage)
    const key = toolsKey(request)
    const continuing = candidates.find((tab) => {
      const session = this.#sessions.get(tab.tabId)
      return (
        session !== undefined &&
        session.toolsKey === key &&
        session.url === tab.url &&
        session.fingerprints.length < fingerprints.length &&
        session.fingerprints.every((fp, index) => fp === fingerprints[index])
      )
    })
    if (continuing !== undefined) return continuing
    const sorted = [...candidates].sort((a, b) => (this.#depth.get(a.tabId) ?? 0) - (this.#depth.get(b.tabId) ?? 0) || Number(b.active) - Number(a.active))
    const first = sorted[0]
    if (first === undefined) throw new ConnectorError('NO_BRAIN', 'No LLM Brain tab is available.')
    return first
  }

  async generate(request: NormalizedChatRequest, options: { signal: AbortSignal; onDelta: (text: string) => void }): Promise<GenerationHandle> {
    const tab = this.#pickTab(request)
    const harnessId = tab.harnessId
    if (harnessId === null) throw new ConnectorError('NO_BRAIN', 'The selected tab has no harness.')
    return this.#exclusive(tab.tabId, options.signal, async () => {
      // Re-read the tab after waiting in the queue: the user may have changed it meanwhile.
      const fresh = this.brains().find((item) => item.tabId === tab.tabId)
      if (fresh === undefined) throw new ConnectorError('NO_BRAIN', 'The LLM Brain tab was closed or demoted while the request was queued.')
      const built = buildPrompt(request, this.#sessions.get(tab.tabId) ?? null, fresh.url)
      if (built.prompt.length > LIMITS.MAX_PROMPT_CHARS) {
        throw new ConnectorError('TOO_LARGE', `prompt is ${built.prompt.length} characters; the limit is ${LIMITS.MAX_PROMPT_CHARS}`)
      }
      this.#logger.info('llm generation', { tabId: tab.tabId, harness: harnessId, newChat: built.newChat, promptChars: built.prompt.length })
      try {
        const result = await this.#hub.call(
          'llm.generate',
          { tabId: tab.tabId, harnessId, prompt: built.prompt, newChat: built.newChat, timeoutMs: LIMITS.LLM_TIMEOUT_MS },
          {
            timeoutMs: LIMITS.LLM_TIMEOUT_MS + 15_000,
            signal: options.signal,
            onEvent: (event) => {
              if (event.kind === 'delta') options.onDelta(event.text)
            },
          },
        )
        if (result.finishReason === 'cancelled' || result.finishReason === 'timeout') this.#sessions.delete(tab.tabId)
        return { tabId: tab.tabId, harnessId, built, text: result.text, finishReason: result.finishReason, url: result.url }
      } catch (error) {
        // The web conversation is in an unknown state: the next request starts a new chat.
        this.#sessions.delete(tab.tabId)
        throw error
      }
    })
  }

  /** Remember what the web conversation now holds, so the next turn can be typed as a delta. */
  recordReply(handle: GenerationHandle, reply: Extract<NormalizedMessage, { role: 'assistant' }>): void {
    if (handle.finishReason !== 'stop' && handle.finishReason !== 'length') return
    this.#sessions.set(handle.tabId, sessionAfterReply(handle.built, reply, handle.url))
  }

  forget(tabId: number): void {
    this.#sessions.delete(tabId)
  }

  async #exclusive<T>(tabId: number, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const depth = this.#depth.get(tabId) ?? 0
    if (depth >= MAX_QUEUE_PER_TAB) throw new ConnectorError('BRAIN_BUSY', `the LLM Brain tab already has ${depth} requests queued; retry later or add another brain tab`)
    this.#depth.set(tabId, depth + 1)
    const previous = this.#tails.get(tabId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.#tails.set(tabId, tail)
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new ConnectorError('CANCELLED', 'the request was cancelled while queued'))
          return
        }
        const onAbort = (): void => reject(new ConnectorError('CANCELLED', 'the request was cancelled while queued'))
        signal.addEventListener('abort', onAbort, { once: true })
        void previous.then(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
      return await task()
    } finally {
      release()
      this.#depth.set(tabId, Math.max(0, (this.#depth.get(tabId) ?? 1) - 1))
      if (this.#tails.get(tabId) === tail) this.#tails.delete(tabId)
    }
  }
}
