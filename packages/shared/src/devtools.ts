import * as z from 'zod'

/** Header map after redaction (credential headers are masked, see `redact.ts`). */
export const HeaderMapSchema = z.record(z.string().max(200), z.string().max(8000))
export type HeaderMap = z.infer<typeof HeaderMapSchema>

export const DEVTOOLS_KINDS = ['console', 'exception', 'log', 'network'] as const
export type DevtoolsKind = (typeof DEVTOOLS_KINDS)[number]
export const DevtoolsKindSchema = z.enum(DEVTOOLS_KINDS)

export const NetworkFailureSchema = z.strictObject({
  method: z.string().max(16),
  url: z.string().max(2048),
  /** HTTP status, or 0 when the request failed below HTTP (DNS, CORS, blocked, aborted). */
  status: z.number().int().min(0).max(999),
  statusText: z.string().max(200),
  resourceType: z.string().max(40),
  mimeType: z.string().max(200).optional(),
  errorText: z.string().max(1000).optional(),
  requestHeaders: HeaderMapSchema.optional(),
  responseHeaders: HeaderMapSchema.optional(),
  requestBody: z.string().max(20_000).optional(),
  responseBody: z.string().max(20_000).optional(),
  responseBodyTruncated: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
})
export type NetworkFailure = z.infer<typeof NetworkFailureSchema>

/** One captured DevTools problem on an MCP target tab. */
export const DevtoolsEntrySchema = z.strictObject({
  /** Monotonic per tab, so an agent can ask for entries after the last one it saw. */
  id: z.number().int().nonnegative(),
  kind: DevtoolsKindSchema,
  level: z.enum(['error', 'warning']),
  timestamp: z.number().nonnegative(),
  message: z.string().max(20_000),
  url: z.string().max(2048).optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  stack: z.string().max(20_000).optional(),
  network: NetworkFailureSchema.optional(),
})
export type DevtoolsEntry = z.infer<typeof DevtoolsEntrySchema>

export const DevtoolsTotalsSchema = z.strictObject({
  console: z.number().int().nonnegative(),
  exception: z.number().int().nonnegative(),
  log: z.number().int().nonnegative(),
  network: z.number().int().nonnegative(),
})
export type DevtoolsTotals = z.infer<typeof DevtoolsTotalsSchema>

/** One JSON or GraphQL exchange captured on an MCP target tab. */
export const CapturedCallSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  kind: z.enum(['json', 'graphql']),
  method: z.string().max(16),
  url: z.string().max(2048),
  status: z.number().int().min(0).max(999),
  mimeType: z.string().max(200),
  timestamp: z.number().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  graphqlOperation: z.string().max(200).optional(),
  requestHeaders: HeaderMapSchema.optional(),
  requestBody: z.string().max(100_000).optional(),
  responseBody: z.string().max(400_000).optional(),
  responseBodyTruncated: z.boolean(),
})
export type CapturedCall = z.infer<typeof CapturedCallSchema>

/** Classify a response as JSON/GraphQL worth capturing for agents. Pure; used by the network tap. */
export function classifyApiResponse(input: {
  url: string
  mimeType: string
  requestBody?: string | undefined
}): 'json' | 'graphql' | null {
  const mime = input.mimeType.toLowerCase()
  const isJson = mime.includes('json') // application/json, application/graphql-response+json, +json
  let path = ''
  try {
    path = new URL(input.url).pathname.toLowerCase()
  } catch {
    path = input.url.toLowerCase()
  }
  const body = input.requestBody ?? ''
  const looksGraphql =
    path.includes('graphql') ||
    mime.includes('graphql') ||
    /^\s*\{\s*"(query|operationName|extensions)"\s*:/.test(body) ||
    /^\s*\[\s*\{\s*"(query|operationName)"\s*:/.test(body)
  if (looksGraphql && (isJson || mime === '')) return 'graphql'
  if (isJson) return 'json'
  return null
}

/** Best-effort GraphQL operation name from a request body. */
export function graphqlOperationName(body: string | undefined): string | undefined {
  if (body === undefined || body === '') return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (first !== null && typeof first === 'object') {
      const record = first as Record<string, unknown>
      if (typeof record['operationName'] === 'string' && record['operationName'] !== '') {
        return record['operationName'].slice(0, 200)
      }
      if (typeof record['query'] === 'string') {
        const match = /\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(record['query'])
        if (match?.[2] !== undefined) return match[2]
      }
    }
  } catch {
    // not JSON
  }
  return undefined
}
