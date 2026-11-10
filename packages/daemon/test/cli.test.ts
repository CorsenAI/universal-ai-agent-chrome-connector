import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadOrCreateCredentials } from '../src/auth/credentials'
import { HELP, parseCli } from '../src/cli/args'
import { startBanner } from '../src/cli/banner'
import { cliName } from '../src/cli/cli-name'
import { connectorPaths } from '../src/config/paths'
import { runDaemon } from '../src/daemon/run-daemon'
import { silentLogger } from '../src/util/logger'
import { freePort, tempDir } from './helpers/env'

/** The BUILT CLI, run asynchronously (the daemon under test lives in this process). */
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))

function runCli(args: readonly string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const REPO = 'https://github.com/CorsenAI/universal-ai-agent-chrome-connector'
const STORE_NAME = 'Universal AI Agent Connector — by Corsen AI'

describe('CLI distribution hints', () => {
  it('names the command the user actually ran', () => {
    expect(cliName({ npm_lifecycle_event: 'connector' })).toBe('pnpm connector')
    expect(cliName({})).toBe('universal-connector')
    expect(cliName({ npm_lifecycle_event: 'start' })).toBe('universal-connector')
  })

  it('help explains where the source and the extension come from', () => {
    expect(HELP).toContain(REPO)
    expect(HELP).toContain('pnpm connector')
    expect(HELP).toContain(`Chrome Web Store: ${STORE_NAME}`)
    expect(HELP).not.toMatch(/npx/)
  })

  it('the start banner points to the Store extension and uses the detected command', () => {
    const banner = startBanner({ port: 43110, dashboardUrl: 'http://127.0.0.1:43110/login?code=x', pairingSecret: 'A'.repeat(20), apiToken: 'csk_abcdefghijklmnop', showToken: false, cli: 'pnpm connector' })
    expect(banner).toContain(`Chrome Web Store › ${STORE_NAME}`)
    expect(banner).toContain('(pnpm connector token --show)')
    expect(banner).toContain('pnpm connector setup')
    expect(banner).toContain('stdio: pnpm connector mcp')
    expect(banner).toContain(REPO)
    expect(banner).not.toContain('csk_abcdefghijklmnop')
  })

  it('parses a command with its options', () => {
    const args = parseCli(['token', '--show'])
    expect(args.command).toBe('token')
    expect(args.show).toBe(true)
  })
})

describe('CLI against a daemon started with other credentials (built artifact)', () => {
  it('explains the mismatch instead of printing nothing or a generic refusal', async () => {
    if (!existsSync(entry)) throw new Error(`missing ${entry}: run \`pnpm build\` before the tests`)
    const homeA = tempDir('cli-home-a')
    const homeB = tempDir('cli-home-b')
    const port = await freePort()
    const daemon = await runDaemon({ port, home: homeA.path, logger: silentLogger, writePid: false })
    try {
      loadOrCreateCredentials(connectorPaths(homeB.path).credentials)
      const env = { PATH: process.env['PATH'] ?? '', HOME: homeB.path, CORSEN_CONNECTOR_HOME: homeB.path, CORSEN_CONNECTOR_PORT: String(port), NO_COLOR: '1' }
      const start = await runCli(['start', '--no-open'], env)
      expect(start.code).toBe(0)
      expect(start.stdout).toContain('already running')
      expect(start.stdout).toContain('other credentials')
      const dashboard = await runCli(['dashboard', '--no-open'], env)
      expect(dashboard.code).toBe(1)
      expect(dashboard.stderr).toContain('other credentials')
      expect(dashboard.stderr).not.toContain('not running')
    } finally {
      await daemon.stop()
      homeA.cleanup()
      homeB.cleanup()
    }
  })
})
