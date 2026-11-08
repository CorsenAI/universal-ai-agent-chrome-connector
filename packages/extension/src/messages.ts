import * as z from 'zod'
import { TabRoleSchema, type ActivityEntry, type ActivityTotals, type DaemonInfo, type HarnessId, type TabRole } from '@corsen-ai/shared'
import type { HarnessOverride } from './harnesses/registry'
import type { LinkStatus } from './background/daemon-link'

/** Messages from the extension's own pages (popup, side panel) to the service worker. */
export const UI_DAEMON_METHODS = ['daemon.info', 'daemon.selftest', 'agents.list', 'agents.connect', 'agents.unlink', 'agents.restore', 'activity.recent'] as const

export const UiRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('getState') }),
  z.strictObject({ type: z.literal('setRole'), tabId: z.number().int().nonnegative(), role: TabRoleSchema }),
  z.strictObject({ type: z.literal('setPairing'), code: z.string().max(100), port: z.number().int().min(1).max(65_535).optional() }),
  z.strictObject({ type: z.literal('forgetPairing') }),
  z.strictObject({ type: z.literal('reconnect'), takeover: z.boolean() }),
  z.strictObject({ type: z.literal('daemonCall'), method: z.enum(UI_DAEMON_METHODS), params: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal('panic') }),
  z.strictObject({ type: z.literal('calibrate'), tabId: z.number().int().nonnegative(), kind: z.enum(['input', 'send', 'stop', 'response']) }),
  z.strictObject({ type: z.literal('clearCalibration'), host: z.string().min(1).max(255) }),
])
export type UiRequest = z.infer<typeof UiRequestSchema>

export interface UiTab {
  readonly tabId: number
  readonly windowId: number
  readonly title: string
  readonly url: string
  readonly host: string
  readonly favIconUrl: string
  readonly role: TabRole
  readonly harnessId: HarnessId | null
  readonly restricted: boolean
  readonly attached: boolean
  readonly busy: boolean
  readonly consoleErrors: number
  readonly networkErrors: number
  readonly active: boolean
}

export interface UiState {
  readonly version: string
  readonly link: { readonly status: LinkStatus; readonly detail: string; readonly port: number; readonly daemonVersion: string | null; readonly paired: boolean }
  readonly tabs: readonly UiTab[]
  readonly activity: readonly ActivityEntry[]
  readonly totals: ActivityTotals
  readonly daemon: DaemonInfo | null
  readonly calibrations: Readonly<Record<string, HarnessOverride>>
}

export type UiResponse<T = unknown> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Port name the UI uses to receive live state pushes. */
export const UI_PORT = 'corsen-ui'
