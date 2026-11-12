/**
 * The compact totals above the Payables tabs, shown on every tab: what is open and where it sits on
 * the ladder, what is late and due this week (opens the cash-requirements report), who it is paid to,
 * quick pay this month, how fast we pay, and open AP by revenue division (each one a filter).
 */
import { formatCents } from '@/lib/invoiceBuild'
import type { ApSummary } from '../apQueue'

const money = (m: { count: number; cents: number }) => `${formatCents(m.cents)} · ${m.count}`

function Cell({ label, value, sub, tone, onClick, active }: {
  label: string
  value: string
  sub?: string
  tone?: 'bad' | 'warn'
  onClick?: () => void
  active?: boolean
}) {
  const body = (
    <>
      <span className="tms-dg-kpi-value">{value}</span>
      <span className="tms-dg-kpi-label">{label}{sub ? <span className="tms-muted"> · {sub}</span> : null}</span>
    </>
  )
  const cls = `tms-dg-kpi${tone ? ` tms-dg-kpi-${tone}` : ''}`
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} aria-pressed={active} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }}>
      {body}
    </button>
  ) : <div className={cls}>{body}</div>
}

export function ApSummaryStrip({ summary, divisionName, division, onDivision, onCashRequirements, onTab }: {
  summary: ApSummary
  divisionName: (code: string | null) => string
  /** The active division filter key, or null. */
  division: string | null
  onDivision: (key: string | null) => void
  onCashRequirements: () => void
  onTab: (tab: 'expected' | 'aging' | 'selected') => void
}) {
  const s = summary
  const days = (n: number | null) => (n == null ? '—' : `${n} days`)
  return (
    <section aria-label="Payables totals" className="mb-2 flex flex-col gap-1">
      <div className="tms-dg-kpis" role="region" aria-label="Open payables">
        <Cell label="Open AP" value={money(s.open)} />
        <Cell label="Expected" sub="needs invoice date" value={money(s.expected)} tone={s.expected.count ? 'warn' : undefined} onClick={() => onTab('expected')} />
        <Cell label="Aging" value={money(s.aging)} onClick={() => onTab('aging')} />
        <Cell label="Selected" sub="next payment run" value={money(s.selected)} onClick={() => onTab('selected')} />
        <Cell label="Past due" value={money(s.pastDue)} tone={s.pastDue.cents > 0 ? 'bad' : undefined} onClick={onCashRequirements} />
        <Cell label="Due next 7 days" value={money(s.dueNext7)} onClick={onCashRequirements} />
        <Cell label="Pay to factor" value={money(s.payToFactor)} />
        <Cell label="Pay direct" value={money(s.payDirect)} />
        <Cell
          label="Quick pay this month"
          value={`${s.quickPay.count} · ${formatCents(s.quickPay.feeCents)} fees`}
          sub={`6%: ${formatCents(s.quickPay.fee6Cents)} · 3%: ${formatCents(s.quickPay.fee3Cents)}`}
        />
        <Cell label="Avg days to pay carriers" sub={`invoice → paid, last 90 days${s.avgDaysToPayCount ? `, ${s.avgDaysToPayCount} bills` : ''}`} value={days(s.avgDaysToPay)} />
        <Cell label="Avg days delivery → carrier invoice" sub={s.avgDaysToInvoiceCount ? `${s.avgDaysToInvoiceCount} bills` : undefined} value={days(s.avgDaysToInvoice)} />
      </div>
      {s.byDivision.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label="Open AP by revenue division">
          <span className="tms-muted">Open AP by division:</span>
          <button type="button" className={`tms-btn tms-btn-sm ${division == null ? 'tms-btn-primary' : 'tms-btn-ghost'}`} aria-pressed={division == null} onClick={() => onDivision(null)}>All</button>
          {s.byDivision.map((d) => (
            <button
              key={d.key}
              type="button"
              aria-pressed={division === d.key}
              className={`tms-btn tms-btn-sm ${division === d.key ? 'tms-btn-primary' : 'tms-btn-ghost'}`}
              onClick={() => onDivision(division === d.key ? null : d.key)}
            >
              {d.subdivision ? `↳ ${divisionName(d.subdivision)}` : divisionName(d.division)} {formatCents(d.cents)} · {d.count}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
