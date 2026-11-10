import { PanelRight, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TabRole } from '@corsen-ai/shared'
import { Button, Dot, ErrorNote, Logo, RoleSwitch, linkTone, statusLabel } from '../shared-ui/components'
import { t } from '../shared-ui/i18n'
import { send, useExtensionState } from '../shared-ui/use-extension'

/** Reads the pairing meta of the open dashboard tab. Runs in the page under activeTab (D-004). */
function readDashboardPairing(): { code: string | null; port: number } {
  const code = document.querySelector('meta[name="corsen-pairing"]')?.getAttribute('content') ?? null
  const port = Number(document.querySelector('meta[name="corsen-port"]')?.getAttribute('content') ?? '0')
  return { code, port }
}

function isDashboardUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && parsed.pathname === '/'
  } catch {
    return false
  }
}

export function App() {
  const { state } = useExtensionState()
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const [windowId, setWindowId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      setActiveTabId(tab?.id ?? null)
      setWindowId(tab?.windowId ?? null)
    })
  }, [])

  if (state === null) return <p className="p-4 text-ink-400">…</p>
  const tab = state.tabs.find((item) => item.tabId === activeTabId)
  const onDashboard = tab !== undefined && isDashboardUrl(tab.url)

  const changeRole = async (role: TabRole): Promise<void> => {
    if (tab === undefined) return
    setError(null)
    const response = await send({ type: 'setRole', tabId: tab.tabId, role })
    if (!response.ok) setError(response.error.message)
  }

  const pairFromDashboard = async (): Promise<void> => {
    if (tab === undefined) return
    setPairing(true)
    setError(null)
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.tabId }, func: readDashboardPairing })
      const result = injection?.result as { code: string | null; port: number } | undefined
      if (result?.code === null || result?.code === undefined) {
        setError(t('noPairingCode'))
        return
      }
      const response = await send({ type: 'setPairing', code: result.code, ...(result.port > 0 ? { port: result.port } : {}) })
      if (!response.ok) setError(response.error.message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPairing(false)
    }
  }

  return (
    <div className="grid w-[340px] gap-3 p-3">
      <header className="flex items-center gap-2">
        <Logo />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-semibold">Corsen Connector</p>
          <p className="flex items-center gap-1.5 text-[11px] text-ink-400" title={state.link.detail}>
            <Dot tone={linkTone(state.link.status)} /> {statusLabel(state.link.status)}
          </p>
        </div>
      </header>

      {onDashboard && (
        <Button variant="primary" className="w-full py-2.5 text-[13.5px]" disabled={pairing} onClick={() => void pairFromDashboard()}>
          <Zap size={15} /> {t('pairWithDashboard')}
        </Button>
      )}

      {tab !== undefined && !onDashboard && (
        <section className="grid gap-2 rounded-xl border border-ink-700 bg-ink-850 p-3">
          <p className="text-[11px] uppercase tracking-wide text-ink-400">{t('activeTab')}</p>
          <p className="truncate font-medium" title={tab.title}>
            {tab.title || tab.host}
          </p>
          <p className="truncate text-[11px] text-ink-400">{tab.host}{tab.harnessId !== null ? ` · ${tab.harnessId}` : ''}</p>
          {tab.restricted ? (
            <p className="text-[12px] text-ink-400">{t('restricted')}</p>
          ) : (
            <RoleSwitch role={tab.role} onChange={(role) => void changeRole(role)} disabled={false} brainDisabled={tab.harnessId === null} brainHint={t('notAChat')} />
          )}
          <p className="text-[11px] text-ink-500">{tab.role === 'brain' ? t('roleBrainLong') : tab.role === 'mcp' ? t('roleMcpLong') : t('roleIgnoredLong')}</p>
        </section>
      )}

      {state.link.status === 'superseded' && (
        <Button variant="primary" onClick={() => void send({ type: 'reconnect', takeover: true })}>
          {t('useThisBrowser')}
        </Button>
      )}

      <ErrorNote message={error} />

      <Button
        className="w-full"
        onClick={() => {
          if (windowId !== null) void chrome.sidePanel.open({ windowId }).then(() => window.close())
        }}
      >
        <PanelRight size={14} /> {t('openSidePanel')}
      </Button>
    </div>
  )
}
