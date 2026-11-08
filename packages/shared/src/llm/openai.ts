import * as z from 'zod'

/**
 * Lenient validation of OpenAI Chat Completions requests (fields per the official `openai` SDK
 * 7.53 types). Unknown fields are kept (`looseObject`) because clients send provider-specific extras;
 * the converter decides what it can honor.
 */

const TextPart = z.looseObject({ type: z.literal('text'), text: z.string() })
const ImagePart = z.looseObject({
  type: z.literal('image_url'),
  image_url: z.looseObject({ url: z.string(), detail: z.string().optional() }),
})
const OtherPart = z.looseObject({ type: z.string() })
const ContentPart = z.union([TextPart, ImagePart, OtherPart])

export const OpenAIContentSchema = z.union([z.string(), z.array(ContentPart)]).nullable().optional()

export const OpenAIToolCallSchema = z.looseObject({
  id: z.string().max(200),
  type: z.literal('function').optional(),
  function: z.looseObject({ name: z.string().max(200), arguments: z.string() }),
})

const SystemMessage = z.looseObject({ role: z.literal('system'), content: OpenAIContentSchema })
const DeveloperMessage = z.looseObject({ role: z.literal('developer'), content: OpenAIContentSchema })
const UserMessage = z.looseObject({ role: z.literal('user'), content: OpenAIContentSchema })
const AssistantMessage = z.looseObject({
  role: z.literal('assistant'),
  content: OpenAIContentSchema,
  tool_calls: z.array(OpenAIToolCallSchema).max(128).nullable().optional(),
  function_call: z.looseObject({ name: z.string(), arguments: z.string() }).nullable().optional(),
  refusal: z.string().nullable().optional(),
})
const ToolMessage = z.looseObject({ role: z.literal('tool'), content: OpenAIContentSchema, tool_call_id: z.string().max(200) })
const FunctionMessage = z.looseObject({ role: z.literal('function'), content: OpenAIContentSchema, name: z.string().max(200) })

export const OpenAIMessageSchema = z.discriminatedUnion('role', [
  SystemMessage,
  DeveloperMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  FunctionMessage,
])
export type OpenAIMessage = z.infer<typeof OpenAIMessageSchema>

const ToolName = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)

export const OpenAIToolSchema = z.looseObject({
  type: z.literal('function'),
  function: z.looseObject({
    name: ToolName,
    description: z.string().max(20_000).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().nullable().optional(),
  }),
})
export type OpenAITool = z.infer<typeof OpenAIToolSchema>

export const OpenAIToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.looseObject({ type: z.literal('function'), function: z.looseObject({ name: z.string() }) }),
])

/** Legacy `functions` + `function_call` (deprecated by OpenAI but still sent by older clients). */
const LegacyFunctionSchema = z.looseObject({
  name: ToolName,
  description: z.string().max(20_000).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
})

export const OpenAIChatRequestSchema = z.looseObject({
  model: z.string().min(1).max(200),
  messages: z.array(OpenAIMessageSchema).min(1).max(4000),
  tools: z.array(OpenAIToolSchema).max(512).nullable().optional(),
  tool_choice: OpenAIToolChoiceSchema.nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  functions: z.array(LegacyFunctionSchema).max(512).nullable().optional(),
  function_call: z.union([z.enum(['none', 'auto']), z.looseObject({ name: z.string() })]).nullable().optional(),
  stream: z.boolean().nullable().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullable().optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  max_completion_tokens: z.number().int().positive().nullable().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(16)]).nullable().optional(),
  n: z.number().int().nullable().optional(),
  response_format: z.looseObject({ type: z.string() }).nullable().optional(),
  user: z.string().optional(),
})
export type OpenAIChatRequest = z.infer<typeof OpenAIChatRequestSchema>
