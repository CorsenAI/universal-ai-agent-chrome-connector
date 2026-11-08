import * as z from 'zod'

/**
 * Every refusal carries one of these codes. Callers and tests match on the code, never on the
 * message, so messages can improve without breaking anyone.
 */
export const ERROR_CODES = [
  'NO_BROWSER', // no paired extension is connected
  'NO_TARGET', // no tab is exposed as an MCP target (or the given target_id is not one)
  'AMBIGUOUS_TARGET', // several MCP targets exist and none was named
  'TAB_GONE', // the tab no longer exists
  'RESTRICTED_PAGE', // chrome://, Web Store and other pages Chrome forbids
  'DEBUGGER_DENIED', // attach failed or the user cancelled the debugging banner
  'ACTION_FAILED', // the page refused or could not perform the action
  'STALE_REF', // the element reference is from an earlier document or the element is gone
  'NOT_FOUND', // selector / element / option not found
  'INVALID_ARGUMENT', // the call is well-formed JSON but semantically wrong
  'TIMEOUT',
  'INTERRUPTED', // dispatched, outcome unknown (connection lost mid-call)
  'CANCELLED',
  'NO_BRAIN', // no tab is set as LLM Brain (for the requested model)
  'BRAIN_BUSY', // queue full for the brain tab
  'HARNESS_FAILED', // the web chat did not accept the prompt or produce an answer
  'UNSUPPORTED',
  'PROTOCOL_VERSION',
  'UNAUTHENTICATED',
  'SUPERSEDED', // another browser became the active one
  'MALFORMED',
  'TOO_LARGE',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]
export const ErrorCodeSchema = z.enum(ERROR_CODES)

export const WireErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().max(4000),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type WireError = z.infer<typeof WireErrorSchema>

/** An error that knows its wire code. Thrown inside handlers, serialized at the boundary. */
export class ConnectorError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ConnectorError'
    this.code = code
    this.details = details
  }

  toWire(): WireError {
    const wire: WireError = { code: this.code, message: this.message.slice(0, 4000) }
    if (this.details !== undefined) wire.details = this.details
    return wire
  }
}

/** Serialize anything thrown into a wire error without leaking stack traces. */
export function toWireError(error: unknown): WireError {
  if (error instanceof ConnectorError) return error.toWire()
  if (isWireError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'INTERNAL', message: message.slice(0, 4000) || 'Internal error' }
}

export function isWireError(value: unknown): value is WireError {
  return WireErrorSchema.safeParse(value).success
}

/** Rebuild a throwable error from a wire error received from the peer. */
export function fromWireError(wire: WireError): ConnectorError {
  return new ConnectorError(wire.code, wire.message, wire.details)
}
