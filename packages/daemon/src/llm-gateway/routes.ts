import type { Context, Hono } from 'hono'
import * as z from 'zod'
import {
  AnthropicCountTokensRequestSchema,
  AnthropicMessagesRequestSchema,
  OpenAIChatRequestSchema,
  estimateTokens,
  toWireError,
  type ErrorCode,
} from '@corsen-ai/shared'
import type { ActivityLog } from '../activity/activity-log'
import { sseResponse } from '../http/streaming'
import type { Logger } from '../util/logger'
import { AnthropicStreamWriter, anthropicError, anthropicMessage, newMessageId, newToolUseId, normalizeAnthropicRequest } from './anthropic-convert'
import type { BrainRouter } from './brain-router'
import { runChat } from './chat-pipeline'
import { OpenAIStreamWriter, newCompletionId, newToolCallId, normalizeOpenAIRequest, openAICompletion, openAIError } from './openai-convert'
import { renderFullPrompt } from './prompt-builder'

export interface GatewayDeps {
  readonly router: BrainRouter
  readonly activity: ActivityLog
  readonly logger: Logger
  readonly startedAt: number
}

type Status = 400 | 401 | 413 | 429 | 500 | 502 | 503 | 504

function statusFor(code: ErrorCode): Status {
  switch (code) {
    case 'INVALID_ARGUMENT':
    case 'MALFORMED':
    case 'CANCELLED':
      return 400
    case 'UNAUTHENTICATED':
      return 401
    case 'TOO_LARGE':
      return 413
    case 'BRAIN_BUSY':
      return 429
    case 'NO_BROWSER':
    case 'NO_BRAIN':
      return 503
    case 'TIMEOUT':
      return 504
    case 'INTERNAL':
      return 500
    default:
      return 502
  }
}

function openAIType(code: ErrorCode): string {
  const status = statusFor(code)
  if (status === 400 || status === 413) return 'invalid_request_error'
  if (status === 401) return 'authentication_error'
  if (status === 429) return 'rate_limit_error'
  return 'server_error'
}

function anthropicType(code: ErrorCode): string {
  const status = statusFor(code)
  if (status === 400) return 'invalid_request_error'
  if (status === 401) return 'authentication_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  return 'api_error'
}

async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await c.req.json() }
  } catch {
    return { ok: false, message: 'Request body is not valid JSON.' }
  }
}

function describeWarnings(warnings: readonly string[]): string | undefined {
  return warnings.length > 0 ? [...new Set(warnings)].join(' ') : undefined
}

export function registerGatewayRoutes(app: Hono, deps: GatewayDeps): void {
  const { router, activity, logger } = deps
  const created = Math.floor(deps.startedAt / 1000)

  app.get('/v1/models', (c) => {
    const models = router.listModels()
    if (c.req.header('anthropic-version') !== undefined) {
      const data = models.map((model) => ({ type: 'model', id: model.id, display_name: model.label, created_at: new Date(deps.startedAt).toISOString() }))
      return c.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null })
    }
    return c.json({ object: 'list', data: models.map((model) => ({ id: model.id, object: 'model', created, owned_by: `corsen-web-${model.harness}` })) })
  })

  app.post('/v1/chat/completions', async (c) => {
    const body = await readJson(c)
    if (!body.ok) return c.json(openAIError(body.message, 'invalid_request_error', 'invalid_json'), 400)
    const parsed = OpenAIChatRequestSchema.safeParse(body.value)
    if (!parsed.success) return c.json(openAIError(z.prettifyError(parsed.error), 'invalid_request_error', 'invalid_request'), 400)
    const request = normalizeOpenAIRequest(parsed.data)
    const finish = activity.start({ kind: 'llm', title: 'POST /v1/chat/completions', model: request.model, detail: describeWarnings(request.warnings) })
    const id = newCompletionId()
    const now = Math.floor(Date.now() / 1000)

    if (!request.stream) {
      const abort = new AbortController()
      c.req.raw.signal?.addEventListener('abort', () => abort.abort(), { once: true })
      try {
        const result = await runChat(router, request, { signal: abort.signal, newToolCallId, logger })
        finish({ status: 'ok', model: `web-${result.servedBy}`, detail: `${result.toolCalls.length} tool call(s), ${result.text.length} chars` })
        return c.json(openAICompletion(result, request.model, id, now))
      } catch (error) {
        const wire = toWireError(error)
        finish({ status: 'error', detail: `${wire.code}: ${wire.message}` })
        return c.json(openAIError(wire.message, openAIType(wire.code), wire.code), statusFor(wire.code))
      }
    }

    const includeUsage = parsed.data.stream_options?.include_usage === true
    return sseResponse(
      async (emit, signal) => {
        const writer = new OpenAIStreamWriter(request.model, includeUsage, id, now)
        emit(writer.start())
        try {
          const result = await runChat(router, request, { signal, onText: (delta) => emit(writer.text(delta)), newToolCallId, logger })
          emit(writer.finish(result))
          finish({ status: 'ok', model: `web-${result.servedBy}`, detail: `${result.toolCalls.length} tool call(s), ${result.text.length} chars` })
        } catch (error) {
          const wire = toWireError(error)
          emit(writer.error(wire.message, openAIType(wire.code), wire.code))
          finish({ status: 'error', detail: `${wire.code}: ${wire.message}` })
        }
      },
      { keepAlive: () => ': keep-alive\n\n', requestSignal: c.req.raw.signal },
    )
  })

  app.post('/v1/messages', async (c) => {
    const body = await readJson(c)
    if (!body.ok) return c.json(anthropicError('invalid_request_error', body.message), 400)
    const parsed = AnthropicMessagesRequestSchema.safeParse(body.value)
    if (!parsed.success) return c.json(anthropicError('invalid_request_error', z.prettifyError(parsed.error)), 400)
    const request = normalizeAnthropicRequest(parsed.data)
    const finish = activity.start({ kind: 'llm', title: 'POST /v1/messages', model: request.model, detail: describeWarnings(request.warnings) })
    const id = newMessageId()

    if (!request.stream) {
      const abort = new AbortController()
      c.req.raw.signal?.addEventListener('abort', () => abort.abort(), { once: true })
      try {
        const result = await runChat(router, request, { signal: abort.signal, newToolCallId: newToolUseId, logger })
        finish({ status: 'ok', model: `web-${result.servedBy}`, detail: `${result.toolCalls.length} tool call(s), ${result.text.length} chars` })
        return c.json(anthropicMessage(result, request.model, id))
      } catch (error) {
        const wire = toWireError(error)
        finish({ status: 'error', detail: `${wire.code}: ${wire.message}` })
        return c.json(anthropicError(anthropicType(wire.code), wire.message), statusFor(wire.code))
      }
    }

    const promptEstimate = renderFullPrompt(request).length
    return sseResponse(
      async (emit, signal) => {
        const writer = new AnthropicStreamWriter(request.model, promptEstimate, id)
        emit(writer.start())
        emit(writer.ping())
        try {
          const result = await runChat(router, request, { signal, onText: (delta) => emit(writer.text(delta)), newToolCallId: newToolUseId, logger })
          emit(writer.finish(result))
          finish({ status: 'ok', model: `web-${result.servedBy}`, detail: `${result.toolCalls.length} tool call(s), ${result.text.length} chars` })
        } catch (error) {
          const wire = toWireError(error)
          emit(writer.error(anthropicType(wire.code), wire.message))
          finish({ status: 'error', detail: `${wire.code}: ${wire.message}` })
        }
      },
      { keepAlive: () => 'event: ping\ndata: {"type": "ping"}\n\n', requestSignal: c.req.raw.signal },
    )
  })

  app.post('/v1/messages/count_tokens', async (c) => {
    const body = await readJson(c)
    if (!body.ok) return c.json(anthropicError('invalid_request_error', body.message), 400)
    const parsed = AnthropicCountTokensRequestSchema.safeParse(body.value)
    if (!parsed.success) return c.json(anthropicError('invalid_request_error', z.prettifyError(parsed.error)), 400)
    const request = normalizeAnthropicRequest({ ...parsed.data, max_tokens: 1 })
    return c.json({ input_tokens: estimateTokens(renderFullPrompt(request).length) })
  })
}
