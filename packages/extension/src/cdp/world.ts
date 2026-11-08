import { ConnectorError } from '@corsen-ai/shared'
import type { DebuggerManager } from './debugger-manager'

const WORLD_NAME = 'corsen-connector'

/**
 * Runs self-contained functions inside an isolated world of the tab's main frame
 * (`Page.createIsolatedWorld`): page scripts cannot see or tamper with our code and globals, while we
 * see the same DOM. The context id is cached per tab and forgotten on navigation.
 */
export class IsolatedWorlds {
  readonly #debugger: DebuggerManager
  readonly #contexts = new Map<number, number>()

  constructor(manager: DebuggerManager) {
    this.#debugger = manager
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

  /** Call `fn(...args)` in the world and return its JSON result (awaits promises). */
  async call<A extends unknown[], R>(tabId: number, fn: (...args: A) => R, args: A): Promise<Awaited<R>> {
    for (let attempt = 0; ; attempt += 1) {
      const contextId = await this.#context(tabId)
      try {
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
        return response.result.value as Awaited<R>
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (attempt === 0 && /context|Execution context was destroyed|Cannot find/i.test(message)) {
          this.#contexts.delete(tabId)
          continue
        }
        throw error
      }
    }
  }

  /** Like call(), but returns a remote object id (for element handles), or null. */
  async callForObject<A extends unknown[]>(tabId: number, fn: (...args: A) => unknown, args: A): Promise<string | null> {
    for (let attempt = 0; ; attempt += 1) {
      const contextId = await this.#context(tabId)
      try {
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (attempt === 0 && /context|Cannot find/i.test(message)) {
          this.#contexts.delete(tabId)
          continue
        }
        throw error
      }
    }
  }

  forget(tabId: number): void {
    this.#contexts.delete(tabId)
  }
}
