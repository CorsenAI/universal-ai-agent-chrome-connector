import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCredentials } from '../src/auth/credentials'
import { connectorPaths } from '../src/config/paths'
import { probeDaemon } from '../src/daemon/lifecycle'
import { runDaemon, type DaemonHandle } from '../src/daemon/run-daemon'
import { silentLogger } from '../src/util/logger'
import { FakeExtension, tab } from './helpers/fake-extension'
import { freePort, tempDir, waitFor } from './helpers/env'

/**
 * Runs the BUILT CLI exactly like an agent does (`node dist/index.js mcp`), so the packaged
 * artifact is what is tested. Run `pnpm build` first (the root `pnpm test` script order).
 */
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))

function stdioEnv(home: string, port: number): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', HOME: home, CORSEN_CONNECTOR_HOME: home, CORSEN_CONNECTOR_PORT: String(port) }
}

describe('MCP stdio proxy (built artifact)', () => {
  let home: ReturnType<typeof tempDir>
  let daemon: DaemonHandle
  let extension: FakeExtension
  let port: number

  beforeAll(async () => {
    if (!existsSync(entry)) throw new Error(`missing ${entry}: run \`pnpm build\` before the tests`)
    home = tempDir('stdio')
    port = await freePort()
    daemon = await runDaemon({ port, home: home.path, logger: silentLogger, writePid: false })
    const credentials = readCredentials(connectorPaths(home.path).credentials)!
    extension = new FakeExtension({
      port,
      secret: credentials.pairingSecret,
      handler: (method) => {
        if (method === 'targets.list') return { targets: [{ targetId: '3', title: 'Jira', url: 'https://jira.example/', consoleErrors: 0, networkErrors: 0, active: false }] }
        throw Object.assign(new Error(`unexpected ${method}`), { code: 'UNSUPPORTED' })
      },
    })
    expect(await extension.ready).toBe('paired')
    extension.pushState({ tabs: [tab({ tabId: 3, role: 'mcp' })] })
    await waitFor(() => daemon.ctx.hub.state() !== null, 5_000, 'state')
  })

  afterAll(async () => {
    extension?.close()
    await daemon?.stop()
    home?.cleanup()
  })

  for (const mode of ['legacy', 'auto'] as const) {
    it(`serves a ${mode} MCP client over stdio and forwards tool calls to the daemon`, async () => {
      const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'], env: stdioEnv(home.path, port), stderr: 'pipe' })
      const client = new Client({ name: 'stdio-test', version: '1.0.0' }, { versionNegotiation: { mode } })
      await client.connect(transport)
      expect(client.getProtocolEra()).toBe(mode === 'legacy' ? 'legacy' : 'modern')
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(6)
      const result = await client.callTool({ name: 'browser_list_targets', arguments: {} })
      expect(JSON.stringify(result.content)).toContain('target_id 3: Jira')
      await client.close()
    })
  }
})

describe('daemon auto-start from the stdio proxy', () => {
  it('starts a detached daemon when none is running', async () => {
    if (!existsSync(entry)) throw new Error(`missing ${entry}: run \`pnpm build\` before the tests`)
    const home = tempDir('autostart')
    const port = await freePort()
    try {
      expect((await probeDaemon(port)).kind).toBe('down')
      const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'], env: stdioEnv(home.path, port), stderr: 'pipe' })
      const client = new Client({ name: 'autostart-test', version: '1.0.0' })
      await client.connect(transport)
      const result = await client.callTool({ name: 'browser_list_targets', arguments: {} })
      // No browser is paired in this fresh home: an honest, typed error — but from a running daemon.
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('NO_BROWSER')
      const probe = await probeDaemon(port)
      expect(probe.kind).toBe('ours')
      expect(existsSync(join(home.path, 'credentials.json'))).toBe(true)
      await client.close()
      // Stop the detached daemon we caused.
      const credentials = readCredentials(connectorPaths(home.path).credentials)!
      await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${credentials.apiToken}`, 'content-type': 'application/json' }, body: '{}' })
      for (let attempt = 0; attempt < 50 && (await probeDaemon(port, 300)).kind === 'ours'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100))
      expect((await probeDaemon(port)).kind).toBe('down')
    } finally {
      home.cleanup()
    }
  })
})
