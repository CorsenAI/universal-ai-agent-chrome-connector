import { describe, expect, it } from 'vitest'
import { HELP, parseCli } from '../src/cli/args'
import { startBanner } from '../src/cli/banner'
import { cliName } from '../src/cli/cli-name'

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
