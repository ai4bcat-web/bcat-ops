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

import { DashCard, DashRow, Headline } from './DashCard'
import { dashCents } from './dashFormat'

function Row({ row }: { row: DashboardSummaryRow }) {
  const inner = <DashRow color={row.color} label={row.label} count={row.count} value={row.valueText ?? (row.cents == null ? '—' : dashCents(row.cents))} />
  if (!row.onOpen) return <div title={row.title} data-testid={`summary-row-${row.key}`}>{inner}</div>
  const open = row.onOpen
  return (
    <button
      type="button"
      title={row.title}
      data-testid={`summary-row-${row.key}`}
      onClick={(e) => { e.stopPropagation(); open() }}
      style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
    >
      {inner}
    </button>
  )
}

const GROUP_LABEL = { fontSize: 11.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)', marginBottom: 7 } as const

export function DashboardSummaryCard({ title, icon, headline, headlineText, sublabel, rows, groups = [], groupsBeside = false, extra, note, onOpen, testId }: {
  title: string
  icon: ReactNode
  /** Cents; null while loading. */
  headline: number | null
  /** Shown instead of a dollar headline (e.g. "2.4 days"). */
  headlineText?: string
  sublabel: string
  rows: DashboardSummaryRow[]
  groups?: DashboardSummaryGroup[]
  /** Lay the groups out in a column beside the main rows (a wide card) instead of under them. */
  groupsBeside?: boolean
  /** Anything else under the rows (e.g. a small chart). */
  extra?: ReactNode
  /** Kept for callers; the card no longer tints itself. */
  accent?: string
  note?: ReactNode
  onOpen: () => void
  testId?: string
}) {
  return (
    <DashCard label={title} icon={icon} onOpen={onOpen} testId={testId}>
      <Headline value={headlineText ?? (headline == null ? '—' : dashCents(headline))} caption={sublabel} />
      <div
        data-testid={testId ? `${testId}-body` : undefined}
        style={groupsBeside && groups.length > 0
          ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', columnGap: 32, rowGap: 14, alignItems: 'start' }
          : { display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
          {rows.map((r) => <Row key={r.key} row={r} />)}
        </div>
        {groups.map((g) => (
          <div key={g.key} style={{ minWidth: 0 }}>
            <div style={GROUP_LABEL}>{g.label}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {g.rows.map((r) => <Row key={r.key} row={r} />)}
            </div>
          </div>
        ))}
      </div>
      {extra}
      {note && <div style={{ fontSize: 11.5, color: 'var(--tms-badge-orange)' }}>{note}</div>}
    </DashCard>
  )
}
