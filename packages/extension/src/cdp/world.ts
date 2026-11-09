import { ConnectorError } from '@corsen-ai/shared'
import type { DebuggerManager } from './debugger-manager'

const WORLD_NAME = 'corsen-connector'

export interface WorldTimings {
  /** Default per-call limit; a call that has not answered by then is treated like a lost context. */
  readonly callTimeoutMs: number
  /** Calls made per request before giving up (each one on a freshly created world). */
  readonly attempts: number
  readonly retryDelayMs: number
}

const DEFAULT_TIMINGS: WorldTimings = { callTimeoutMs: 15_000, attempts: 5, retryDelayMs: 120 }

export interface CallOptions {
  /** Overrides the default per-call limit, e.g. for an in-page function that waits for the user. */
  readonly timeoutMs?: number
}

type DebuggerPort = Pick<DebuggerManager, 'send' | 'onEvent' | 'onDetach'>

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Errors that mean "this execution context is gone" rather than "the page function failed": a
 * navigation or a document replacement in progress, or a context that stopped answering (a frozen,
 * replaced document). An exception thrown by our own in-page function is reported as
 * `in-page error: …` and is never retried.
 */
export function isContextLoss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('in-page error')) return false
  return /execution context|Cannot find context|context was destroyed|detached|No frame|frame .*not found|did not answer within/i.test(message)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ConnectorError('TIMEOUT', `the page call did not answer within ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Runs self-contained functions inside an isolated world of the tab's main frame
 * (`Page.createIsolatedWorld`): page scripts cannot see or tamper with our code and globals, while we
 * see the same DOM. The context id is cached per tab and forgotten when the main frame navigates, the
 * context is destroyed or the debugger detaches. Chat sites often replace their document when the
 * first message of a conversation is sent: when the cached context is gone, or a call stops
 * answering, the world is created again on the current document and the call is retried, so a
 * request never hangs on a stale context. The functions run this way only read the page (or wait for
 * the user, with their own limit), so running one again is safe.
 */
export class IsolatedWorlds {
  readonly #debugger: DebuggerPort
  readonly #timings: WorldTimings
  readonly #contexts = new Map<number, number>()

  constructor(manager: DebuggerPort, timings: Partial<WorldTimings> = {}) {
    this.#debugger = manager
    this.#timings = { ...DEFAULT_TIMINGS, ...timings }
    manager.onEvent((tabId, method, params) => {
      if (method === 'Runtime.executionContextsCleared') this.#contexts.delete(tabId)
      else if (method === 'Runtime.executionContextDestroyed' && params['executionContextId'] === this.#contexts.get(tabId)) this.#contexts.delete(tabId)
      else if (method === 'Page.frameNavigated') {
        const frame = params['frame'] as { parentId?: string } | undefined
        if (frame !== undefined && frame.parentId === undefined) this.#contexts.delete(tabId)
      }
    })
    manager.onDetach((tabId) => this.#contexts.delete(tabId))
  }

  async #context(tabId: number): Promise<number> {
    const cached = this.#contexts.get(tabId)
    if (cached !== undefined) return cached
    const { frameTree } = await this.#debugger.send(tabId, 'Page.getFrameTree')
    const { executionContextId } = await this.#debugger.send(tabId, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD_NAME, grantUniveralAccess: false })
    this.#contexts.set(tabId, executionContextId)
    return executionContextId
  }

  /** Resolve the world (created on the current document if needed) and run `step`; on a lost context, recreate and retry. */
  async #attempt<T>(tabId: number, options: CallOptions, step: (contextId: number) => Promise<T>): Promise<T> {
    const limit = options.timeoutMs ?? this.#timings.callTimeoutMs
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await withTimeout(
          this.#context(tabId).then((contextId) => step(contextId)),
          limit,
        )
      } catch (error) {
        if (!isContextLoss(error)) throw error
        this.#contexts.delete(tabId)
        if (attempt >= this.#timings.attempts) throw error
        await sleep(this.#timings.retryDelayMs)
      }
    }
  }

  /** Call `fn(...args)` in the world and return its JSON result (awaits promises). */
  call<A extends unknown[], R>(tabId: number, fn: (...args: A) => R, args: A, options: CallOptions = {}): Promise<Awaited<R>> {
    return this.#attempt<unknown>(tabId, options, async (contextId) => {
      const response = await this.#debugger.send(tabId, 'Runtime.callFunctionOn', {
        functionDeclaration: fn.toString(),
        executionContextId: contextId,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      })
      if (response.exceptionDetails !== undefined) {
        const description = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
        throw new ConnectorError('ACTION_FAILED', `in-page error: ${description.slice(0, 500)}`)
      }
      return response.result.value as unknown
    }) as Promise<Awaited<R>>
  }

  /** Like call(), but returns a remote object id (for element handles), or null. */
  callForObject<A extends unknown[]>(tabId: number, fn: (...args: A) => unknown, args: A, options: CallOptions = {}): Promise<string | null> {
    return this.#attempt(tabId, options, async (contextId) => {
      const response = await this.#debugger.send(tabId, 'Runtime.callFunctionOn', {
        functionDeclaration: fn.toString(),
        executionContextId: contextId,
        arguments: args.map((value) => ({ value })),
        returnByValue: false,
        awaitPromise: true,
      })
      if (response.exceptionDetails !== undefined) throw new ConnectorError('ACTION_FAILED', `in-page error: ${response.exceptionDetails.text}`)
      if (response.result.subtype === 'null' || response.result.objectId === undefined) return null
      return response.result.objectId
    })
  }

  forget(tabId: number): void {
    this.#contexts.delete(tabId)
  }
}
