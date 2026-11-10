import { Power } from 'lucide-react'
import { useState } from 'react'
import type { UiState } from '../messages'
import { Button, Card } from '../shared-ui/components'
import { t } from '../shared-ui/i18n'
import { send } from '../shared-ui/use-extension'

const KIND_ICON: Record<string, string> = { llm: '🧠', mcp: '🛠️', system: '⚙️', agent: '⚡', security: '🛡️' }

export function ActivityFeed({ state }: { state: UiState }) {
  const [panicResult, setPanicResult] = useState<string | null>(null)
  const panic = async (): Promise<void> => {
    if (!confirm(t('panicConfirm'))) return
    const response = await send<{ detached: number }>({ type: 'panic' })
    setPanicResult(response.ok ? t('panicDone', { n: response.result.detached }) : response.error.message)
  }
  const { totals } = state
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-4 gap-1.5 text-center">
        {[
          [t('totalsLlm'), totals.llmRequests],
          [t('totalsMcp'), totals.mcpCalls],
          [t('totalsErrors'), totals.errors],
          [t('totalsSaved'), totals.tokensSaved],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-ink-700 bg-ink-850 px-1 py-2">
            <p className="text-[15px] font-semibold">{Number(value).toLocaleString()}</p>
            <p className="text-[10.5px] text-ink-400">{label}</p>
          </div>
        ))}
      </div>
      <Button variant="danger" className="w-full" onClick={() => void panic()}>
        <Power size={14} /> {t('panic')}
      </Button>
      {panicResult !== null && <p className="text-center text-[12px] text-ink-200">{panicResult}</p>}
      <Card title={t('activity')}>
        {state.activity.length === 0 ? (
          <p className="text-[12px] text-ink-400">{t('noActivity')}</p>
        ) : (
          <ol className="grid max-h-[60vh] gap-1 overflow-auto" aria-live="polite">
            {state.activity.map((entry) => (
              <li key={entry.id} className="grid grid-cols-[58px_18px_1fr] gap-x-1.5 rounded-md bg-ink-900 px-2 py-1 text-[11.5px]">
                <time className="font-mono text-ink-500">{new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time>
                <span aria-hidden="true">{KIND_ICON[entry.kind] ?? '•'}</span>
                <span className={entry.status === 'error' ? 'text-red-300' : 'text-ink-50'}>
                  {entry.status === 'running' ? '… ' : entry.status === 'error' ? '✗ ' : '✓ '}
                  {entry.title}
                  <span className="text-ink-500">
                    {entry.durationMs !== undefined ? ` · ${entry.durationMs} ms` : ''}
                    {entry.tokensSaved !== undefined ? ` · −${t('tokensShort', { n: entry.tokensSaved.toLocaleString() })}` : ''}
                    {entry.model !== undefined ? ` · ${entry.model}` : ''}
                  </span>
                </span>
                {entry.detail !== undefined && <span className="col-span-3 break-words text-[11px] text-ink-400">{entry.detail}</span>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}
