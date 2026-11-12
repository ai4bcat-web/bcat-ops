/** The compact Invoicing summary above the tabs; a division chip filters the list. */
import { formatCents } from '@/lib/invoiceBuild'
import { PAY_WINDOW_DAYS, type ArSummary } from './arSummary'

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <span className="flex items-baseline gap-1 whitespace-nowrap">
      <strong style={tone === 'bad' ? { color: 'var(--tms-badge-red)' } : undefined}>{value}</strong>
      <span className="text-[11px] uppercase tracking-wider tms-muted">{label}</span>
      {sub && <span className="text-[11px] tms-muted">({sub})</span>}
    </span>
  )
}

export function ArSummaryStrip({ summary, division, onDivision }: {
  summary: ArSummary
  division: string | null
  onDivision: (key: string | null) => void
}) {
  const days = (d: number | null) => (d == null ? '—' : `${d}d`)
  return (
    <div className="flex flex-col gap-1 text-sm" aria-label="AR summary" data-testid="ar-summary">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <Stat label="Pending with OTR" value={formatCents(summary.pendingOtrCents)} />
        <Stat label="Pending with shippers" value={formatCents(summary.pendingShippersCents)} />
        <Stat label="Late" value={formatCents(summary.lateCents)} tone={summary.lateCents > 0 ? 'bad' : undefined} />
        <Stat label="Days to pay · OTR" value={days(summary.otrDaysToPay)} sub={`submitted → funded, last ${PAY_WINDOW_DAYS} days`} />
        <Stat label="Days to pay · shippers" value={days(summary.shipperDaysToPay)} sub={`invoice → paid, last ${PAY_WINDOW_DAYS} days`} />
      </div>
      {summary.byDivision.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" aria-label="Open AR by division">
          <span className="text-[11px] uppercase tracking-wider tms-muted">Open AR</span>
          {summary.byDivision.map((slice) => (
            <button
              key={slice.key}
              type="button"
              className={`tms-chip ${division === slice.key ? 'tms-chip-active' : ''}`}
              aria-pressed={division === slice.key}
              onClick={() => onDivision(division === slice.key ? null : slice.key)}
            >
              {slice.label} {formatCents(slice.cents)}
            </button>
          ))}
          {division && <button type="button" className="tms-chip" onClick={() => onDivision(null)}>Clear</button>}
        </div>
      )}
    </div>
  )
}
