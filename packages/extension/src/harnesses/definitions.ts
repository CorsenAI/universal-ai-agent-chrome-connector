import type { HarnessId } from '@corsen-ai/shared'

/**
 * `LLMWebHarness` definitions: data, not code. One generic driver (`driver.ts`) runs every site from
 * these selectors, so supporting a new chat is a definition or a 10-second calibration with the
 * visual picker (`GenericSelectorHarness`).
 *
 * Site selectors are best-effort as of 2026-11 and could not be verified against signed-in accounts
 * from this machine; each list ends with generic fallbacks, and the user's calibration (picker)
 * always takes precedence. When a site changes its DOM, recalibrate from the Tab Manager.
 */
export interface HarnessSelectors {
  readonly input: readonly string[]
  readonly send: readonly string[]
  readonly stop: readonly string[]
  readonly response: readonly string[]
  /** Containers whose content is not the answer (reasoning / "thinking" panels). */
  readonly exclude: readonly string[]
}

export interface LLMWebHarness {
  readonly id: HarnessId
  readonly label: string
  /** Hostnames served by this harness (exact or subdomain match). */
  readonly hosts: readonly string[]
  /** URL that opens an empty conversation; null keeps the current page (generic sites). */
  readonly newChatUrl: string | null
  readonly selectors: HarnessSelectors
  /** Attribute whose value is "true" on (or above) the answer while it streams. */
  readonly streamingAttribute?: string
  /** How a prompt is submitted: Enter key (default) or a click on the send button. */
  readonly submit: 'enter' | 'click'
}

export const GENERIC_SELECTORS: HarnessSelectors = {
  input: ['textarea:not([readonly])', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
  send: ['button[type="submit"]', 'button[aria-label*="send" i]', 'button[data-testid*="send" i]', 'button[title*="send" i]'],
  stop: ['button[aria-label*="stop" i]', 'button[data-testid*="stop" i]', 'button[title*="stop" i]'],
  response: ['[data-message-author-role="assistant"]', '[class*="markdown"]', '[data-role="assistant"]', '[class*="assistant"]'],
  exclude: ['[class*="think" i]', '[class*="reasoning" i]', '[data-testid*="reasoning" i]'],
}

export const HARNESSES: readonly LLMWebHarness[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hosts: ['chat.deepseek.com'],
    newChatUrl: 'https://chat.deepseek.com/',
    selectors: {
      input: ['textarea#chat-input', 'textarea[placeholder]'],
      send: ['div[role="button"][aria-disabled="false"]:has(svg)'],
      stop: ['div[role="button"]:has(svg rect)'],
      response: ['.ds-markdown', 'div[class*="ds-markdown"]'],
      exclude: ['.ds-think-content', '[class*="think" i]'],
    },
    submit: 'enter',
  },
  {
    id: 'claude',
    label: 'Claude.ai',
    hosts: ['claude.ai'],
    newChatUrl: 'https://claude.ai/new',
    selectors: {
      input: ['div[contenteditable="true"].ProseMirror', '[data-testid="chat-input"] [contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
      send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[data-testid="send-button"]'],
      stop: ['button[aria-label="Stop response"]', 'button[aria-label*="stop" i]'],
      response: ['div[data-is-streaming] .font-claude-response', 'div[data-is-streaming]', '.font-claude-response', '.font-claude-message'],
      exclude: ['[class*="thinking" i]', 'details'],
    },
    streamingAttribute: 'data-is-streaming',
    submit: 'enter',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    newChatUrl: 'https://chatgpt.com/',
    selectors: {
      input: ['#prompt-textarea', 'div#prompt-textarea[contenteditable="true"]', 'textarea[name="prompt-textarea"]'],
      send: ['button[data-testid="send-button"]', '#composer-submit-button'],
      stop: ['button[data-testid="stop-button"]', 'button[aria-label*="stop" i]'],
      response: ['[data-message-author-role="assistant"] .markdown', '[data-message-author-role="assistant"]'],
      exclude: ['[class*="reasoning" i]', '[class*="thinking" i]'],
    },
    submit: 'enter',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    hosts: ['gemini.google.com'],
    newChatUrl: 'https://gemini.google.com/app',
    selectors: {
      input: ['rich-textarea .ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
      send: ['button[aria-label="Send message"]', 'button.send-button', 'button[aria-label*="send" i]'],
      stop: ['button[aria-label="Stop response"]', 'button[aria-label*="stop" i]'],
      response: ['model-response message-content .markdown', 'model-response message-content', 'model-response'],
      exclude: ['model-thoughts', '[class*="thought" i]'],
    },
    submit: 'enter',
  },
  {
    id: 'qwen',
    label: 'Qwen Chat',
    hosts: ['chat.qwen.ai'],
    newChatUrl: 'https://chat.qwen.ai/',
    selectors: {
      input: ['textarea#chat-input', 'textarea[placeholder]'],
      send: ['button#send-message-button', 'button[aria-label*="send" i]'],
      stop: ['button#stop-message-button', 'button[aria-label*="stop" i]'],
      response: ['.response-message-content', '.markdown-content-container', '.markdown-prose'],
      exclude: ['[class*="think" i]', '[class*="reasoning" i]'],
    },
    submit: 'enter',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    hosts: ['kimi.com', 'www.kimi.com', 'kimi.moonshot.cn'],
    newChatUrl: 'https://www.kimi.com/',
    selectors: {
      input: ['.chat-input-editor[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'textarea'],
      send: ['.send-button', 'button[aria-label*="send" i]'],
      stop: ['.stop-message-btn', 'button[aria-label*="stop" i]'],
      response: ['.segment-assistant .markdown', '.markdown-container', '.segment-content-box'],
      exclude: ['[class*="think" i]', '[class*="reasoning" i]'],
    },
    submit: 'enter',
  },
]

export const GENERIC_HARNESS: LLMWebHarness = {
  id: 'generic',
  label: 'Custom chat (calibrated)',
  hosts: [],
  newChatUrl: null,
  selectors: GENERIC_SELECTORS,
  submit: 'enter',
}
