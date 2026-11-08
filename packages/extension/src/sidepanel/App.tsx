import { Activity, Cable, LayoutList } from 'lucide-react'
import { useState } from 'react'
import { Dot, Logo, linkTone, statusLabel } from '../shared-ui/components'
import { t } from '../shared-ui/i18n'
import { useExtensionState } from '../shared-ui/use-extension'
import { ActivityFeed } from './ActivityFeed'
import { QuickConnect } from './QuickConnect'
import { TabManager } from './TabManager'

type View = 'connect' | 'tabs' | 'activity'

export function App() {
  const { state } = useExtensionState()
  const [view, setView] = useState<View>('connect')
  if (state === null) return <p className="p-4 text-ink-400">…</p>
  const tabs: Array<{ id: View; label: string; icon: React.ReactNode }> = [
    { id: 'connect', label: t('quickConnect'), icon: <Cable size={14} /> },
    { id: 'tabs', label: t('tabManager'), icon: <LayoutList size={14} /> },
    { id: 'activity', label: t('activity'), icon: <Activity size={14} /> },
  ]
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-ink-700 bg-ink-950/95 px-3 pt-3 backdrop-blur">
        <div className="mb-2 flex items-center gap-2">
          <Logo />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-semibold">Universal AI Agent Connector</p>
            <p className="text-[11px] text-ink-400">by Corsen AI</p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-200" title={state.link.detail}>
            <Dot tone={linkTone(state.link.status)} />
            {statusLabel(state.link.status)}
          </span>
        </div>
        <nav role="tablist" className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={view === tab.id}
              onClick={() => setView(tab.id)}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-t-lg border-b-2 px-2 py-2 text-[12px] ${view === tab.id ? 'border-brand text-ink-50' : 'border-transparent text-ink-400 hover:text-ink-50'}`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="flex-1 p-3">
        {view === 'connect' && <QuickConnect state={state} />}
        {view === 'tabs' && <TabManager state={state} />}
        {view === 'activity' && <ActivityFeed state={state} />}
      </main>
      <footer className="px-3 pb-3 text-center text-[10.5px] text-ink-500">Local only · No telemetry · Unofficial community project</footer>
    </div>
  )
}
