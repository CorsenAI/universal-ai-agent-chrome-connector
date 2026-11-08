import * as z from 'zod'
import { ActivityEntrySchema, ActivityTotalsSchema } from './activity'
import { AgentActionResultSchema, AgentIdSchema, AgentStatusSchema } from './agents'
import { CapturedCallSchema, DevtoolsEntrySchema, DevtoolsKindSchema, DevtoolsTotalsSchema } from './devtools'
import { HarnessIdSchema } from './harnesses'
import { ACT_ACTIONS } from './mcp-tools'
import { McpTargetSchema, TabInfoSchema, TabRoleSchema } from './tabs'

/**
 * RPC contracts carried by `rpc` / `rpc_result` / `rpc_event` frames. Each side validates the params
 * it receives and the results it gets back against these schemas.
 */

const TabId = z.number().int().nonnegative()

export const ActParamsSchema = z.strictObject({
  action: z.enum(ACT_ACTIONS),
  ref: z.string().regex(/^e\d{1,9}$/).optional(),
  selector: z.string().min(1).max(500).optional(),
  text: z.string().max(20_000).optional(),
  submit: z.boolean().optional(),
  clear: z.boolean().optional(),
  key: z.string().min(1).max(40).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().min(1).max(20_000).optional(),
  value: z.string().max(500).optional(),
  url: z.string().min(1).max(2048).optional(),
  timeoutMs: z.number().int().min(0).max(30_000).optional(),
})
export type ActParams = z.infer<typeof ActParamsSchema>

export const ReadPageResultSchema = z.strictObject({
  title: z.string().max(1000),
  url: z.string().max(2048),
  mode: z.enum(['markdown', 'accessibility']),
  content: z.string(),
  refCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** Size of the page source the distiller started from, and of what it returned (tokens-saved metric). */
  sourceChars: z.number().int().nonnegative(),
  outputChars: z.number().int().nonnegative(),
})
export type ReadPageResult = z.infer<typeof ReadPageResultSchema>

export const LlmEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status'), status: z.enum(['navigating', 'typing', 'submitted', 'generating']) }),
  z.strictObject({ kind: z.literal('delta'), text: z.string().max(200_000) }),
])
export type LlmEvent = z.infer<typeof LlmEventSchema>

export const LlmGenerateResultSchema = z.strictObject({
  text: z.string().max(2_000_000),
  finishReason: z.enum(['stop', 'length', 'cancelled', 'timeout']),
  url: z.string().max(2048),
})
export type LlmGenerateResult = z.infer<typeof LlmGenerateResultSchema>

interface MethodContract {
  readonly params: z.ZodType
  readonly result: z.ZodType
  readonly event?: z.ZodType
}

/** Methods the daemon calls on the extension. */
export const EXTENSION_METHODS = {
  'targets.list': {
    params: z.strictObject({}),
    result: z.strictObject({ targets: z.array(McpTargetSchema).max(500) }),
  },
  'page.read': {
    params: z.strictObject({
      tabId: TabId,
      mode: z.enum(['markdown', 'accessibility']),
      maxChars: z.number().int().min(500).max(400_000),
      scope: z.enum(['full', 'main']),
    }),
    result: ReadPageResultSchema,
  },
  'page.act': {
    params: z.strictObject({ tabId: TabId, act: ActParamsSchema }),
    result: z.strictObject({
      summary: z.string().max(2000),
      url: z.string().max(2048),
      title: z.string().max(1000),
      navigated: z.boolean(),
    }),
  },
  'devtools.errors': {
    params: z.strictObject({
      tabId: TabId,
      kinds: z.array(DevtoolsKindSchema).max(4),
      sinceId: z.number().int().min(0),
      limit: z.number().int().min(1).max(300),
      clear: z.boolean(),
    }),
    result: z.strictObject({
      entries: z.array(DevtoolsEntrySchema).max(300),
      totals: DevtoolsTotalsSchema,
      lastId: z.number().int().min(0),
    }),
  },
  'network.capture': {
    params: z.strictObject({
      tabId: TabId,
      urlContains: z.string().max(500),
      method: z.string().max(16),
      kind: z.enum(['json', 'graphql', 'any']),
      sinceId: z.number().int().min(0),
      limit: z.number().int().min(1).max(100),
      includeBodies: z.boolean(),
      maxBodyChars: z.number().int().min(100).max(400_000),
    }),
    result: z.strictObject({ calls: z.array(CapturedCallSchema).max(100), lastId: z.number().int().min(0) }),
  },
  'page.screenshot': {
    params: z.strictObject({
      tabId: TabId,
      format: z.enum(['webp', 'png', 'jpeg']),
      quality: z.number().int().min(1).max(100),
      fullPage: z.boolean(),
      bringToFront: z.boolean(),
    }),
    result: z.strictObject({
      mimeType: z.enum(['image/webp', 'image/png', 'image/jpeg']),
      data: z.string(),
      width: z.number().int().nonnegative(),
      height: z.number().int().nonnegative(),
    }),
  },
  'llm.generate': {
    params: z.strictObject({
      tabId: TabId,
      harnessId: HarnessIdSchema,
      prompt: z.string().min(1).max(400_000),
      newChat: z.boolean(),
      timeoutMs: z.number().int().min(1_000).max(30 * 60_000),
    }),
    result: LlmGenerateResultSchema,
    event: LlmEventSchema,
  },
  'tabs.setRole': {
    params: z.strictObject({ tabId: TabId, role: TabRoleSchema }),
    result: z.strictObject({ tab: TabInfoSchema.nullable() }),
  },
  'system.panic': {
    params: z.strictObject({}),
    result: z.strictObject({ detached: z.number().int().nonnegative() }),
  },
  'system.echo': {
    params: z.strictObject({ nonce: z.string().max(64) }),
    result: z.strictObject({ nonce: z.string().max(64), extensionVersion: z.string().max(40) }),
  },
} as const satisfies Record<string, MethodContract>

export const SelftestStepSchema = z.strictObject({
  name: z.string().max(80),
  ok: z.boolean(),
  ms: z.number().nonnegative(),
  detail: z.string().max(500),
})

export const DaemonInfoSchema = z.strictObject({
  version: z.string().max(40),
  protocolVersion: z.number().int(),
  port: z.number().int().min(1).max(65_535),
  apiBaseUrl: z.string().max(200),
  anthropicBaseUrl: z.string().max(200),
  mcpUrl: z.string().max(200),
  apiToken: z.string().max(200),
  dashboardUrl: z.string().max(400),
  models: z.array(z.string().max(80)).max(32),
})
export type DaemonInfo = z.infer<typeof DaemonInfoSchema>

/** Methods the extension calls on the daemon (side panel / popup actions). */
export const DAEMON_METHODS = {
  'daemon.info': {
    params: z.strictObject({}),
    result: DaemonInfoSchema,
  },
  'daemon.selftest': {
    params: z.strictObject({}),
    result: z.strictObject({ ok: z.boolean(), steps: z.array(SelftestStepSchema).max(20) }),
  },
  'agents.list': {
    params: z.strictObject({}),
    result: z.strictObject({ agents: z.array(AgentStatusSchema).max(32) }),
  },
  'agents.connect': { params: z.strictObject({ agentId: AgentIdSchema }), result: AgentActionResultSchema },
  'agents.unlink': { params: z.strictObject({ agentId: AgentIdSchema }), result: AgentActionResultSchema },
  'agents.restore': { params: z.strictObject({ agentId: AgentIdSchema }), result: AgentActionResultSchema },
  'activity.recent': {
    params: z.strictObject({ limit: z.number().int().min(1).max(500) }),
    result: z.strictObject({ entries: z.array(ActivityEntrySchema).max(500), totals: ActivityTotalsSchema }),
  },
} as const satisfies Record<string, MethodContract>

export type ExtensionMethod = keyof typeof EXTENSION_METHODS
export type ExtensionParams<M extends ExtensionMethod> = z.infer<(typeof EXTENSION_METHODS)[M]['params']>
export type ExtensionResult<M extends ExtensionMethod> = z.infer<(typeof EXTENSION_METHODS)[M]['result']>

export type DaemonMethod = keyof typeof DAEMON_METHODS
export type DaemonParams<M extends DaemonMethod> = z.infer<(typeof DAEMON_METHODS)[M]['params']>
export type DaemonResult<M extends DaemonMethod> = z.infer<(typeof DAEMON_METHODS)[M]['result']>

export function isExtensionMethod(name: string): name is ExtensionMethod {
  return Object.hasOwn(EXTENSION_METHODS, name)
}

export function isDaemonMethod(name: string): name is DaemonMethod {
  return Object.hasOwn(DAEMON_METHODS, name)
}

/** Capabilities the extension declares in its hello (method names it implements). */
export const EXTENSION_CAPABILITIES: readonly ExtensionMethod[] = Object.keys(EXTENSION_METHODS) as ExtensionMethod[]
