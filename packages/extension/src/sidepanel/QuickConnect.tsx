import { Cable, ExternalLink, FlaskConical, Plug, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentActionResult, AgentStatus } from '@corsen-ai/shared'
import type { UiState } from '../messages'
import { Button, Card, CopyField, ErrorNote, StatusPill, linkTone, statusLabel } from '../shared-ui/components'
import { t } from '../shared-ui/i18n'
import { send } from '../shared-ui/use-extension'

// The daemon is distributed as source: run from the repository checkout (see the README's start).
const START_COMMAND = 'pnpm connector'
const GET_DAEMON_URL = 'https://github.com/CorsenAI/universal-ai-agent-chrome-connector#30-second-start'

function PairingCard({ state }: { state: UiState }) {
  const [code, setCode] = useState('')
  const [port, setPort] = useState(String(state.link.port || 43110))
  const [error, setError] = useState<string | null>(null)
  const pair = async (): Promise<void> => {
    setError(null)
    const response = await send({ type: 'setPairing', code, port: Number(port) || undefined })
    if (!response.ok) setError(response.error.message)
  }
  return (
    <Card title={t('pairTitle')} icon={<Plug size={14} />}>
      <p className="mb-2 text-[12px] text-ink-400">{t('pairHelp')}</p>
      <CopyField label={t('startDaemon')} value={START_COMMAND} />
      <a className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-brand-2 hover:underline" href={GET_DAEMON_URL} target="_blank" rel="noreferrer">
        <ExternalLink size={12} /> {t('getDaemon')}
      </a>
      <div className="mt-2 flex gap-1.5">
        <input
          aria-label="Pairing code"
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[12px] uppercase tracking-wider"
          placeholder={t('pairingCodePlaceholder')}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <input aria-label="Port" className="w-16 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1.5 text-[12px]" value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))} />
        <Button variant="primary" onClick={() => void pair()} disabled={code.trim() === ''}>
          {t('pairButton')}
        </Button>
      </div>
      <ErrorNote message={error} />
    </Card>
  )
}

function AgentRow({ agent, onDone }: { agent: AgentStatus; onDone: (message: string, error: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const run = async (method: 'agents.connect' | 'agents.unlink' | 'agents.restore'): Promise<void> => {
    setBusy(true)
    const response = await send<AgentActionResult>({ type: 'daemonCall', method, params: { agentId: agent.id } })
    setBusy(false)
    onDone(response.ok ? response.result.message : `${agent.name}: ${response.error.message}`, !response.ok)
  }
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] font-semibold">
        <span className="truncate">{agent.name}</span>
        <span className={agent.connected ? 'rounded-full border border-green-800 bg-green-950 px-1.5 text-[10.5px] text-green-200' : 'rounded-full border border-ink-700 px-1.5 text-[10.5px] text-ink-400'}>
          {agent.connected ? t('connected') : agent.detected ? t('detected') : t('notFound')}
        </span>
      </div>
      <div className="flex gap-1">
        <Button variant={agent.connected ? 'ghost' : 'primary'} disabled={busy} onClick={() => void run('agents.connect')}>
          {agent.connected ? t('reconnectAgent') : t('connectShort')}
        </Button>
        {agent.connected && (
          <Button disabled={busy} onClick={() => void run('agents.unlink')}>
            {t('unlink')}
          </Button>
        )}
        {agent.backups > 0 && (
          <Button disabled={busy} onClick={() => void run('agents.restore')} title={t('restore')}>
            ↺
          </Button>
        )}
      </div>
      <p className="col-span-2 truncate text-[11px] text-ink-400" title={agent.configPaths.join(', ')}>
        {agent.configPaths.join(', ')}
      </p>
    </div>
  )
}

export function QuickConnect({ state }: { state: UiState }) {
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [note, setNote] = useState<{ message: string; error: boolean } | null>(null)
  const [selftest, setSelftest] = useState<Array<{ name: string; ok: boolean; ms: number; detail: string }> | null>(null)
  const [testing, setTesting] = useState(false)
  const connected = state.link.status === 'connected'

  const loadAgents = async (): Promise<void> => {
    const response = await send<{ agents: AgentStatus[] }>({ type: 'daemonCall', method: 'agents.list', params: {} })
    if (response.ok) setAgents(response.result.agents)
  }

  useEffect(() => {
    if (connected) void loadAgents()
  }, [connected])

  const runSelftest = async (): Promise<void> => {
    setTesting(true)
    setSelftest(null)
    const response = await send<{ ok: boolean; steps: Array<{ name: string; ok: boolean; ms: number; detail: string }> }>({ type: 'daemonCall', method: 'daemon.selftest', params: {} })
    setTesting(false)
    if (response.ok) setSelftest(response.result.steps)
    else setSelftest([{ name: t('daemon'), ok: false, ms: 0, detail: response.error.message }])
  }

  const connectedAgents = agents.filter((agent) => agent.connected).length
  const sorted = [...agents].sort((a, b) => Number(b.detected) - Number(a.detected) || Number(b.connected) - Number(a.connected))

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-1.5">
        <StatusPill label={`${t('extension')} v${state.version}`} tone="ok" />
        <StatusPill label={`${t('daemon')} · ${statusLabel(state.link.status)}`} tone={linkTone(state.link.status)} title={state.link.detail} />
        <StatusPill label={`${t('agents')} · ${connectedAgents}`} tone={connectedAgents > 0 ? 'ok' : connected ? 'warn' : 'bad'} />
      </div>

      {state.link.status !== 'connected' && state.link.detail !== '' && <p className="text-[12px] text-ink-400">{state.link.detail}</p>}
      {state.link.status === 'superseded' && (
        <Button variant="primary" onClick={() => void send({ type: 'reconnect', takeover: true })}>
          {t('useThisBrowser')}
        </Button>
      )}
      {(state.link.status === 'offline' || state.link.status === 'denied') && state.link.paired && (
        <Button onClick={() => void send({ type: 'reconnect', takeover: false })}>
          <RefreshCw size={13} /> {t('retry')}
        </Button>
      )}
      {(!state.link.paired || state.link.status === 'denied') && <PairingCard state={state} />}

      {connected && (
        <Card title={t('agents')} icon={<Cable size={14} />}>
          <div className="grid gap-1.5">
            {sorted.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                onDone={(message, error) => {
                  setNote({ message, error })
                  void loadAgents()
                }}
              />
            ))}
          </div>
          {note !== null && <p className={note.error ? 'mt-2 text-[12px] text-red-300' : 'mt-2 text-[12px] text-indigo-200'}>{note.message}</p>}
        </Card>
      )}

      {connected && state.daemon !== null && (
        <Card
          title={t('endpoints')}
          actions={
            <Button onClick={() => void chrome.tabs.create({ url: state.daemon?.dashboardUrl ?? 'about:blank' })}>
              <ExternalLink size={13} /> {t('openDashboard')}
            </Button>
          }
        >
          <div className="grid gap-2">
            <CopyField label={t('openaiBase')} value={state.daemon.apiBaseUrl} />
            <CopyField label={t('anthropicBase')} value={state.daemon.anthropicBaseUrl} />
            <CopyField label={t('mcpUrl')} value={state.daemon.mcpUrl} />
            <CopyField label={t('apiKey')} value={state.daemon.apiToken} secret />
            <p className="text-[11px] text-ink-400">Models: {state.daemon.models.join(' · ')}</p>
          </div>
        </Card>
      )}

      {connected && (
        <Card>
          <Button variant="primary" className="w-full" disabled={testing} onClick={() => void runSelftest()}>
            <FlaskConical size={14} /> {testing ? t('testing') : t('testBridge')}
          </Button>
          {selftest !== null && (
            <ul className="mt-2 grid gap-1 text-[12px]">
              {selftest.map((step) => (
                <li key={step.name} className={step.ok ? 'text-ink-200' : 'text-red-300'}>
                  {step.ok ? '✅' : '❌'} {step.name} — {step.detail} <span className="text-ink-500">({step.ms} ms)</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {state.link.paired && (
        <p className="text-center text-[11px] text-ink-500">
          <button type="button" className="underline hover:text-ink-200" onClick={() => void send({ type: 'forgetPairing' })}>
            {t('forget')}
          </button>
        </p>
      )}
    </div>
  )
}
