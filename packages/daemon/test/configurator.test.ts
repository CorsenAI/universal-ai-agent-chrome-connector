import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentConfigurator } from '../src/agent-configurator/configurator'
import { BackupStore } from '../src/agent-configurator/backups'
import type { LaunchCommand } from '../src/agent-configurator/launch'
import { resolveLaunchCommand } from '../src/agent-configurator/launch'
import { claudeDesktopConfig, cursorConfig, devinConfig, rooExtensionConfig, type PlatformContext } from '../src/agent-configurator/locations'
import { silentLogger } from '../src/util/logger'
import { tempDir } from './helpers/env'

const launch: LaunchCommand = { command: '/usr/bin/node', args: ['/opt/corsen/dist/index.js', 'mcp'], env: {} }

let home: { path: string; cleanup: () => void }
let ctx: PlatformContext
let configurator: AgentConfigurator

function make(env: Record<string, string> = {}): AgentConfigurator {
  ctx = { platform: 'linux', home: home.path, env: { PATH: join(home.path, 'empty-bin'), ...env } }
  return new AgentConfigurator({ ctx, launch, backups: new BackupStore(join(home.path, '.corsen-connector', 'backups.json')), logger: silentLogger })
}

const read = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))

beforeEach(() => {
  home = tempDir('configurator')
  configurator = make()
})
afterEach(() => home.cleanup())

describe('detection', () => {
  it('reports nothing on an empty home', () => {
    const agents = configurator.list()
    expect(agents).toHaveLength(8)
    expect(agents.every((agent) => !agent.detected && !agent.connected)).toBe(true)
  })

  it('detects agents from their configuration directories', () => {
    mkdirSync(join(home.path, '.cursor'), { recursive: true })
    mkdirSync(dirname(claudeDesktopConfig(ctx)), { recursive: true })
    const detected = configurator.list().filter((agent) => agent.detected).map((agent) => agent.id)
    expect(detected.sort()).toEqual(['claude-desktop', 'cursor'])
  })

  it('computes macOS and Windows locations', () => {
    const mac: PlatformContext = { platform: 'darwin', home: '/Users/me', env: {} }
    const win: PlatformContext = { platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } }
    expect(claudeDesktopConfig(mac)).toBe('/Users/me/Library/Application Support/Claude/claude_desktop_config.json')
    expect(claudeDesktopConfig(win)).toBe('C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json')
    expect(devinConfig(mac)).toBe('/Users/me/.config/devin/mcp_config.json')
    expect(rooExtensionConfig(mac, 'Code')).toBe('/Users/me/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json')
  })
})

describe('connect / unlink / restore (file agents)', () => {
  it('creates a missing config file with our entry and no backup', async () => {
    mkdirSync(join(home.path, '.cursor'), { recursive: true })
    const result = await configurator.connect('cursor')
    expect(result.changed).toBe(true)
    expect(result.backupPaths).toEqual([])
    expect(read(cursorConfig(ctx)).mcpServers['corsen-browser']).toEqual({ type: 'stdio', command: '/usr/bin/node', args: ['/opt/corsen/dist/index.js', 'mcp'] })
    expect(configurator.status('cursor').connected).toBe(true)
  })

  it('backs up an existing file, preserves comments and other servers', async () => {
    const file = claudeDesktopConfig(ctx)
    mkdirSync(dirname(file), { recursive: true })
    const original = '{\n    // my servers\n    "mcpServers": {\n        "other": { "command": "x" }\n    },\n    "theme": "dark"\n}\n'
    writeFileSync(file, original)
    const result = await configurator.connect('claude-desktop')
    expect(result.backupPaths).toHaveLength(1)
    expect(readFileSync(result.backupPaths[0]!, 'utf8')).toBe(original)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('// my servers')
    expect(text).toContain('"other"')
    expect(text).toContain('        "corsen-browser"') // indentation detected (4 spaces) and kept
    expect(result.message).toContain('Restart Claude Desktop')
  })

  it('refuses to touch a file that is not valid JSON', async () => {
    const file = cursorConfig(ctx)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ "mcpServers": { broken ')
    await expect(configurator.connect('cursor')).rejects.toThrow(/not valid JSON/)
    expect(readFileSync(file, 'utf8')).toBe('{ "mcpServers": { broken ')
    expect(readdirSync(dirname(file)).filter((name) => name.endsWith('.bak'))).toHaveLength(0)
  })

  it('edits through a symlink without replacing it', async () => {
    const real = join(home.path, 'dotfiles', 'mcp.json')
    mkdirSync(dirname(real), { recursive: true })
    writeFileSync(real, '{}\n')
    mkdirSync(join(home.path, '.cursor'), { recursive: true })
    symlinkSync(real, cursorConfig(ctx))
    await configurator.connect('cursor')
    expect(read(real).mcpServers['corsen-browser']).toBeDefined()
    expect(readdirSync(join(home.path, '.cursor'))).toEqual(['mcp.json'])
  })

  it('unlinks only our entry and restores the last backup', async () => {
    const file = claudeDesktopConfig(ctx)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ "mcpServers": { "other": { "command": "x" } } }\n')
    await configurator.connect('claude-desktop')
    const unlinked = await configurator.unlink('claude-desktop')
    expect(unlinked.changed).toBe(true)
    expect(read(file).mcpServers).toEqual({ other: { command: 'x' } })
    expect(configurator.status('claude-desktop').connected).toBe(false)

    await configurator.connect('claude-desktop')
    const restored = await configurator.restore('claude-desktop')
    expect(restored.changed).toBe(true)
    expect(read(file).mcpServers['corsen-browser']).toBeUndefined()
    expect(configurator.status('claude-desktop').backups).toBeGreaterThanOrEqual(3)
  })

  it('writes the OpenCode shape under mcp.servers and keeps JSONC', async () => {
    const dir = join(home.path, '.config', 'opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode.jsonc'), '{\n  // keep me\n  "theme": "x",\n}\n')
    await configurator.connect('opencode')
    const text = readFileSync(join(dir, 'opencode.jsonc'), 'utf8')
    expect(text).toContain('// keep me')
    expect(text).toContain('"type": "local"')
    expect(text).toContain('"command": [')
  })

  it('writes Cline and Roo entries with approvals off', async () => {
    const storage = join(home.path, '.config', 'Code', 'User', 'globalStorage')
    mkdirSync(join(storage, 'saoudrizwan.claude-dev'), { recursive: true })
    mkdirSync(join(storage, 'rooveterinaryinc.roo-cline'), { recursive: true })
    await configurator.connect('cline')
    await configurator.connect('roo-code')
    const cline = read(join(storage, 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')).mcpServers['corsen-browser']
    const roo = read(join(storage, 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')).mcpServers['corsen-browser']
    expect(cline).toMatchObject({ disabled: false, autoApprove: [] })
    expect(roo).toMatchObject({ disabled: false, alwaysAllow: [] })
  })
})

describe('Claude Code through its CLI', () => {
  /**
   * A stand-in `claude` CLI that records its arguments and edits its state file like the real one:
   * `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set, `~/.claude.json` otherwise.
   */
  function fakeClaudeCli(): { bin: string; log: string } {
    const bin = join(home.path, 'bin')
    mkdirSync(bin, { recursive: true })
    const log = join(home.path, 'claude-calls.log')
    writeFileSync(
      join(bin, 'claude'),
      `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(process.env.HOME, '.claude.json')
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
data.mcpServers = data.mcpServers || {}
if (args[1] === 'add-json') data.mcpServers[args[4]] = JSON.parse(args[5])
if (args[1] === 'remove') delete data.mcpServers[args[4]]
fs.writeFileSync(file, JSON.stringify(data))
`,
    )
    chmodSync(join(bin, 'claude'), 0o755)
    return { bin, log }
  }

  it('runs the CLI with the configurator environment only, never the test process one', async () => {
    const seen: Array<Readonly<Record<string, string | undefined>>> = []
    const previous = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = join(home.path, 'must-not-be-used')
    try {
      const { bin } = fakeClaudeCli()
      ctx = { platform: 'linux', home: home.path, env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: home.path } }
      configurator = new AgentConfigurator({
        ctx,
        launch,
        backups: new BackupStore(join(home.path, '.corsen-connector', 'backups.json')),
        logger: silentLogger,
        runner: async (_command, _args, options) => {
          seen.push({ ...options.env })
          return { code: 0, stdout: '', stderr: '' }
        },
      })
      await configurator.connect('claude-code').catch(() => undefined)
      expect(seen.length).toBeGreaterThan(0)
      for (const env of seen) {
        expect(env['CLAUDE_CONFIG_DIR']).toBeUndefined()
        expect(env['HOME']).toBe(home.path)
      }
      expect(existsSync(join(home.path, 'must-not-be-used'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = previous
    }
  })

  it('follows CLAUDE_CONFIG_DIR: verifies and backs up the file the CLI really writes', async () => {
    const { bin } = fakeClaudeCli()
    const configDir = join(home.path, 'claude-profile')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ numStartups: 7 }))
    writeFileSync(join(home.path, '.claude.json'), JSON.stringify({ untouched: true }))
    configurator = make({ PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: home.path, CLAUDE_CONFIG_DIR: configDir })
    expect(configurator.status('claude-code').configPaths).toEqual(['~/claude-profile/.claude.json'])

    const connected = await configurator.connect('claude-code')
    expect(connected.agent.connected).toBe(true)
    expect(connected.message).toContain('Connected Claude Code')
    expect(connected.backupPaths).toHaveLength(1)
    expect(connected.backupPaths[0]?.startsWith(join(configDir, '.claude.json.corsen-backup-'))).toBe(true)
    expect(read(join(configDir, '.claude.json')).mcpServers['corsen-browser']).toMatchObject({ type: 'stdio', command: '/usr/bin/node' })
    expect(read(join(home.path, '.claude.json'))).toEqual({ untouched: true })
    expect(readdirSync(home.path).filter((name) => name.startsWith('.claude.json.corsen-backup-'))).toEqual([])

    const restored = await configurator.restore('claude-code')
    expect(restored.agent.connected).toBe(false)
    expect(restored.message).toContain('~/claude-profile/.claude.json')
  })

  it('calls `claude mcp remove` then `claude mcp add-json --scope user` and verifies the result', async () => {
    const { bin, log } = fakeClaudeCli()
    writeFileSync(join(home.path, '.claude.json'), JSON.stringify({ projects: {}, numStartups: 3 }))
    configurator = make({ PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: home.path })
    expect(configurator.status('claude-code').method).toBe('cli')

    const connected = await configurator.connect('claude-code')
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(calls[0]).toEqual(['mcp', 'remove', '--scope', 'user', 'corsen-browser'])
    expect(calls[1].slice(0, 5)).toEqual(['mcp', 'add-json', '--scope', 'user', 'corsen-browser'])
    expect(JSON.parse(calls[1][5])).toEqual({ type: 'stdio', command: '/usr/bin/node', args: ['/opt/corsen/dist/index.js', 'mcp'] })
    expect(connected.agent.connected).toBe(true)
    expect(connected.backupPaths).toHaveLength(1)
    expect(read(join(home.path, '.claude.json')).numStartups).toBe(3)

    const restored = await configurator.restore('claude-code')
    expect(restored.agent.connected).toBe(false)
    expect(restored.message).toContain('removes our entry')
  })
})

describe('launch command', () => {
  const base = { platform: 'linux' as const, nodePath: '/usr/bin/node', version: '0.1.0', port: 43110, connectorHome: '/h/.corsen-connector', defaultConnectorHome: '/h/.corsen-connector' }

  it('uses the absolute node + script for local installs', () => {
    expect(resolveLaunchCommand({ ...base, entry: '/repo/packages/daemon/dist/index.js' })).toEqual({ command: '/usr/bin/node', args: ['/repo/packages/daemon/dist/index.js', 'mcp'], env: {} })
  })

  it('uses a pinned npx command when running from the npx cache', () => {
    const command = resolveLaunchCommand({ ...base, entry: '/h/.npm/_npx/abc/node_modules/@corsen-ai/universal-connector/dist/index.js' })
    expect(command.args).toEqual(['-y', '@corsen-ai/universal-connector@0.1.0', 'mcp'])
    const win = resolveLaunchCommand({ ...base, platform: 'win32', nodePath: 'C:\\node\\node.exe', entry: 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\index.js' })
    expect(win.command).toBe('cmd')
    expect(win.args[0]).toBe('/c')
  })

  it('passes a non-default home and port through env', () => {
    const command = resolveLaunchCommand({ ...base, port: 45000, connectorHome: '/opt/connector-home', entry: '/repo/dist/index.js' })
    expect(command.env).toEqual({ CORSEN_CONNECTOR_HOME: '/opt/connector-home', CORSEN_CONNECTOR_PORT: '45000' })
  })

  it('never writes outside the temporary home', () => {
    expect(existsSync(join(home.path, '.corsen-connector'))).toBe(false)
  })
})
