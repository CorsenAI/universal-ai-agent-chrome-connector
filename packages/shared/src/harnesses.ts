import * as z from 'zod'

/**
 * Web chat sites the extension can drive as an "LLM Brain", plus the user-calibrated generic one.
 * The id doubles as the model suffix exposed by the local API (`web-<id>`).
 */
export const HARNESS_IDS = ['deepseek', 'claude', 'chatgpt', 'gemini', 'qwen', 'kimi', 'generic'] as const
export type HarnessId = (typeof HARNESS_IDS)[number]
export const HarnessIdSchema = z.enum(HARNESS_IDS)

export const HARNESS_LABELS: Readonly<Record<HarnessId, string>> = {
  deepseek: 'DeepSeek',
  claude: 'Claude.ai',
  chatgpt: 'ChatGPT',
  gemini: 'Google Gemini',
  qwen: 'Qwen Chat',
  kimi: 'Kimi',
  generic: 'Custom chat (calibrated)',
}

export const MODEL_PREFIX = 'web-'
export const AUTO_MODEL = 'web-auto'

export function modelIdForHarness(harness: HarnessId): string {
  return `${MODEL_PREFIX}${harness}`
}

export interface ModelResolution {
  /** The harness the model maps to, or `auto` for "any available brain". */
  readonly harness: HarnessId | 'auto'
  /** True when the client named a `web-*` model explicitly (no silent fallback allowed). */
  readonly explicit: boolean
}

/**
 * Map a client-supplied model name to a harness.
 *
 * Explicit `web-<harness>` names are strict. Vendor model names (`claude-sonnet-…`, `gpt-…`,
 * `deepseek-chat`, …) are aliases: many clients hardcode them, so they route to the matching web
 * chat when one is available and the router may fall back to any brain otherwise.
 */
export function resolveModel(model: string): ModelResolution {
  const name = model.trim().toLowerCase()
  if (name.startsWith(MODEL_PREFIX)) {
    const rest = name.slice(MODEL_PREFIX.length)
    if (rest === 'auto') return { harness: 'auto', explicit: true }
    const exact = HARNESS_IDS.find((id) => id === rest)
    if (exact !== undefined) return { harness: exact, explicit: true }
  }
  if (name.includes('deepseek')) return { harness: 'deepseek', explicit: false }
  if (/(claude|sonnet|opus|haiku|fable|mythos)/.test(name)) return { harness: 'claude', explicit: false }
  if (/(chatgpt|gpt|^o\d)/.test(name)) return { harness: 'chatgpt', explicit: false }
  if (name.includes('gemini')) return { harness: 'gemini', explicit: false }
  if (/(qwen|qwq)/.test(name)) return { harness: 'qwen', explicit: false }
  if (/(kimi|moonshot)/.test(name)) return { harness: 'kimi', explicit: false }
  return { harness: 'auto', explicit: false }
}
