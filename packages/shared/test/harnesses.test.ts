import { describe, expect, it } from 'vitest'
import { AUTO_MODEL, modelIdForHarness, resolveModel } from '../src/harnesses'

describe('resolveModel', () => {
  it('treats web-* names as explicit', () => {
    expect(resolveModel('web-deepseek')).toEqual({ harness: 'deepseek', explicit: true })
    expect(resolveModel(AUTO_MODEL)).toEqual({ harness: 'auto', explicit: true })
    expect(resolveModel(modelIdForHarness('gemini'))).toEqual({ harness: 'gemini', explicit: true })
  })

  it('maps vendor model names as aliases', () => {
    expect(resolveModel('claude-sonnet-5-5')).toEqual({ harness: 'claude', explicit: false })
    expect(resolveModel('gpt-5')).toEqual({ harness: 'chatgpt', explicit: false })
    expect(resolveModel('o3-mini')).toEqual({ harness: 'chatgpt', explicit: false })
    expect(resolveModel('deepseek-chat')).toEqual({ harness: 'deepseek', explicit: false })
    expect(resolveModel('qwen3-coder')).toEqual({ harness: 'qwen', explicit: false })
    expect(resolveModel('kimi-k2')).toEqual({ harness: 'kimi', explicit: false })
  })

  it('falls back to auto for unknown names', () => {
    expect(resolveModel('my-local-model')).toEqual({ harness: 'auto', explicit: false })
  })
})
