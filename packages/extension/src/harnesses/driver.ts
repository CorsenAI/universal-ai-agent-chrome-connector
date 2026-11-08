import { ConnectorError, scrubUrl, type ExtensionParams, type LlmEvent, type LlmGenerateResult } from '@corsen-ai/shared'
import type { DebuggerManager } from '../cdp/debugger-manager'
import type { TrustedInput } from '../cdp/input'
import type { IsolatedWorlds } from '../cdp/world'
import { corsenDistill } from '../inpage/distiller'
import { corsenHarnessProbe, type ProbeOptions, type ProbeResult } from '../inpage/harness-probe'
import { resolveHarness, type HarnessOverrides, type ResolvedHarness } from './registry'
import { BlockStreamCommitter } from './stream-committer'

export interface DriverDeps {
  readonly debugger: DebuggerManager
  readonly worlds: IsolatedWorlds
  readonly input: TrustedInput
  readonly overrides: () => Promise<HarnessOverrides>
  readonly onBusyChange: (tabId: number) => void
}

const POLL_MS = 150
const STABLE_MS = 1_800
const START_TIMEOUT_MS = 25_000
const MAX_ANSWER_CHARS = 1_500_000
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const collapse = (text: string): string => text.replace(/\s+/g, '')

/**
 * Generic web-chat driver: one implementation for every `LLMWebHarness`. Trusted CDP input types and
 * submits the prompt; the in-page probe observes the newest answer; the committer streams only
 * stable Markdown. Fails with HARNESS_FAILED (and an actionable message) when the page does not
 * behave like a chat, instead of returning an empty "success".
 */
export class HarnessDriver {
  readonly #deps: DriverDeps
  readonly #busy = new Set<number>()

  constructor(deps: DriverDeps) {
    this.#deps = deps
  }

  isBusy(tabId: number): boolean {
    return this.#busy.has(tabId)
  }

  async generate(params: ExtensionParams<'llm.generate'>, io: { signal: AbortSignal; emit: (event: LlmEvent) => void }): Promise<LlmGenerateResult> {
    const { tabId } = params
    if (this.#busy.has(tabId)) throw new ConnectorError('BRAIN_BUSY', 'this chat tab is already answering another request')
    this.#busy.add(tabId)
    this.#deps.onBusyChange(tabId)
    try {
      return await this.#run(params, io)
    } finally {
      this.#busy.delete(tabId)
      this.#deps.onBusyChange(tabId)
    }
  }

  async #probe(tabId: number, harness: ResolvedHarness, op: ProbeOptions['op']): Promise<ProbeResult> {
    const options: ProbeOptions = {
      op,
      input: harness.selectors.input,
      send: harness.selectors.send,
      stop: harness.selectors.stop,
      response: harness.selectors.response,
      exclude: harness.selectors.exclude,
      streamingAttribute: harness.streamingAttribute,
      maxChars: MAX_ANSWER_CHARS,
    }
    let result = await this.#deps.worlds.call(tabId, corsenHarnessProbe, [options])
    if (result.needsDistiller) {
      await this.#installDistiller(tabId)
      result = await this.#deps.worlds.call(tabId, corsenHarnessProbe, [options])
    }
    return result
  }

  async #installDistiller(tabId: number): Promise<void> {
    await this.#deps.worlds.call(tabId, corsenDistill, [
      { mode: 'element', selector: ':not(*)', startIndex: 1, maxChars: 1, scope: 'full', redaction: { mask: '', secretParamFragments: [], secretAutocomplete: [], secretFieldFragments: [], secretInputTypes: [] } },
    ])
  }

  async #waitForInput(tabId: number, harness: ResolvedHarness, timeoutMs: number): Promise<ProbeResult> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete') {
        const located = await this.#probe(tabId, harness, 'locate').catch(() => null)
        if (located?.input != null) return located
      }
      if (Date.now() > deadline) {
        throw new ConnectorError('HARNESS_FAILED', `Could not find the chat input on ${new URL(tab.url ?? 'about:blank').hostname}. Make sure you are signed in, or recalibrate this site in the Tab Manager.`)
      }
      await sleep(300)
    }
  }

  async #run(params: ExtensionParams<'llm.generate'>, io: { signal: AbortSignal; emit: (event: LlmEvent) => void }): Promise<LlmGenerateResult> {
    const { tabId } = params
    const started = Date.now()
    const deadline = started + params.timeoutMs
    const tab = await chrome.tabs.get(tabId)
    const harness = resolveHarness(params.harnessId, tab.url ?? '', await this.#deps.overrides())

    if (params.newChat && harness.newChatUrl !== null) {
      io.emit({ kind: 'status', status: 'navigating' })
      const navigation = await this.#deps.debugger.send(tabId, 'Page.navigate', { url: harness.newChatUrl })
      if (navigation.errorText !== undefined && navigation.errorText !== '') throw new ConnectorError('HARNESS_FAILED', `could not open a new chat: ${navigation.errorText}`)
      await sleep(400)
    }
    await this.#installDistiller(tabId)
    await this.#waitForInput(tabId, harness, 20_000)
    const prepared = await this.#probe(tabId, harness, 'prepare')
    if (prepared.input === null) throw new ConnectorError('HARNESS_FAILED', 'the chat input disappeared; recalibrate this site in the Tab Manager')

    // Type the prompt with trusted input: focus, replace any draft, insert.
    io.emit({ kind: 'status', status: 'typing' })
    await this.#deps.input.click(tabId, prepared.input.x, prepared.input.y)
    await this.#deps.input.selectAll(tabId)
    await this.#deps.input.insertText(tabId, params.prompt)
    await sleep(120)
    const typed = await this.#probe(tabId, harness, 'readInput')
    const expected = collapse(params.prompt).length
    if (collapse(typed.inputText).length < Math.min(expected * 0.8, expected - 20)) {
      throw new ConnectorError('HARNESS_FAILED', `the chat input accepted only ${collapse(typed.inputText).length} of ${expected} characters; the site may limit prompt size or need recalibration`)
    }

    // Submit and wait for the answer to start.
    if (harness.submit === 'click' && prepared.send !== null) await this.#deps.input.click(tabId, prepared.send.x, prepared.send.y)
    else await this.#deps.input.press(tabId, 'Enter')
    io.emit({ kind: 'status', status: 'submitted' })
    let retriedSubmit = false
    let latest: ProbeResult | null = null
    for (;;) {
      if (io.signal.aborted) throw new ConnectorError('CANCELLED', 'cancelled before the chat answered')
      latest = await this.#probe(tabId, harness, 'poll')
      if (latest.newest !== null || latest.stop !== null) break
      const waited = Date.now() - started
      if (!retriedSubmit && waited > 3_000) {
        retriedSubmit = true
        const current = await this.#probe(tabId, harness, 'locate')
        if (current.send !== null && collapse(current.inputText).length > 0) await this.#deps.input.click(tabId, current.send.x, current.send.y)
      }
      if (waited > START_TIMEOUT_MS) throw new ConnectorError('HARNESS_FAILED', 'the chat did not start answering (not signed in, rate-limited, or the page changed — recalibrate in the Tab Manager)')
      await sleep(POLL_MS)
    }

    io.emit({ kind: 'status', status: 'generating' })
    const committer = new BlockStreamCommitter()
    let lastSignature = ''
    let lastChange = Date.now()
    let sawStop = latest.stop !== null || latest.newest?.streaming === true
    let finishReason: LlmGenerateResult['finishReason'] = 'stop'
    let blocks: string[] = latest.newest?.blocks ?? []
    for (;;) {
      if (io.signal.aborted) {
        finishReason = 'cancelled'
        if (latest.stop !== null) await this.#deps.input.click(tabId, latest.stop.x, latest.stop.y).catch(() => undefined)
        break
      }
      if (Date.now() > deadline) {
        finishReason = 'timeout'
        break
      }
      blocks = latest.newest?.blocks ?? blocks
      const signature = `${blocks.length}:${latest.newest?.textLength ?? 0}:${blocks[blocks.length - 1]?.slice(-64) ?? ''}`
      if (signature !== lastSignature) {
        lastSignature = signature
        lastChange = Date.now()
      }
      const delta = committer.update(blocks, false)
      if (delta !== '') io.emit({ kind: 'delta', text: delta })
      const generating = latest.stop !== null || latest.newest?.streaming === true
      if (generating) sawStop = true
      const quietFor = Date.now() - lastChange
      const hasText = (latest.newest?.textLength ?? 0) > 0
      if (!generating && hasText && quietFor >= (sawStop ? 700 : STABLE_MS)) break
      await sleep(POLL_MS)
      latest = await this.#probe(tabId, harness, 'poll')
    }

    const tail = committer.update(blocks, true)
    if (tail !== '') io.emit({ kind: 'delta', text: tail })
    const after = await chrome.tabs.get(tabId)
    return { text: blocks.join('\n\n').slice(0, 2_000_000), finishReason, url: scrubUrl(after.url ?? '') }
  }
}
