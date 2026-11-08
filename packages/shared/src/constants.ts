/**
 * Product-wide constants shared by the daemon and the extension.
 *
 * Anything a peer could misread (protocol version, frame limits) lives here so both sides compile
 * against the same value; a protocol change bumps {@link PROTOCOL_VERSION} and both sides refuse a
 * mismatched peer instead of guessing.
 */

/** Product name shown in user interfaces and in the Chrome Web Store (no Google trademark, D-014). */
export const PRODUCT_NAME = 'Universal AI Agent Connector'
export const PRODUCT_FULL_NAME = 'Universal AI Agent Connector — by Corsen AI'
export const VENDOR = 'Corsen AI'
export const PACKAGE_NAME = '@corsen-ai/universal-connector'
export const CLI_NAME = 'universal-connector'
export const VERSION = '0.1.0'

/** Wire protocol generation between the extension and the daemon. Peers must be equal. */
export const PROTOCOL_VERSION = 1

export const DEFAULT_PORT = 43110
export const LOOPBACK_HOST = '127.0.0.1'
export const WS_PATH = '/ws'
export const MCP_PATH = '/mcp'

/** Name under which the MCP server is registered in agent configurations. */
export const MCP_SERVER_NAME = 'corsen-browser'

/** Environment variables understood by the daemon and the stdio proxy. */
export const ENV_HOME = 'CORSEN_CONNECTOR_HOME'
export const ENV_PORT = 'CORSEN_CONNECTOR_PORT'

/** The extension pings at this interval; Chrome keeps the service worker alive on WebSocket traffic (Chrome 116+, 20 s recommended). */
export const HEARTBEAT_INTERVAL_MS = 20_000
/** The daemon drops a browser connection that stayed silent this long (three missed beats). */
export const HEARTBEAT_TIMEOUT_MS = 65_000
/** A connection must complete the handshake within this delay. */
export const HANDSHAKE_TIMEOUT_MS = 10_000

export const LIMITS = {
  /** Largest WebSocket frame either side accepts (screenshots are the largest payload). */
  MAX_FRAME_BYTES: 24 * 1024 * 1024,
  /** Largest base64 screenshot the extension returns. */
  MAX_SCREENSHOT_BASE64_CHARS: 16 * 1024 * 1024,
  /** Default and hard caps for page text returned to agents. */
  DEFAULT_PAGE_CHARS: 40_000,
  MAX_PAGE_CHARS: 400_000,
  /** Generic RPC deadline (page actions, reads). */
  RPC_TIMEOUT_MS: 45_000,
  /** Deadline for one web-LLM generation. */
  LLM_TIMEOUT_MS: 10 * 60_000,
  /** In-flight RPCs per direction. */
  MAX_PENDING_RPC: 64,
  /** Identifier length cap (ids, nonces carry their own patterns). */
  MAX_ID_CHARS: 160,
  /** Characters of a single DevTools message or network body kept. */
  MAX_ENTRY_TEXT_CHARS: 8_000,
  /** Entries kept per tab in the DevTools and network ring buffers. */
  MAX_DEVTOOLS_ENTRIES: 300,
  MAX_NETWORK_CALLS: 100,
  /** Prompt size accepted by the gateway for one web-LLM turn. */
  MAX_PROMPT_CHARS: 400_000,
} as const

/** Rough token estimate used for the "tokens saved" counter (OpenAI's rule of thumb: ~4 chars/token). */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.ceil(chars / 4)
}
