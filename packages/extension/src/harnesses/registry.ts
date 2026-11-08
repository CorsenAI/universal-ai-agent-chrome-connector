import type { HarnessId } from '@corsen-ai/shared'
import { GENERIC_HARNESS, GENERIC_SELECTORS, HARNESSES, type HarnessSelectors, type LLMWebHarness } from './definitions'

/** What the user calibrated with the visual picker for one host. Takes precedence over definitions. */
export interface HarnessOverride {
  readonly input?: string | undefined
  readonly send?: string | undefined
  readonly stop?: string | undefined
  readonly response?: string | undefined
  readonly newChatUrl?: string | undefined
  readonly updatedAt: number
}

export type HarnessOverrides = Readonly<Record<string, HarnessOverride>>

export interface ResolvedHarness extends LLMWebHarness {
  readonly calibrated: boolean
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function matchesHost(host: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
}

/** The harness for a URL: a built-in site, a calibrated site (generic), or null. Pure. */
export function detectHarness(url: string, overrides: HarnessOverrides): HarnessId | null {
  const host = hostOf(url)
  if (host === '') return null
  const builtIn = HARNESSES.find((harness) => matchesHost(host, harness.hosts))
  if (builtIn !== undefined) return builtIn.id
  const override = overrides[host]
  return override?.input !== undefined && override.response !== undefined ? 'generic' : null
}

function merge(first: string | undefined, rest: readonly string[], generic: readonly string[]): string[] {
  const list = [...(first !== undefined ? [first] : []), ...rest, ...generic]
  return [...new Set(list)]
}

/** Definition + calibration + generic fallbacks, in that order of precedence. Pure. */
export function resolveHarness(id: HarnessId, url: string, overrides: HarnessOverrides): ResolvedHarness {
  const base = id === 'generic' ? GENERIC_HARNESS : (HARNESSES.find((harness) => harness.id === id) ?? GENERIC_HARNESS)
  const override = overrides[hostOf(url)]
  const selectors: HarnessSelectors = {
    input: merge(override?.input, id === 'generic' ? [] : base.selectors.input, GENERIC_SELECTORS.input),
    send: merge(override?.send, id === 'generic' ? [] : base.selectors.send, GENERIC_SELECTORS.send),
    stop: merge(override?.stop, id === 'generic' ? [] : base.selectors.stop, GENERIC_SELECTORS.stop),
    response: merge(override?.response, id === 'generic' ? [] : base.selectors.response, id === 'generic' ? [] : GENERIC_SELECTORS.response),
    exclude: merge(undefined, base.selectors.exclude, GENERIC_SELECTORS.exclude),
  }
  return {
    ...base,
    newChatUrl: override?.newChatUrl ?? base.newChatUrl,
    selectors,
    calibrated: override !== undefined,
  }
}
