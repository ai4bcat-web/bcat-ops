/**
 * The one card shell every top card on the Operations Dashboard is built from (Ryne 2026-11-16: "make the UI for the
 * dashboard as clean as possible"): same padding, radius, label + icon header, headline figure, quiet delta chip and
 * compact breakdown rows. Amounts use tabular numerals and never shrink; labels truncate instead.
 */
import type { CSSProperties, ReactNode } from 'react'

const NUM: CSSProperties = { fontVariantNumeric: 'tabular-nums' }

export function DashCard({ label, icon, hint, onOpen, testId, ariaBusy, children }: {
  label: string
  icon: ReactNode
  hint?: string
  onOpen?: () => void
  testId?: string
  ariaBusy?: boolean
  children: ReactNode
}) {
  const interactive = onOpen
    ? {
        onClick: onOpen, role: 'button' as const, tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) onOpen() },
      }
    : {}
  return (
    <div
      className="tms-card dash-card"
      data-testid={testId}
      aria-busy={ariaBusy || undefined}
      {...interactive}
      style={{ minWidth: 0, height: '100%', boxSizing: 'border-box', overflow: 'hidden', cursor: onOpen ? 'pointer' : undefined }}
    >
      <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, height: '100%', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div title={hint} style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)', lineHeight: 1.25 }}>
            {label}
          </div>
          <div style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tms-text-2)' }}>
            {icon}
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

/** The headline figure with an optional delta chip and a one-line caption under it. */
export function Headline({ value, delta, deltaDir = 'neutral', caption }: {
  value: ReactNode
  delta?: string
  deltaDir?: 'up' | 'down' | 'neutral'
  caption?: string
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1, color: 'var(--tms-text)', whiteSpace: 'nowrap', ...NUM }}>{value}</span>
        {delta && <DeltaChip delta={delta} dir={deltaDir} />}
      </div>
      {caption && <div style={{ fontSize: 12.5, color: 'var(--tms-muted)', marginTop: 3 }}>{caption}</div>}
    </div>
  )
}

export function DeltaChip({ delta, dir }: { delta: string; dir: 'up' | 'down' | 'neutral' }) {
  const color = dir === 'up' ? 'var(--tms-badge-green)' : dir === 'down' ? 'var(--tms-badge-red)' : 'var(--tms-text-2)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 600, color, whiteSpace: 'nowrap', padding: '1px 7px', borderRadius: 999, background: 'var(--tms-bg)', ...NUM }}>
      {dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''} {delta}
    </span>
  )
}

/** One breakdown row: coloured dot, label (wraps rather than clips), optional count, right-aligned value that never clips. */
export function DashRow({ color, label, count, value }: { color: string; label: string; count?: number | null; value: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, minWidth: 0 }}>
      <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, lineHeight: 1.35, color: 'var(--tms-text-2)', minWidth: 0 }}>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 6 }} />
        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{label}</span>
        {count != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--tms-muted)', flexShrink: 0 }}>{count}</span>}
      </span>
      <span style={{ fontSize: 13, lineHeight: 1.3, fontWeight: 600, color: 'var(--tms-text)', flexShrink: 0, textAlign: 'right', whiteSpace: 'nowrap', ...NUM }}>{value}</span>
    </div>
  )
}

export function DashRows({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 'auto' }}>{children}</div>
}

/** The shape of a split at a glance. */
export function SplitBar({ parts }: { parts: { key: string; value: number; color: string; title: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0)
  if (total <= 0) return null
  return (
    <div style={{ display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', background: 'var(--tms-bg)' }}>
      {parts.filter((p) => p.value > 0).map((p) => (
        <div key={p.key} title={p.title} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
      ))}
    </div>
  )
}
