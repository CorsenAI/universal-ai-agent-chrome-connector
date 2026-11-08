import { Brain, Copy, Eye, EyeOff, Lock, Wrench } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { TabRole } from '@corsen-ai/shared'
import type { LinkStatus } from '../background/daemon-link'
import { t } from './i18n'
import { copyText } from './use-extension'

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function Logo({ size = 22 }: { size?: number }) {
  return <img src="icons/icon-48.png" width={size} height={size} alt="" className="rounded-md" />
}

const STATUS_TONE: Record<LinkStatus, 'ok' | 'warn' | 'bad'> = {
  connected: 'ok',
  connecting: 'warn',
  offline: 'bad',
  unpaired: 'warn',
  denied: 'bad',
  superseded: 'warn',
  version: 'bad',
}

export function statusLabel(status: LinkStatus): string {
  return {
    connected: t('statusConnected'),
    connecting: t('statusConnecting'),
    offline: t('statusOffline'),
    unpaired: t('statusUnpaired'),
    denied: t('statusDenied'),
    superseded: t('statusSuperseded'),
    version: t('statusVersion'),
  }[status]
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? 'bg-ok shadow-[0_0_8px_var(--color-ok)]' : tone === 'warn' ? 'bg-warn shadow-[0_0_8px_var(--color-warn)]' : 'bg-bad shadow-[0_0_8px_var(--color-bad)]'
  return <span aria-hidden="true" className={cx('inline-block h-2 w-2 shrink-0 rounded-full', color)} />
}

export function StatusPill({ label, tone, title }: { label: string; tone: 'ok' | 'warn' | 'bad'; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 px-2.5 py-1 text-[11.5px]">
      <Dot tone={tone} />
      {label}
    </span>
  )
}

export function linkTone(status: LinkStatus): 'ok' | 'warn' | 'bad' {
  return STATUS_TONE[status]
}

export function Card({ title, icon, children, actions }: { title?: string; icon?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-ink-700 bg-ink-850 p-3">
      {(title !== undefined || actions !== undefined) && (
        <header className="mb-2 flex items-center justify-between gap-2">
          {title !== undefined && (
            <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
              {icon}
              {title}
            </h2>
          )}
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}

type Variant = 'primary' | 'ghost' | 'danger'

export function Button({ children, onClick, variant = 'ghost', disabled, title, className }: { children: ReactNode; onClick?: () => void; variant?: Variant; disabled?: boolean; title?: string; className?: string }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-gradient-to-br from-brand to-violet-700 text-white border-transparent font-semibold hover:brightness-110',
    ghost: 'bg-ink-900 border-ink-700 hover:border-brand text-ink-50',
    danger: 'bg-[#2a1015] border-[#5b1d26] text-red-200 hover:brightness-125 font-semibold',
  }
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] transition disabled:cursor-not-allowed disabled:opacity-50', styles[variant], className)}>
      {children}
    </button>
  )
}

export function CopyField({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret)
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-1">
      <span className="text-[11px] text-ink-400">{label}</span>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-md border border-ink-700 bg-ink-900 px-2 py-1">{shown ? value : '••••••••••••'}</code>
        {secret && (
          <button type="button" className="rounded-md p-1 text-ink-400 hover:text-ink-50" title={shown ? t('hide') : t('show')} onClick={() => setShown(!shown)}>
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
        <button
          type="button"
          className="rounded-md p-1 text-ink-400 hover:text-ink-50"
          title={copied ? t('copied') : t('copy')}
          onClick={() => {
            void copyText(value).then((ok) => {
              setCopied(ok)
              setTimeout(() => setCopied(false), 1200)
            })
          }}
        >
          <Copy size={14} />
        </button>
      </div>
    </div>
  )
}

const ROLE_META: Record<TabRole, { icon: ReactNode; label: () => string; active: string }> = {
  ignored: { icon: <Lock size={13} />, label: () => t('roleIgnored'), active: 'bg-ink-700 text-ink-50' },
  brain: { icon: <Brain size={13} />, label: () => t('roleBrain'), active: 'bg-brand text-white' },
  mcp: { icon: <Wrench size={13} />, label: () => t('roleMcp'), active: 'bg-brand-2 text-ink-950' },
}

export function RoleSwitch({ role, onChange, brainDisabled, disabled, brainHint }: { role: TabRole; onChange: (role: TabRole) => void; brainDisabled: boolean; disabled: boolean; brainHint?: string }) {
  return (
    <div role="radiogroup" className="inline-flex shrink-0 overflow-hidden rounded-lg border border-ink-700">
      {(['ignored', 'brain', 'mcp'] as const).map((value) => {
        const meta = ROLE_META[value]
        const isDisabled = disabled || (value === 'brain' && brainDisabled)
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={role === value}
            disabled={isDisabled}
            title={value === 'brain' && brainDisabled ? brainHint : meta.label()}
            onClick={() => onChange(value)}
            className={cx('inline-flex items-center gap-1 px-2 py-1 text-[11.5px] transition disabled:cursor-not-allowed disabled:opacity-40', role === value ? meta.active : 'bg-ink-900 text-ink-400 hover:text-ink-50')}
          >
            {meta.icon}
            {meta.label()}
          </button>
        )
      })}
    </div>
  )
}

export function ErrorNote({ message }: { message: string | null }) {
  if (message === null || message === '') return null
  return (
    <p role="alert" className="mt-2 rounded-lg border border-[#5b1d26] bg-[#2a1015] px-2 py-1.5 text-[12px] text-red-200">
      {message}
    </p>
  )
}
