/**
 * The dashboard's high-level money card: a label with an icon, one big figure, and a short
 * list of coloured-dot rows, each a label, a count and an amount. It is the old Factoring card's
 * look, lifted out so Accounts receivable and Accounts payable read the same way (Ryne 2026-11-15:
 * "only show high level details… kind of like how the factoring is shown").
 *
 * The card opens its page; a row opens its own tab on that page.
 */
import type { ReactNode } from 'react'

export interface DashboardSummaryRow {
  key: string
  label: string
  count: number | null
  /** Cents; null while unknown. */
  cents: number | null
  color: string
  title?: string
  onOpen?: () => void
  /** Shown instead of a dollar amount (e.g. "3.2 d"). */
  valueText?: string
}

export interface DashboardSummaryGroup {
  key: string
  label: string
  rows: DashboardSummaryRow[]
}

function cents(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n / 100)
}

function Row({ row }: { row: DashboardSummaryRow }) {
  const inner = (
    <>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tms-text-2)', minWidth: 0 }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: row.color, flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</span>
        {row.count != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tms-muted)' }}>{row.count}</span>}
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {row.valueText ?? (row.cents == null ? '—' : cents(row.cents))}
      </span>
    </>
  )
  const style: React.CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }
  if (!row.onOpen) return <div style={style} title={row.title} data-testid={`summary-row-${row.key}`}>{inner}</div>
  const open = row.onOpen
  return (
    <button
      type="button"
      title={row.title}
      data-testid={`summary-row-${row.key}`}
      onClick={(e) => { e.stopPropagation(); open() }}
      style={{ ...style, width: '100%', padding: 0, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
    >
      {inner}
    </button>
  )
}

export function DashboardSummaryCard({ title, icon, headline, headlineText, sublabel, rows, groups = [], accent = 'var(--tms-primary)', note, onOpen, testId }: {
  title: string
  icon: ReactNode
  /** Cents; null while loading. */
  headline: number | null
  /** Shown instead of a dollar headline (e.g. "2.4 days"). */
  headlineText?: string
  sublabel: string
  rows: DashboardSummaryRow[]
  groups?: DashboardSummaryGroup[]
  accent?: string
  note?: ReactNode
  onOpen: () => void
  testId?: string
}) {
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) onOpen() }}
      className="tms-card"
      data-testid={testId}
      style={{ position: 'relative', cursor: 'pointer', minWidth: 0 }}
    >
      <div style={{ position: 'absolute', top: -40, right: -40, width: 140, height: 140, borderRadius: '50%',
        background: accent, filter: 'blur(60px)', opacity: 0.18, pointerEvents: 'none' }} />
      <div style={{ padding: '16px 18px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)' }}>
            {title}
          </div>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tms-text-2)' }}>
            {icon}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1,
            color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>
            {headlineText ?? (headline == null ? '—' : cents(headline))}
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginBottom: 12 }}>{sublabel}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => <Row key={r.key} row={r} />)}
        </div>

        {groups.map((g) => (
          <div key={g.key} style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)', marginBottom: 6 }}>
              {g.label}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {g.rows.map((r) => <Row key={r.key} row={r} />)}
            </div>
          </div>
        ))}

        {note && <div style={{ marginTop: 10, fontSize: 11, color: 'var(--tms-badge-orange)' }}>{note}</div>}
      </div>
    </div>
  )
}
