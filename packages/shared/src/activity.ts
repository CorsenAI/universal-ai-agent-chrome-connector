import * as z from 'zod'

/** One line of the live activity feed shown in the side panel and the dashboard. */
export const ActivityEntrySchema = z.strictObject({
  id: z.string().max(64),
  ts: z.number().nonnegative(),
  kind: z.enum(['llm', 'mcp', 'system', 'agent', 'security']),
  status: z.enum(['running', 'ok', 'error']),
  /** Short label: a tool name, an endpoint, an event name. */
  title: z.string().max(200),
  detail: z.string().max(1000).optional(),
  durationMs: z.number().nonnegative().optional(),
  tokensSaved: z.number().int().nonnegative().optional(),
  model: z.string().max(200).optional(),
  targetId: z.string().max(32).optional(),
})
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>

export const ActivityTotalsSchema = z.strictObject({
  llmRequests: z.number().int().nonnegative(),
  mcpCalls: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  tokensSaved: z.number().int().nonnegative(),
})
export type ActivityTotals = z.infer<typeof ActivityTotalsSchema>

export const EMPTY_TOTALS: ActivityTotals = Object.freeze({ llmRequests: 0, mcpCalls: 0, errors: 0, tokensSaved: 0 })
