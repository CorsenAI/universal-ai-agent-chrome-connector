import * as z from 'zod'

/** Agents the 1-click configurator knows how to detect and connect. */
export const AGENT_IDS = [
  'claude-code',
  'cursor',
  'windsurf',
  'devin',
  'claude-desktop',
  'cline',
  'roo-code',
  'opencode',
] as const
export type AgentId = (typeof AGENT_IDS)[number]
export const AgentIdSchema = z.enum(AGENT_IDS)

export const AGENT_LABELS: Readonly<Record<AgentId, string>> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf (legacy Cascade)',
  devin: 'Devin Desktop (ex-Windsurf)',
  'claude-desktop': 'Claude Desktop',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  opencode: 'OpenCode',
}

/** What the configurator reports for one agent (paths are shown with `~` for the home directory). */
export const AgentStatusSchema = z.strictObject({
  id: AgentIdSchema,
  name: z.string().max(80),
  detected: z.boolean(),
  connected: z.boolean(),
  method: z.enum(['cli', 'file']),
  configPaths: z.array(z.string().max(1024)).max(16),
  backups: z.number().int().nonnegative(),
  needsRestart: z.boolean(),
  notes: z.array(z.string().max(500)).max(8),
})
export type AgentStatus = z.infer<typeof AgentStatusSchema>

export const AgentActionResultSchema = z.strictObject({
  agent: AgentStatusSchema,
  changed: z.boolean(),
  message: z.string().max(1000),
  backupPaths: z.array(z.string().max(1024)).max(16),
})
export type AgentActionResult = z.infer<typeof AgentActionResultSchema>
