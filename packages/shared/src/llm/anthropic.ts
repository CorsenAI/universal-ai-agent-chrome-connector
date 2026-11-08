import * as z from 'zod'

/**
 * Lenient validation of Anthropic Messages API requests (shapes per platform.claude.com docs and the
 * official `@anthropic-ai/sdk` 1.6 types). Unknown fields and block types are kept so the converter can
 * skip what a web chat cannot honor (thinking, cache_control, server tools) instead of failing.
 */

const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() })
const ImageSource = z.union([
  z.looseObject({ type: z.literal('base64'), media_type: z.string(), data: z.string() }),
  z.looseObject({ type: z.literal('url'), url: z.string() }),
  z.looseObject({ type: z.string() }),
])
const ImageBlock = z.looseObject({ type: z.literal('image'), source: ImageSource })
const ToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().max(200),
  name: z.string().max(200),
  input: z.unknown(),
})
const ToolResultContent = z.union([z.string(), z.array(z.union([TextBlock, ImageBlock, z.looseObject({ type: z.string() })]))])
const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string().max(200),
  content: ToolResultContent.optional(),
  is_error: z.boolean().optional(),
})
const OtherBlock = z.looseObject({ type: z.string() })

export const AnthropicBlockSchema = z.union([TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock, OtherBlock])
export type AnthropicBlock = z.infer<typeof AnthropicBlockSchema>

export const AnthropicMessageSchema = z.looseObject({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(AnthropicBlockSchema).max(2000)]),
})
export type AnthropicMessage = z.infer<typeof AnthropicMessageSchema>

export const AnthropicToolSchema = z.looseObject({
  name: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  description: z.string().max(20_000).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  /** Server tools (web search, code execution…) carry a `type`; they cannot run in a web chat. */
  type: z.string().optional(),
})
export type AnthropicTool = z.infer<typeof AnthropicToolSchema>

export const AnthropicToolChoiceSchema = z.looseObject({
  type: z.enum(['auto', 'any', 'tool', 'none']),
  name: z.string().optional(),
  disable_parallel_tool_use: z.boolean().optional(),
})

export const AnthropicMessagesRequestSchema = z.looseObject({
  model: z.string().min(1).max(200),
  messages: z.array(AnthropicMessageSchema).min(1).max(4000),
  system: z.union([z.string(), z.array(z.union([TextBlock, OtherBlock]))]).optional(),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(AnthropicToolSchema).max(512).optional(),
  tool_choice: AnthropicToolChoiceSchema.optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).max(16).optional(),
  metadata: z.looseObject({}).optional(),
  thinking: z.looseObject({}).optional(),
})
export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>

export const AnthropicCountTokensRequestSchema = AnthropicMessagesRequestSchema.omit({ max_tokens: true, stream: true })
