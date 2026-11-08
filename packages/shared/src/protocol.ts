import * as z from 'zod'
import { ActivityEntrySchema, ActivityTotalsSchema } from './activity'
import { LIMITS } from './constants'
import { ErrorCodeSchema, WireErrorSchema } from './errors'
import { BrowserStateSchema } from './tabs'

/**
 * WebSocket frames between the extension (client) and the daemon (server).
 *
 * Handshake:   daemon → challenge · extension → hello · daemon → paired | denied (then close)
 * After it:    rpc / rpc_result / rpc_event / rpc_cancel in both directions,
 *              extension → state, ping · daemon → activity, pong.
 * Unknown types are refused, never ignored (strict objects + discriminated unions).
 */

export const IdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/)
export const Hex32Schema = z.string().regex(/^[0-9a-f]{32}$/)
export const Hex64Schema = z.string().regex(/^[0-9a-f]{64}$/)
const Version = z.string().max(40)
const MethodName = z.string().regex(/^[a-z]+(\.[A-Za-z]+)+$/).max(60)

export const ChallengeFrameSchema = z.strictObject({
  type: z.literal('challenge'),
  nonce: Hex32Schema,
  protocolVersion: z.number().int(),
  daemonVersion: Version,
})

export const HelloFrameSchema = z.strictObject({
  type: z.literal('hello'),
  role: z.literal('browser'),
  browserId: IdSchema,
  browserName: z.string().max(120),
  nonce: Hex32Schema,
  proof: Hex64Schema,
  protocolVersion: z.number().int(),
  extensionVersion: Version,
  capabilities: z.array(z.string().max(60)).max(100),
  /** Set when the user explicitly asked this browser to take over from another one. */
  takeover: z.boolean(),
})

export const PairedFrameSchema = z.strictObject({
  type: z.literal('paired'),
  proof: Hex64Schema,
  protocolVersion: z.number().int(),
  daemonVersion: Version,
  connectionId: IdSchema,
})

export const DeniedFrameSchema = z.strictObject({
  type: z.literal('denied'),
  code: ErrorCodeSchema,
  message: z.string().max(1000),
})

export const RpcFrameSchema = z.strictObject({
  type: z.literal('rpc'),
  id: IdSchema,
  method: MethodName,
  params: z.unknown(),
})

export const RpcResultFrameSchema = z
  .strictObject({
    type: z.literal('rpc_result'),
    id: IdSchema,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: WireErrorSchema.optional(),
  })
  .refine((frame) => (frame.ok ? frame.error === undefined : frame.error !== undefined), {
    message: 'rpc_result must carry error exactly when ok is false',
  })

export const RpcEventFrameSchema = z.strictObject({
  type: z.literal('rpc_event'),
  id: IdSchema,
  event: z.unknown(),
})

export const RpcCancelFrameSchema = z.strictObject({
  type: z.literal('rpc_cancel'),
  id: IdSchema,
})

export const StateFrameSchema = z.strictObject({
  type: z.literal('state'),
  state: BrowserStateSchema,
})

export const ActivityFrameSchema = z.strictObject({
  type: z.literal('activity'),
  entries: z.array(ActivityEntrySchema).max(200),
  totals: ActivityTotalsSchema,
})

export const PingFrameSchema = z.strictObject({ type: z.literal('ping'), ts: z.number().nonnegative() })
export const PongFrameSchema = z.strictObject({ type: z.literal('pong'), ts: z.number().nonnegative() })

/** Frames the daemon sends. */
export const ServerFrameSchema = z.union([
  ChallengeFrameSchema,
  PairedFrameSchema,
  DeniedFrameSchema,
  RpcFrameSchema,
  RpcResultFrameSchema,
  RpcEventFrameSchema,
  RpcCancelFrameSchema,
  ActivityFrameSchema,
  PongFrameSchema,
])

/** Frames the extension sends. */
export const ClientFrameSchema = z.union([
  HelloFrameSchema,
  RpcFrameSchema,
  RpcResultFrameSchema,
  RpcEventFrameSchema,
  RpcCancelFrameSchema,
  StateFrameSchema,
  PingFrameSchema,
])

export type ChallengeFrame = z.infer<typeof ChallengeFrameSchema>
export type HelloFrame = z.infer<typeof HelloFrameSchema>
export type PairedFrame = z.infer<typeof PairedFrameSchema>
export type DeniedFrame = z.infer<typeof DeniedFrameSchema>
export type RpcFrame = z.infer<typeof RpcFrameSchema>
export type RpcResultFrame = z.infer<typeof RpcResultFrameSchema>
export type RpcEventFrame = z.infer<typeof RpcEventFrameSchema>
export type RpcCancelFrame = z.infer<typeof RpcCancelFrameSchema>
export type StateFrame = z.infer<typeof StateFrameSchema>
export type ActivityFrame = z.infer<typeof ActivityFrameSchema>
export type ServerFrame = z.infer<typeof ServerFrameSchema>
export type ClientFrame = z.infer<typeof ClientFrameSchema>

export type FrameParse<T> = { ok: true; frame: T } | { ok: false; code: 'TOO_LARGE' | 'MALFORMED'; message: string }

function parseFrame<T>(raw: string, schema: z.ZodType<T>): FrameParse<T> {
  if (raw.length > LIMITS.MAX_FRAME_BYTES) {
    return { ok: false, code: 'TOO_LARGE', message: `frame exceeds ${LIMITS.MAX_FRAME_BYTES} bytes` }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'MALFORMED', message: 'frame is not valid JSON' }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue !== undefined && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : ''
    return { ok: false, code: 'MALFORMED', message: `invalid frame${where}: ${issue?.message ?? 'unknown issue'}` }
  }
  return { ok: true, frame: parsed.data }
}

export function parseClientFrame(raw: string): FrameParse<ClientFrame> {
  return parseFrame(raw, ClientFrameSchema)
}

export function parseServerFrame(raw: string): FrameParse<ServerFrame> {
  return parseFrame(raw, ServerFrameSchema)
}
