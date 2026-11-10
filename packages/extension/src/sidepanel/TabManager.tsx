import { Crosshair, Globe } from 'lucide-react'
import { useState } from 'react'
import type { TabRole } from '@corsen-ai/shared'
import type { UiState, UiTab } from '../messages'
import { Button, Card, ErrorNote, RoleSwitch, cx } from '../shared-ui/components'
import { t } from '../shared-ui/i18n'
import { send } from '../shared-ui/use-extension'

function Calibration({ tab, onError }: { tab: UiTab; onError: (message: string | null) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const pick = async (kind: 'input' | 'send' | 'response' | 'stop'): Promise<void> => {
    setBusy(kind)
    onError(null)
    const response = await send({ type: 'calibrate', tabId: tab.tabId, kind })
    setBusy(null)
    if (!response.ok && response.error.code !== 'CANCELLED') onError(response.error.message)
  }
  return (
    <div className="mt-2 grid gap-1.5 rounded-lg border border-dashed border-ink-700 p-2">
      <p className="text-[11.5px] text-ink-400">{t('calibrateHelp')}</p>
      <div className="flex flex-wrap gap-1">
        <Button disabled={busy !== null} onClick={() => void pick('input')}>{busy === 'input' ? '…' : t('pickInput')}</Button>
        <Button disabled={busy !== null} onClick={() => void pick('send')}>{busy === 'send' ? '…' : t('pickSend')}</Button>
        <Button disabled={busy !== null} onClick={() => void pick('response')}>{busy === 'response' ? '…' : t('pickResponse')}</Button>
        <Button disabled={busy !== null} onClick={() => void pick('stop')}>{busy === 'stop' ? '…' : t('pickStop')}</Button>
        <Button disabled={busy !== null} onClick={() => void send({ type: 'clearCalibration', host: tab.host })}>{t('clearCalibration')}</Button>
      </div>
    </div>
  )
}

function TabRow({ tab, calibration }: { tab: UiTab; calibration: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const change = async (role: TabRole): Promise<void> => {
    setError(null)
    const response = await send({ type: 'setRole', tabId: tab.tabId, role })
    if (!response.ok) setError(response.error.message)
  }
  return (
    <li className={cx('rounded-lg border bg-ink-900 px-2.5 py-2', tab.role === 'brain' ? 'border-brand/60' : tab.role === 'mcp' ? 'border-brand-2/60' : 'border-ink-700')}>
      <div className="flex items-center gap-2">
        {tab.favIconUrl !== '' ? <img src={tab.favIconUrl} alt="" width={16} height={16} className="shrink-0 rounded-sm" /> : <Globe size={16} className="shrink-0 text-ink-500" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium" title={tab.title}>
            {tab.active && <span className="mr-1 text-[10px] text-brand-2">●</span>}
            {tab.title || tab.host}
          </p>
          <p className="truncate text-[11px] text-ink-400" title={tab.url}>
            {tab.host}
            {tab.harnessId !== null && tab.role !== 'mcp' && ` · ${t('chatSite', { id: tab.harnessId })}`}
            {tab.busy && ` · ${t('generating')}`}
            {tab.role === 'mcp' && ` · ${t('consoleErrors', { n: tab.consoleErrors })} · ${t('networkErrors', { n: tab.networkErrors })}`}
          </p>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 pl-6">
        <RoleSwitch role={tab.role} onChange={(role) => void change(role)} disabled={tab.restricted} brainDisabled={tab.harnessId === null} brainHint={t('notAChat')} />
        {!tab.restricted && (
          <button type="button" title={t('calibrate')} aria-expanded={open} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-ink-400 hover:text-ink-50" onClick={() => setOpen(!open)}>
            <Crosshair size={13} /> {t('calibrate')}
          </button>
        )}
      </div>
      {tab.restricted && <p className="mt-1 text-[11px] text-ink-500">{t('restricted')}</p>}
      {calibration && <p className="mt-1 text-[11px] text-indigo-200">{t('calibrated')}</p>}
      {open && <Calibration tab={tab} onError={setError} />}
      <ErrorNote message={error} />
    </li>
  )
}

export function TabManager({ state }: { state: UiState }) {
  const [showAll, setShowAll] = useState(false)
  const tabs = state.tabs.filter((tab) => showAll || !tab.restricted)
  const ordered = [...tabs].sort((a, b) => Number(b.role !== 'ignored') - Number(a.role !== 'ignored') || Number(b.active) - Number(a.active))
  return (
    <div className="grid gap-2">
      <Card>
        <ul className="grid gap-1 text-[12px] text-ink-200">
          <li>{t('roleIgnoredLong')}</li>
          <li>{t('roleBrainLong')}</li>
          <li>{t('roleMcpLong')}</li>
        </ul>
      </Card>
      <label className="flex items-center gap-2 text-[12px] text-ink-400">
        <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> {t('showAllTabs')}
      </label>
      <ul className="grid gap-1.5">
        {ordered.map((tab) => (
          <TabRow key={tab.tabId} tab={tab} calibration={state.calibrations[tab.host] !== undefined} />
        ))}
      </ul>
    </div>
  )
}
