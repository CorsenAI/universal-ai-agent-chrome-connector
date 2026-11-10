import { posix, win32 } from 'node:path'

/**
 * Where each agent keeps its MCP configuration, as pure functions of the platform, home directory
 * and environment. Sources (2026-11): code.claude.com/docs/en/mcp, cursor.com/docs/context/mcp,
 * docs.devin.ai/desktop/cascade/mcp, modelcontextprotocol.io/docs/develop/connect-local-servers,
 * docs.cline.bot/mcp/configuring-mcp-servers, roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo,
 * opencode.ai/docs/mcp-servers. Pure so tests can compute paths for macOS and Windows on any machine.
 */
export interface PlatformContext {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Join with the separator of the platform being described, not of the machine running the code. */
function joinFor(ctx: PlatformContext): (...parts: string[]) => string {
  return ctx.platform === 'win32' ? win32.join : posix.join
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/** OS application-data directory (where Electron apps such as Claude Desktop and VS Code live). */
export function appDataDir(ctx: PlatformContext): string {
  if (ctx.platform === 'win32') return nonEmpty(ctx.env['APPDATA']) ?? joinFor(ctx)(ctx.home, 'AppData', 'Roaming')
  if (ctx.platform === 'darwin') return joinFor(ctx)(ctx.home, 'Library', 'Application Support')
  return nonEmpty(ctx.env['XDG_CONFIG_HOME']) ?? joinFor(ctx)(ctx.home, '.config')
}

/** XDG-style config directory used by CLI tools on every OS (OpenCode, Devin). */
export function xdgConfigDir(ctx: PlatformContext): string {
  return nonEmpty(ctx.env['XDG_CONFIG_HOME']) ?? joinFor(ctx)(ctx.home, '.config')
}

/**
 * Claude Code's directory and its own state file, which holds the user-scope MCP servers. Both move
 * into `CLAUDE_CONFIG_DIR` when that variable is set ("every ~/.claude path … lives under that
 * directory instead. The same applies to .claude.json", code.claude.com/docs/en/claude-directory),
 * and the `claude` CLI the configurator runs inherits the same environment.
 */
export function claudeCodeDir(ctx: PlatformContext): string {
  return nonEmpty(ctx.env['CLAUDE_CONFIG_DIR']) ?? joinFor(ctx)(ctx.home, '.claude')
}

export function claudeCodeConfig(ctx: PlatformContext): string {
  const configDir = nonEmpty(ctx.env['CLAUDE_CONFIG_DIR'])
  return configDir !== undefined ? joinFor(ctx)(configDir, '.claude.json') : joinFor(ctx)(ctx.home, '.claude.json')
}

export function claudeDesktopConfig(ctx: PlatformContext): string {
  return joinFor(ctx)(appDataDir(ctx), 'Claude', 'claude_desktop_config.json')
}

export function cursorConfig(ctx: PlatformContext): string {
  return joinFor(ctx)(ctx.home, '.cursor', 'mcp.json')
}

/** Legacy Windsurf Cascade location. */
export function windsurfConfig(ctx: PlatformContext): string {
  return joinFor(ctx)(ctx.home, '.codeium', 'windsurf', 'mcp_config.json')
}

/** Devin Desktop (Windsurf renamed in June 2026) user-level file. */
export function devinConfig(ctx: PlatformContext): string {
  if (ctx.platform === 'win32') return joinFor(ctx)(appDataDir(ctx), 'devin', 'mcp_config.json')
  return joinFor(ctx)(xdgConfigDir(ctx), 'devin', 'mcp_config.json')
}

export function clineCliConfig(ctx: PlatformContext): string {
  return nonEmpty(ctx.env['CLINE_MCP_SETTINGS_PATH']) ?? joinFor(ctx)(ctx.home, '.cline', 'data', 'settings', 'cline_mcp_settings.json')
}

/** VS Code-family editors whose globalStorage may host Cline or Roo Code. */
export const EDITOR_DIRS: readonly string[] = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium', 'Devin']

export function editorGlobalStorage(ctx: PlatformContext, editor: string): string {
  return joinFor(ctx)(appDataDir(ctx), editor, 'User', 'globalStorage')
}

export const CLINE_EXTENSION_ID = 'saoudrizwan.claude-dev'
export const ROO_EXTENSION_ID = 'rooveterinaryinc.roo-cline'

export function clineExtensionConfig(ctx: PlatformContext, editor: string): string {
  return joinFor(ctx)(editorGlobalStorage(ctx, editor), CLINE_EXTENSION_ID, 'settings', 'cline_mcp_settings.json')
}

export function rooExtensionConfig(ctx: PlatformContext, editor: string): string {
  return joinFor(ctx)(editorGlobalStorage(ctx, editor), ROO_EXTENSION_ID, 'settings', 'mcp_settings.json')
}

export function openCodeConfigs(ctx: PlatformContext): readonly [string, string] {
  const dir = joinFor(ctx)(xdgConfigDir(ctx), 'opencode')
  return [joinFor(ctx)(dir, 'opencode.jsonc'), joinFor(ctx)(dir, 'opencode.json')]
}

/** Display a path with `~` for the home directory (never leaks the user name in UIs/screenshots). */
export function displayPath(ctx: PlatformContext, path: string): string {
  return path.startsWith(ctx.home) ? `~${path.slice(ctx.home.length)}` : path
}
