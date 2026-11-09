import { VERSION, formatPairingCode } from '@corsen-ai/shared'

const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined
const paint = (code: string) => (text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text)
export const bold = paint('1')
export const dim = paint('2')
export const green = paint('32')
export const red = paint('31')
export const yellow = paint('33')
export const violet = paint('35')
export const cyan = paint('36')

export const LOGO = [
  '   ______                             ',
  '  / ____/___  ______________  ____    ',
  ' / /   / __ \\/ ___/ ___/ _ \\/ __ \\   ',
  '/ /___/ /_/ / /  (__  )  __/ / / /   ',
  '\\____/\\____/_/  /____/\\___/_/ /_/    ',
]

export function maskToken(token: string): string {
  return token.length > 12 ? `${token.slice(0, 8)}…${token.slice(-4)}` : '••••'
}

export interface BannerInfo {
  readonly port: number
  readonly dashboardUrl: string
  readonly pairingSecret: string
  readonly apiToken: string
  readonly showToken: boolean
  /** The command the user runs the CLI with (see cli-name.ts). */
  readonly cli: string
}

export function startBanner(info: BannerInfo): string {
  const base = `http://127.0.0.1:${info.port}`
  return [
    '',
    ...LOGO.map((line, index) => (index % 2 === 0 ? violet(line) : cyan(line))),
    `${bold('Universal AI Agent Chrome Connector')} ${dim(`v${VERSION} · by Corsen AI`)}`,
    '',
    `  ${green('●')} Daemon       ${base}  ${dim('(loopback only)')}`,
    `  ${bold('Dashboard')}    ${info.dashboardUrl}`,
    `  ${bold('Extension')}    ${dim('Chrome Web Store › Universal AI Agent Connector — by Corsen AI')}`,
    `  ${bold('Pairing code')} ${bold(formatPairingCode(info.pairingSecret))}  ${dim('→ extension popup › Pair, or paste it in the side panel')}`,
    `  ${bold('API key')}      ${info.showToken ? info.apiToken : `${maskToken(info.apiToken)}  ${dim(`(${info.cli} token --show)`)}`}`,
    '',
    `  ${dim('OpenAI base URL   ')} ${base}/v1`,
    `  ${dim('Anthropic base URL')} ${base}`,
    `  ${dim('MCP (HTTP)        ')} ${base}/mcp   ${dim(`· stdio: ${info.cli} mcp`)}`,
    '',
    `  Next: ${cyan(`${info.cli} setup`)} to connect Claude Code, Cursor, Cline… in one step.`,
    `  ${dim('Ctrl+C to stop. Documentation and issues: https://github.com/CorsenAI/universal-ai-agent-chrome-connector')}`,
    '',
  ].join('\n')
}
