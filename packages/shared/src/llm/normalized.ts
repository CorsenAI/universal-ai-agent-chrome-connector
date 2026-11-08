/**
 * Provider-neutral chat request used inside the gateway. OpenAI and Anthropic requests are both
 * converted into this shape; the prompt builder and the tool shim only ever see this.
 */

export interface NormalizedTextPart {
  readonly type: 'text'
  readonly text: string
}

export interface NormalizedImagePart {
  readonly type: 'image'
  /** Media type when known (`image/png`), or empty. */
  readonly mediaType: string
  /** `data:`/`https:` URL or empty when only base64 data was given. */
  readonly url: string
}

export type NormalizedContentPart = NormalizedTextPart | NormalizedImagePart

export interface NormalizedToolCall {
  readonly id: string
  readonly name: string
  /** Parsed arguments object (the shim always produces an object). */
  readonly arguments: Record<string, unknown>
}

export type NormalizedMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: readonly NormalizedContentPart[] }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls: readonly NormalizedToolCall[] }
  | {
      readonly role: 'tool'
      readonly toolCallId: string
      readonly name: string
      readonly content: string
      readonly isError: boolean
    }

export interface NormalizedTool {
  readonly name: string
  readonly description: string
  /** JSON Schema of the arguments object. */
  readonly parameters: Record<string, unknown>
}

export type NormalizedToolChoice =
  | { readonly type: 'auto' }
  | { readonly type: 'none' }
  | { readonly type: 'required' }
  | { readonly type: 'tool'; readonly name: string }

export interface NormalizedChatRequest {
  readonly model: string
  readonly messages: readonly NormalizedMessage[]
  readonly tools: readonly NormalizedTool[]
  readonly toolChoice: NormalizedToolChoice
  readonly parallelToolCalls: boolean
  readonly stream: boolean
  readonly maxTokens: number | null
  readonly stopSequences: readonly string[]
  /** `json_object` / `json_schema` response formats become an instruction to answer in JSON. */
  readonly jsonMode: boolean
  /** Non-fatal notes about features the web harness cannot honor (images, sampling params…). */
  readonly warnings: readonly string[]
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'cancelled'

export interface NormalizedChatResult {
  readonly text: string
  readonly toolCalls: readonly NormalizedToolCall[]
  readonly finishReason: FinishReason
  readonly promptChars: number
  readonly completionChars: number
  /** Harness that actually served the request (for the `model` field of responses). */
  readonly servedBy: string
}

/** Flatten user content parts to text, describing images we cannot forward to a web chat. */
export function contentPartsToText(parts: readonly NormalizedContentPart[]): string {
  return parts
    .map((part) => (part.type === 'text' ? part.text : `[image omitted${part.mediaType !== '' ? `: ${part.mediaType}` : ''}]`))
    .join('\n')
}
