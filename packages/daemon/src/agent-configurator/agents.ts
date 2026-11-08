import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGENT_LABELS, MCP_SERVER_NAME, type AgentId } from '@corsen-ai/shared'
import type { LaunchCommand } from './launch'
import {
  CLINE_EXTENSION_ID,
  EDITOR_DIRS,
  ROO_EXTENSION_ID,
  claudeCodeConfig,
  claudeDesktopConfig,
  clineCliConfig,
  clineExtensionConfig,
  cursorConfig,
  devinConfig,
  editorGlobalStorage,
  openCodeConfigs,
  rooExtensionConfig,
  windsurfConfig,
  xdgConfigDir,
  type PlatformContext,
} from './locations'

/** One JSON file and property path where our server entry lives. */
export interface ConfigTarget {
  readonly file: string
  readonly path: readonly string[]
  readonly entry: unknown
}

export interface AgentSpec {
  readonly id: AgentId
  readonly name: string
  readonly method: 'cli' | 'file'
  readonly needsRestart: boolean
  detect(ctx: PlatformContext, hasExecutable: (name: string) => boolean): boolean
  /** Files to write for this machine (only locations whose app is present, else the canonical one). */
  targets(ctx: PlatformContext, launch: LaunchCommand): ConfigTarget[]
  notes(ctx: PlatformContext): string[]
}

function withEnv<T extends Record<string, unknown>>(entry: T, launch: LaunchCommand): T & { env?: Record<string, string> } {
  return Object.keys(launch.env).length > 0 ? { ...entry, env: { ...launch.env } } : entry
}

function standardEntry(launch: LaunchCommand): Record<string, unknown> {
  return withEnv({ command: launch.command, args: [...launch.args] }, launch)
}

const SERVER_PATH = ['mcpServers', MCP_SERVER_NAME] as const

const ANTHROPIC_NOTE =
  'Optional: run Claude Code on your web chats by setting ANTHROPIC_BASE_URL to the Anthropic base URL and ANTHROPIC_AUTH_TOKEN to the API key (both shown under Local endpoints).'

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    id: 'claude-code',
    name: AGENT_LABELS['claude-code'],
    method: 'cli',
    needsRestart: true,
    detect: (ctx, hasExecutable) => hasExecutable('claude') || existsSync(claudeCodeConfig(ctx)) || existsSync(join(ctx.home, '.claude')),
    targets: (ctx, launch) => [{ file: claudeCodeConfig(ctx), path: SERVER_PATH, entry: withEnv({ type: 'stdio', command: launch.command, args: [...launch.args] }, launch) }],
    notes: () => ['Uses `claude mcp add-json --scope user` when the CLI is available. Restart running sessions or type /mcp.', ANTHROPIC_NOTE],
  },
  {
    id: 'cursor',
    name: AGENT_LABELS.cursor,
    method: 'file',
    needsRestart: false,
    detect: (ctx) => existsSync(dirname(cursorConfig(ctx))) || existsSync(editorGlobalStorage(ctx, 'Cursor')),
    targets: (ctx, launch) => [{ file: cursorConfig(ctx), path: SERVER_PATH, entry: { type: 'stdio', ...standardEntry(launch) } }],
    notes: () => [
      'Enable "corsen-browser" in Cursor Settings › MCP if it is not on already.',
      'Cursor sends custom OpenAI-base-URL requests from its own servers, so http://127.0.0.1 is unreachable there; use Cline or Roo Code inside Cursor for the local LLM API, or a tunnel (see README).',
    ],
  },
  {
    id: 'windsurf',
    name: AGENT_LABELS.windsurf,
    method: 'file',
    needsRestart: true,
    detect: (ctx) => existsSync(dirname(windsurfConfig(ctx))),
    targets: (ctx, launch) => [{ file: windsurfConfig(ctx), path: SERVER_PATH, entry: standardEntry(launch) }],
    notes: () => ['Refresh MCP servers in Cascade (or restart Windsurf).'],
  },
  {
    id: 'devin',
    name: AGENT_LABELS.devin,
    method: 'file',
    needsRestart: true,
    detect: (ctx) => existsSync(dirname(devinConfig(ctx))),
    targets: (ctx, launch) => [{ file: devinConfig(ctx), path: SERVER_PATH, entry: standardEntry(launch) }],
    notes: () => ['Windsurf was renamed Devin Desktop in June 2026; this is its user-level MCP file. Restart the app to load it.'],
  },
  {
    id: 'claude-desktop',
    name: AGENT_LABELS['claude-desktop'],
    method: 'file',
    needsRestart: true,
    detect: (ctx) => existsSync(dirname(claudeDesktopConfig(ctx))),
    targets: (ctx, launch) => [{ file: claudeDesktopConfig(ctx), path: SERVER_PATH, entry: standardEntry(launch) }],
    notes: () => ['Quit Claude Desktop completely and start it again to load the server.'],
  },
  {
    id: 'cline',
    name: AGENT_LABELS.cline,
    method: 'file',
    needsRestart: false,
    detect: (ctx) =>
      existsSync(join(ctx.home, '.cline')) || ctx.env['CLINE_MCP_SETTINGS_PATH'] !== undefined || EDITOR_DIRS.some((editor) => existsSync(join(editorGlobalStorage(ctx, editor), CLINE_EXTENSION_ID))),
    targets: (ctx, launch) => {
      const entry = { ...standardEntry(launch), env: { ...launch.env }, disabled: false, autoApprove: [] as string[] }
      const files = EDITOR_DIRS.filter((editor) => existsSync(join(editorGlobalStorage(ctx, editor), CLINE_EXTENSION_ID))).map((editor) => clineExtensionConfig(ctx, editor))
      if (existsSync(join(ctx.home, '.cline')) || ctx.env['CLINE_MCP_SETTINGS_PATH'] !== undefined || files.length === 0) files.push(clineCliConfig(ctx))
      return files.map((file) => ({ file, path: SERVER_PATH, entry }))
    },
    notes: () => ['Cline reloads its MCP settings automatically; tools start unapproved (autoApprove is empty).'],
  },
  {
    id: 'roo-code',
    name: AGENT_LABELS['roo-code'],
    method: 'file',
    needsRestart: false,
    detect: (ctx) => EDITOR_DIRS.some((editor) => existsSync(join(editorGlobalStorage(ctx, editor), ROO_EXTENSION_ID))),
    targets: (ctx, launch) => {
      const entry = { ...standardEntry(launch), env: { ...launch.env }, disabled: false, alwaysAllow: [] as string[] }
      const editors = EDITOR_DIRS.filter((editor) => existsSync(join(editorGlobalStorage(ctx, editor), ROO_EXTENSION_ID)))
      return (editors.length > 0 ? editors : ['Code']).map((editor) => ({ file: rooExtensionConfig(ctx, editor), path: SERVER_PATH, entry }))
    },
    notes: () => ['Roo Code reloads mcp_settings.json automatically; tools start unapproved (alwaysAllow is empty).'],
  },
  {
    id: 'opencode',
    name: AGENT_LABELS.opencode,
    method: 'file',
    needsRestart: true,
    detect: (ctx, hasExecutable) => hasExecutable('opencode') || existsSync(join(xdgConfigDir(ctx), 'opencode')),
    targets: (ctx, launch) => {
      const [jsonc, json] = openCodeConfigs(ctx)
      const file = existsSync(jsonc) ? jsonc : json
      const entry: Record<string, unknown> = { type: 'local', command: [launch.command, ...launch.args], disabled: false }
      if (Object.keys(launch.env).length > 0) entry['environment'] = { ...launch.env }
      return [{ file, path: ['mcp', 'servers', MCP_SERVER_NAME], entry }]
    },
    notes: () => ['Restart OpenCode to load the server.'],
  },
]

export function agentSpec(id: AgentId): AgentSpec {
  const spec = AGENT_SPECS.find((item) => item.id === id)
  if (spec === undefined) throw new Error(`unknown agent ${id}`)
  return spec
}
