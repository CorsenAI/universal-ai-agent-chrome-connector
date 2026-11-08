import * as z from 'zod'
import { HarnessIdSchema } from './harnesses'

/**
 * The three states a tab can be in. `ignored` is the default and means: no debugger, no read, no
 * input. Only the user (popup, side panel, authenticated dashboard) can change a role.
 */
export const TAB_ROLES = ['ignored', 'brain', 'mcp'] as const
export type TabRole = (typeof TAB_ROLES)[number]
export const TabRoleSchema = z.enum(TAB_ROLES)

const TabIdSchema = z.number().int().nonnegative()

/** What the extension reports about one non-ignored tab. URLs are scrubbed before they leave Chrome. */
export const TabInfoSchema = z.strictObject({
  tabId: TabIdSchema,
  windowId: z.number().int(),
  title: z.string().max(500),
  url: z.string().max(2048),
  role: TabRoleSchema,
  /** Harness detected for this URL (or calibrated), null when the site is not a known chat. */
  harnessId: HarnessIdSchema.nullable(),
  /** Whether chrome.debugger is currently attached to the tab. */
  attached: z.boolean(),
  /** A brain tab currently generating. */
  busy: z.boolean(),
  consoleErrors: z.number().int().nonnegative(),
  networkErrors: z.number().int().nonnegative(),
  active: z.boolean(),
})
export type TabInfo = z.infer<typeof TabInfoSchema>

/**
 * Snapshot pushed by the extension whenever roles or tab metadata change. Ignored tabs are never
 * listed (privacy by default); only their count is reported.
 */
export const BrowserStateSchema = z.strictObject({
  extensionVersion: z.string().max(40),
  browserName: z.string().max(120),
  tabs: z.array(TabInfoSchema).max(500),
  hiddenTabCount: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type BrowserState = z.infer<typeof BrowserStateSchema>

/** One MCP target as listed to agents. `targetId` is the Chrome tab id as a string (D-009). */
export const McpTargetSchema = z.strictObject({
  targetId: z.string().max(32),
  title: z.string().max(500),
  url: z.string().max(2048),
  consoleErrors: z.number().int().nonnegative(),
  networkErrors: z.number().int().nonnegative(),
  active: z.boolean(),
})
export type McpTarget = z.infer<typeof McpTargetSchema>

export function targetIdForTab(tabId: number): string {
  return String(tabId)
}

/** Parse a target id back to a tab id; returns null for anything that is not a plain tab id. */
export function tabIdFromTargetId(targetId: string): number | null {
  if (!/^\d{1,10}$/.test(targetId)) return null
  const value = Number(targetId)
  return Number.isSafeInteger(value) ? value : null
}

/** URL schemes and hosts Chrome never lets an extension debug or script. */
export function isRestrictedUrl(url: string): boolean {
  if (url === '') return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  const scheme = parsed.protocol
  if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'file:') return true
  const host = parsed.hostname.toLowerCase()
  if (host === 'chromewebstore.google.com') return true
  if (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return true
  return false
}
