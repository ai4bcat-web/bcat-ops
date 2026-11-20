import { useMemo, useState } from 'react'
import { Truck } from 'lucide-react'
import { useProfitReview } from '@/hooks/useProfitReview'
import { buildCostShare, donutSlices, SHARE_KEYS, type CostShareRow, type ShareKey } from '@/lib/localFleetCostShare'
import { DashCard } from './DashCard'

const MONTHS_BACK = 6
const LABELS: Record<ShareKey, string> = { fuel: 'Fuel', driverPay: 'Driver pay', maintenance: 'Maintenance' }
const COLORS: Record<ShareKey | 'leftover', string> = { fuel: 'var(--tms-chart-4)', driverPay: 'var(--tms-chart-6)', maintenance: 'var(--tms-chart-7)', leftover: 'var(--tms-chart-9)' }
const NO_COSTS_RING = 'var(--tms-chart-9)'
const SLICE_TEXT = 'var(--tms-chart-label)'

/** Donut geometry in a 120 x 120 box: a ring of this radius and thickness, so it scales with its cell. */
const CX = 60
const RADIUS = 42
const THICKNESS = 20
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
/** A slice must take at least this share of the ring to carry its percent. */
const MIN_LABEL_FRACTION = 0.09

const money0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const pctText = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}%`)
const pctWhole = (n: number | null) => (n == null ? '' : `${Math.round(n)}%`)

function describe(r: CostShareRow): string {
  if (r.noCosts) return `${r.month}${r.partial ? ' to date' : ''}: ${money0(r.revenue)} revenue, costs not on file`
  const parts = SHARE_KEYS.map((k) => `${LABELS[k]} ${pctText(r.pct[k])}`).join(', ')
  return `${r.month}${r.partial ? ' to date' : ''}: ${money0(r.revenue)} revenue. ${parts}. ${r.overRevenue ? 'Costs are over revenue' : `Left over ${pctText(r.leftoverPct)}`}.`
}

/** One month's ring: the three controllable costs and what is left, drawn to scale around the month and its revenue. */
function MonthDonut({ row }: { row: CostShareRow }) {
  const slices = donutSlices(row)
  const opacity = row.partial ? 0.6 : 1
  let start = 0
  const arcs = slices.map((s) => {
    const arc = { ...s, start }
    start += s.fraction
    return arc
  })
  return (
    <svg viewBox="0 0 120 120" role="img" aria-label={describe(row)} style={{ width: '100%', maxWidth: 150, height: 'auto', display: 'block', margin: '0 auto' }}>
      {slices.length === 0 ? (
        <circle cx={CX} cy={CX} r={RADIUS} fill="none" stroke={NO_COSTS_RING} strokeOpacity={0.45} strokeWidth={THICKNESS} />
      ) : (
        arcs.map((a) => {
          const mid = (a.start + a.fraction / 2) * 2 * Math.PI - Math.PI / 2
          const showLabel = a.fraction >= MIN_LABEL_FRACTION
          const pct = a.key === 'leftover' ? row.leftoverPct : row.pct[a.key]
          return (
            <g key={a.key}>
              <circle
                cx={CX} cy={CX} r={RADIUS} fill="none" stroke={COLORS[a.key]} strokeWidth={THICKNESS}
                strokeOpacity={a.key === 'leftover' ? opacity * 0.75 : opacity}
                strokeDasharray={`${a.fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`} strokeDashoffset={-a.start * CIRCUMFERENCE}
                transform={`rotate(-90 ${CX} ${CX})`}
              />
              {showLabel && (
                <text x={CX + RADIUS * Math.cos(mid)} y={CX + RADIUS * Math.sin(mid)} textAnchor="middle" dominantBaseline="central" fontSize={9.5} fontWeight={700} fill={SLICE_TEXT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>
                  {row.overRevenue ? `${Math.round(a.fraction * 100)}%` : pctWhole(pct)}
                </text>
              )}
            </g>
          )
        })
      )}
      <text x={CX} y={CX - 4} textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--tms-text)">{row.month}</text>
      <text x={CX} y={CX + 11} textAnchor="middle" fontSize={10.5} fill="var(--tms-text)" style={{ fontVariantNumeric: 'tabular-nums' }}>{money0(row.revenue)}</text>
    </svg>
  )
}

function MonthTooltip({ row }: { row: CostShareRow }) {
  return (
    <div role="tooltip" style={{ position: 'absolute', zIndex: 5, top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 2, background: 'var(--tms-card)', color: 'var(--tms-text)', border: '1px solid var(--tms-border)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--tms-shadow-pop)', padding: '8px 10px', minWidth: 214, textAlign: 'left' }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{row.month}{row.partial ? ' (to date)' : ''} · {money0(row.revenue)} revenue</div>
      {row.noCosts ? (
        <div style={{ color: 'var(--tms-muted)' }}>Costs were not on file this month.</div>
      ) : (
        <>
          {SHARE_KEYS.map((k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[k], flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{LABELS[k]}</span>
              <span style={{ fontWeight: 600 }}>{pctText(row.pct[k])}</span>
              <span style={{ color: 'var(--tms-muted)', minWidth: 64, textAlign: 'right' }}>{money0(row[k])}</span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums', marginTop: 3, paddingTop: 3, borderTop: '1px solid var(--tms-border)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.leftover, flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{row.overRevenue ? 'Over revenue by' : 'Left over'}</span>
            <span style={{ fontWeight: 600 }}>{pctText(row.overRevenue && row.leftoverPct != null ? -row.leftoverPct : row.leftoverPct)}</span>
            <span style={{ color: 'var(--tms-muted)', minWidth: 64, textAlign: 'right' }}>{money0(Math.abs(row.revenue - row.controllable))}</span>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Our local drivers (the Ivan local fleet plus the box truck, same scope as the Profit Review and the Finances P&L):
 * one donut per month showing how much of that month's revenue went to the costs we control (fuel, driver pay and
 * maintenance) and how much is left. Months with no costs on file show a plain grey ring. Internal money, so it sits
 * behind the same accounting access as the receivable and payable cards.
 */
export function LocalFleetCostShareCard() {
  const { months, loading } = useProfitReview(MONTHS_BACK)
  const rows = useMemo(() => buildCostShare(months), [months])
  const [open, setOpen] = useState<string | null>(null)
  const hasData = rows.some((r) => r.revenue > 0)
  const latest = [...rows].reverse().find((r) => r.revenue > 0 && !r.noCosts)
  const flagged = rows.filter((r) => r.lowEntry.length > 0)

  return (
    <DashCard label="Local drivers · revenue and cost share" icon={<Truck size={15} />} hint="One ring per month of local fleet revenue: fuel, driver pay and maintenance, and what is left" testId="local-fleet-cost-share" ariaBusy={loading && !hasData}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 11.5, color: 'var(--tms-muted)', alignItems: 'center' }}>
        {SHARE_KEYS.map((k) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: COLORS[k] }} />
            {LABELS[k]}{latest ? <b style={{ color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{pctText(latest.pct[k])}</b> : null}
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: COLORS.leftover }} />
          Left over{latest ? <b style={{ color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{pctText(latest.leftoverPct)}</b> : null}
        </span>
        {latest ? <span>· percents are {latest.month}, % of revenue</span> : null}
      </div>
      {loading && !hasData ? (
        <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--tms-muted)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))', gap: '14px 10px' }}>
          {rows.map((r) => (
            <div
              key={r.key} data-testid={`fleet-donut-${r.key}`} tabIndex={0}
              onMouseEnter={() => setOpen(r.key)} onMouseLeave={() => setOpen((k) => (k === r.key ? null : k))}
              onFocus={() => setOpen(r.key)} onBlur={() => setOpen((k) => (k === r.key ? null : k))}
              style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, outlineOffset: 2 }}
            >
              <MonthDonut row={r} />
              <div style={{ textAlign: 'center', fontSize: 11.5, lineHeight: 1.35, fontVariantNumeric: 'tabular-nums' }}>
                {r.noCosts ? (
                  <span style={{ color: 'var(--tms-muted)' }}>costs not on file</span>
                ) : r.overRevenue ? (
                  <span style={{ color: 'var(--tms-badge-orange)', fontWeight: 600 }}>Over revenue · costs {pctWhole(r.controllablePct)}</span>
                ) : (
                  <span><b style={{ color: 'var(--tms-text)' }}>{pctWhole(r.controllablePct)}</b> <span style={{ color: 'var(--tms-muted)' }}>on fuel, driver pay, maintenance</span></span>
                )}
                {r.partial ? <div style={{ color: 'var(--tms-muted)' }}>to date</div> : null}
              </div>
              {open === r.key ? <MonthTooltip row={r} /> : null}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--tms-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div>Each ring is the month's revenue. Left over is what remains after fuel, driver pay and maintenance, before other costs.</div>
        {rows.some((r) => r.partial) && <div>The current month is to date and drawn lighter.</div>}
        {rows.some((r) => r.noCosts && r.revenue > 0) && <div>Earlier months show a grey ring: costs were not on file.</div>}
        {flagged.map((r) => (
          <div key={r.key} style={{ color: 'var(--tms-badge-orange)' }}>
            {r.month}: {r.lowEntry.map((k) => LABELS[k].toLowerCase()).join(' and ')} looks incomplete, so its share reads low and the profit looks better than it is.
          </div>
        ))}
      </div>
    </DashCard>
  )
}
