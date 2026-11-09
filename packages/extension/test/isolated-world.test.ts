import { describe, expect, it } from 'vitest'
import { IsolatedWorlds, isContextLoss } from '../src/cdp/world'

type Listener = (tabId: number, method: string, params: Record<string, unknown>) => void
type Behavior = (contextId: number) => Promise<unknown>

/**
 * A stand-in for the debugger manager: it creates numbered worlds and answers Runtime.callFunctionOn
 * with whatever the test scripts for each context id, so context loss can be replayed exactly.
 */
function fakeDebugger(behavior: Behavior) {
  const listeners: Listener[] = []
  const created: number[] = []
  const calls: number[] = []
  let nextContext = 100
  const port = {
    onEvent(listener: Listener) {
      listeners.push(listener)
      return () => undefined
    },
    onDetach() {
      return () => undefined
    },
    async send(_tabId: number, method: string): Promise<unknown> {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
      if (method === 'Page.createIsolatedWorld') {
        nextContext += 1
        created.push(nextContext)
        return { executionContextId: nextContext }
      }
      throw new Error(`unexpected ${method}`)
    },
  }
  return {
    created,
    calls,
    emit: (method: string, params: Record<string, unknown>) => listeners.forEach((listener) => listener(7, method, params)),
    port: {
      ...port,
      send: async (tabId: number, method: string, params?: { executionContextId?: number }) => {
        if (method !== 'Runtime.callFunctionOn') return port.send(tabId, method)
        const contextId = params?.executionContextId ?? -1
        calls.push(contextId)
        return { result: { value: await behavior(contextId) } }
      },
    } as never,
  }
}

const read = (): string => 'answer'
const fast = { callTimeoutMs: 200, attempts: 5, retryDelayMs: 1 }

describe('isolated world (chat documents replaced while polling)', () => {
  it('creates the world once and reuses it while the document lives', async () => {
    const cdp = fakeDebugger(async () => 'answer')
    const worlds = new IsolatedWorlds(cdp.port, fast)
    expect(await worlds.call(7, read, [])).toBe('answer')
    expect(await worlds.call(7, read, [])).toBe('answer')
    expect(cdp.created).toEqual([101])
  })

  it('recreates the world on the new document when the cached context is gone', async () => {
    const cdp = fakeDebugger(async (contextId) => {
      if (contextId === 101) throw new Error('{"code":-32000,"message":"Cannot find context with specified id"}')
      return 'answer'
    })
    const worlds = new IsolatedWorlds(cdp.port, fast)
    expect(await worlds.call(7, read, [])).toBe('answer')
    expect(cdp.created).toEqual([101, 102])
    expect(cdp.calls).toEqual([101, 102])
  })

  it('forgets the world when the main frame navigates, before any call fails', async () => {
    const cdp = fakeDebugger(async () => 'answer')
    const worlds = new IsolatedWorlds(cdp.port, fast)
    await worlds.call(7, read, [])
    cdp.emit('Page.frameNavigated', { frame: { id: 'main' } })
    await worlds.call(7, read, [])
    cdp.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main' } })
    await worlds.call(7, read, [])
    expect(cdp.created).toEqual([101, 102])
  })

  it('does not hang on a context that stops answering: it times out, recreates the world and retries', async () => {
    const cdp = fakeDebugger((contextId) => (contextId === 101 ? new Promise(() => undefined) : Promise.resolve('answer')))
    const worlds = new IsolatedWorlds(cdp.port, fast)
    const started = Date.now()
    expect(await worlds.call(7, read, [])).toBe('answer')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(cdp.created).toEqual([101, 102])
  })

  it('keeps retrying across several replaced documents, then reports the loss honestly', async () => {
    const lost = fakeDebugger(async () => {
      throw new Error('Execution context was destroyed.')
    })
    const worlds = new IsolatedWorlds(lost.port, fast)
    await expect(worlds.call(7, read, [])).rejects.toThrow(/context was destroyed/)
    expect(lost.created).toHaveLength(5)
  })

  it('never retries an exception thrown by the page function itself', async () => {
    let calls = 0
    const failing = {
      onEvent: () => () => undefined,
      onDetach: () => () => undefined,
      send: async (_tabId: number, method: string): Promise<unknown> => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 101 }
        calls += 1
        return { result: {}, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } } }
      },
    }
    const worlds = new IsolatedWorlds(failing as never, fast)
    await expect(worlds.call(7, read, [])).rejects.toThrow('in-page error: TypeError: boom')
    expect(calls).toBe(1)
  })

  it('gives a call that waits for the user its own, longer limit', async () => {
    const cdp = fakeDebugger(() => new Promise((resolve) => setTimeout(() => resolve('picked'), 400)))
    const worlds = new IsolatedWorlds(cdp.port, fast)
    expect(await worlds.call(7, read, [], { timeoutMs: 2_000 })).toBe('picked')
    expect(cdp.created).toEqual([101])
  })

  it('classifies errors', () => {
    expect(isContextLoss(new Error('Cannot find context with specified id'))).toBe(true)
    expect(isContextLoss(new Error('Execution context was destroyed.'))).toBe(true)
    expect(isContextLoss(new Error('the page call did not answer within 15000 ms'))).toBe(true)
    expect(isContextLoss(new Error('in-page error: Execution context was destroyed'))).toBe(false)
    expect(isContextLoss(new Error('the tab is not attached; set its role again'))).toBe(false)
  })
})
