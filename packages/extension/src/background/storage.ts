import { DEFAULT_PORT, type TabRole } from '@corsen-ai/shared'
import type { HarnessOverride, HarnessOverrides } from '../harnesses/registry'

/**
 * Persistent settings (chrome.storage.local) and tab roles (chrome.storage.session).
 *
 * Roles live in session storage on purpose: Chrome tab ids do not survive a browser restart, so
 * roles must not either (privacy by default: after a restart every tab is Ignored again). The
 * pairing secret is a loopback-only secret kept in local storage so pairing survives restarts
 * (D-004, same trade-off as the Corsen DSH Connector).
 */

export interface Settings {
  readonly port: number
  readonly pairingSecret: string
  readonly browserId: string
  readonly harnessOverrides: HarnessOverrides
}

const SETTINGS_KEY = 'settings'
const ROLES_KEY = 'roles'
const SESSION_FLAGS_KEY = 'flags'

export interface RoleRecord {
  readonly role: Exclude<TabRole, 'ignored'>
  readonly setAt: number
}

export interface SessionFlags {
  /** Another browser took over the daemon: do not reconnect automatically until the user asks. */
  readonly superseded: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function getSettings(): Promise<Settings> {
  const bag = await chrome.storage.local.get(SETTINGS_KEY)
  const raw = isRecord(bag[SETTINGS_KEY]) ? bag[SETTINGS_KEY] : {}
  const settings: Settings = {
    port: typeof raw['port'] === 'number' && Number.isInteger(raw['port']) ? raw['port'] : DEFAULT_PORT,
    pairingSecret: typeof raw['pairingSecret'] === 'string' ? raw['pairingSecret'] : '',
    browserId: typeof raw['browserId'] === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(raw['browserId']) ? raw['browserId'] : crypto.randomUUID(),
    harnessOverrides: isRecord(raw['harnessOverrides']) ? (raw['harnessOverrides'] as HarnessOverrides) : {},
  }
  if (raw['browserId'] !== settings.browserId) await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
  return settings
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}

export async function setHarnessOverride(host: string, patch: Partial<Omit<HarnessOverride, 'updatedAt'>> | null): Promise<HarnessOverrides> {
  const settings = await getSettings()
  const overrides: Record<string, HarnessOverride> = { ...settings.harnessOverrides }
  if (patch === null) delete overrides[host]
  else overrides[host] = { ...overrides[host], ...patch, updatedAt: Date.now() }
  await patchSettings({ harnessOverrides: overrides })
  return overrides
}

export async function loadRoles(): Promise<Map<number, RoleRecord>> {
  const bag = await chrome.storage.session.get(ROLES_KEY)
  const raw = isRecord(bag[ROLES_KEY]) ? bag[ROLES_KEY] : {}
  const roles = new Map<number, RoleRecord>()
  for (const [key, value] of Object.entries(raw)) {
    const tabId = Number(key)
    if (!Number.isInteger(tabId) || !isRecord(value)) continue
    if (value['role'] === 'brain' || value['role'] === 'mcp') roles.set(tabId, { role: value['role'], setAt: Number(value['setAt']) || Date.now() })
  }
  return roles
}

export async function saveRoles(roles: ReadonlyMap<number, RoleRecord>): Promise<void> {
  await chrome.storage.session.set({ [ROLES_KEY]: Object.fromEntries([...roles].map(([tabId, record]) => [String(tabId), record])) })
}

export async function getFlags(): Promise<SessionFlags> {
  const bag = await chrome.storage.session.get(SESSION_FLAGS_KEY)
  const raw = isRecord(bag[SESSION_FLAGS_KEY]) ? bag[SESSION_FLAGS_KEY] : {}
  return { superseded: raw['superseded'] === true }
}

export async function setFlags(flags: SessionFlags): Promise<void> {
  await chrome.storage.session.set({ [SESSION_FLAGS_KEY]: flags })
}
