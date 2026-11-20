import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Truck } from 'lucide-react'
import { useProfitReview } from '@/hooks/useProfitReview'
import { buildCostShare, pieSlices, SHARE_KEYS, type CostShareRow, type ShareKey } from '@/lib/localFleetCostShare'
import { DashCard } from './DashCard'

const MONTHS_BACK = 6
const LABELS: Record<ShareKey, string> = { fuel: 'Fuel', driverPay: 'Driver pay', maintenance: 'Maintenance' }
const COLORS: Record<ShareKey | 'leftover', string> = { fuel: 'var(--tms-chart-4)', driverPay: 'var(--tms-chart-6)', maintenance: 'var(--tms-chart-7)', leftover: 'var(--tms-chart-profit)' }
const NO_COSTS_RING = 'var(--tms-chart-9)'
const SLICE_TEXT = 'var(--tms-chart-label)'

/** Pie geometry in a 120 x 120 box: one filled circle, so it scales with its cell. */
const CX = 60
const RADIUS = 56
/** Where a slice's percent sits, as a share of the radius from the centre. */
const LABEL_RADIUS = 0.64
/** A slice must take at least this share of the pie to carry its percent. */
const MIN_LABEL_FRACTION = 0.09

const money0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const pctText = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}%`)
const pctWhole = (n: number | null) => (n == null ? '' : `${Math.round(n)}%`)

function describe(r: CostShareRow): string {
  if (r.noCosts) return `${r.month}${r.partial ? ' to date' : ''}: ${money0(r.revenue)} revenue, costs not on file`
  const parts = SHARE_KEYS.map((k) => `${LABELS[k]} ${pctText(r.pct[k])}`).join(', ')
  return `${r.month}${r.partial ? ' to date' : ''}: ${money0(r.revenue)} revenue. ${parts}. ${r.overRevenue ? 'Costs are over revenue' : `Profit ${pctText(r.leftoverPct)}`}.`
}

/** SVG path for one pie slice from angle a0 to a1 (turns, 0 at 12 o'clock, clockwise). */
function slicePath(a0: number, a1: number): string {
  const pt = (t: number) => [CX + RADIUS * Math.sin(t * 2 * Math.PI), CX - RADIUS * Math.cos(t * 2 * Math.PI)]
  const [x0, y0] = pt(a0)
  const [x1, y1] = pt(a1)
  return `M ${CX} ${CX} L ${x0.toFixed(3)} ${y0.toFixed(3)} A ${RADIUS} ${RADIUS} 0 ${a1 - a0 > 0.5 ? 1 : 0} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`
}

/** One month's pie: the three controllable costs and the profit left, drawn to scale. */
function MonthPie({ row }: { row: CostShareRow }) {
  const slices = pieSlices(row)
  const opacity = row.partial ? 0.78 : 1
  let start = 0
  const arcs = slices.map((s) => {
    const arc = { ...s, start }
    start += s.fraction
    return arc
  })
  return (
    <svg viewBox="0 0 120 120" role="img" aria-label={describe(row)} style={{ width: '100%', maxWidth: 150, height: 'auto', display: 'block', margin: '0 auto' }}>
      {slices.length === 0 ? (
        <circle cx={CX} cy={CX} r={RADIUS} fill={NO_COSTS_RING} fillOpacity={0.45} />
      ) : (
        arcs.map((a) => {
          const mid = (a.start + a.fraction / 2) * 2 * Math.PI
          const showLabel = a.fraction >= MIN_LABEL_FRACTION
          const pct = a.key === 'leftover' ? row.leftoverPct : row.pct[a.key]
          const fillOpacity = opacity
          return (
            <g key={a.key}>
              {a.fraction >= 0.9999 ? (
                <circle cx={CX} cy={CX} r={RADIUS} fill={COLORS[a.key]} fillOpacity={fillOpacity} stroke="var(--tms-card)" strokeWidth={1.5} />
              ) : (
                <path d={slicePath(a.start, a.start + a.fraction)} fill={COLORS[a.key]} fillOpacity={fillOpacity} stroke="var(--tms-card)" strokeWidth={1.5} strokeLinejoin="round" />
              )}
              {showLabel && (
                <text x={CX + RADIUS * LABEL_RADIUS * Math.sin(mid)} y={CX - RADIUS * LABEL_RADIUS * Math.cos(mid)} textAnchor="middle" dominantBaseline="central" fontSize={10.5} fontWeight={700} fill={SLICE_TEXT} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>
                  {row.overRevenue ? `${Math.round(a.fraction * 100)}%` : pctWhole(pct)}
                </text>
              )}
            </g>
          )
        })
      )}
    </svg>
  )
}

const TIP_WIDTH = 230
const TIP_GAP = 6
const VIEWPORT_PAD = 8

/**
 * The hover/tap details for one month. Drawn in a portal with fixed positioning so the card never clips it: it opens
 * below the pie when there is room, flips above when there is not, and is clamped inside the viewport sideways.
 */
function MonthTooltip({ row, anchor }: { row: CostShareRow; anchor: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const tip = ref.current
      if (!tip) return
      const r = anchor.getBoundingClientRect()
      const h = tip.offsetHeight
      const w = tip.offsetWidth || TIP_WIDTH
      const below = r.bottom + TIP_GAP
      const above = r.top - TIP_GAP - h
      const fitsBelow = below + h + VIEWPORT_PAD <= window.innerHeight
      const top = fitsBelow || above < VIEWPORT_PAD ? Math.max(VIEWPORT_PAD, Math.min(below, window.innerHeight - h - VIEWPORT_PAD)) : above
      const left = Math.max(VIEWPORT_PAD, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - VIEWPORT_PAD))
      setPos({ top, left })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchor, row])
  const profit = row.overRevenue ? { label: 'Over revenue by', pct: row.leftoverPct == null ? null : -row.leftoverPct } : { label: 'Profit', pct: row.leftoverPct }
  return createPortal(
    <div
      ref={ref} role="tooltip" className="tms-portal"
      style={{ position: 'fixed', zIndex: 10000, top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden', width: TIP_WIDTH, maxWidth: `calc(100vw - ${VIEWPORT_PAD * 2}px)`, background: 'var(--tms-card)', color: 'var(--tms-text)', border: '1px solid var(--tms-border)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--tms-shadow-pop)', padding: '8px 10px', textAlign: 'left', pointerEvents: 'none' }}
    >
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
            <span style={{ flex: 1 }}>{profit.label}</span>
            <span style={{ fontWeight: 600 }}>{pctText(profit.pct)}</span>
            <span style={{ color: 'var(--tms-muted)', minWidth: 64, textAlign: 'right' }}>{money0(Math.abs(row.revenue - row.controllable))}</span>
          </div>
          <div style={{ color: 'var(--tms-muted)', marginTop: 4 }}>Profit is before other costs.</div>
        </>
      )}
    </div>,
    document.body,
  )
}

/**
 * Our local drivers (the Ivan local fleet plus the box truck, same scope as the Profit Review and the Finances P&L):
 * one pie per month showing how much of that month's revenue went to the costs we control (fuel, driver pay and
 * maintenance) and how much is left as profit. Months with no costs on file show a plain grey pie. Internal money, so it sits
 * behind the same accounting access as the receivable and payable cards.
 */
export function LocalFleetCostShareCard() {
  const { months, loading } = useProfitReview(MONTHS_BACK)
  const rows = useMemo(() => buildCostShare(months), [months])
  const [open, setOpen] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const show = (key: string, el: HTMLElement) => { setOpen(key); setAnchor(el) }
  const hide = (key: string) => setOpen((k) => (k === key ? null : k))
  const openRow = rows.find((r) => r.key === open)
  const hasData = rows.some((r) => r.revenue > 0)
  const latest = [...rows].reverse().find((r) => r.revenue > 0 && !r.noCosts)
  const flagged = rows.filter((r) => r.lowEntry.length > 0)

  return (
    <DashCard label="Local drivers · revenue and cost share" icon={<Truck size={15} />} hint="One pie per month of local fleet revenue: fuel, driver pay and maintenance, and the profit left" testId="local-fleet-cost-share" ariaBusy={loading && !hasData}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 11.5, color: 'var(--tms-muted)', alignItems: 'center' }}>
        {SHARE_KEYS.map((k) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: COLORS[k] }} />
            {LABELS[k]}{latest ? <b style={{ color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{pctText(latest.pct[k])}</b> : null}
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: COLORS.leftover }} />
          Profit (before other costs){latest ? <b style={{ color: 'var(--tms-text)', fontVariantNumeric: 'tabular-nums' }}>{pctText(latest.leftoverPct)}</b> : null}
        </span>
        {latest ? <span>· percents are {latest.month}, % of revenue</span> : null}
      </div>
      {loading && !hasData ? (
        <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--tms-muted)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))', gap: '14px 10px' }}>
          {rows.map((r) => (
            <div
              key={r.key} data-testid={`fleet-pie-${r.key}`} tabIndex={0}
              onMouseEnter={(e) => show(r.key, e.currentTarget)} onMouseLeave={() => hide(r.key)}
              onFocus={(e) => show(r.key, e.currentTarget)} onBlur={() => hide(r.key)}
              onClick={(e) => show(r.key, e.currentTarget)}
              style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, outlineOffset: 2, cursor: 'default' }}
            >
              <div style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums', lineHeight: 1.25 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--tms-text)' }}>{r.month}</div>
                <div style={{ fontSize: 11.5, color: 'var(--tms-text)' }}>{money0(r.revenue)}</div>
              </div>
              <MonthPie row={r} />
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
            </div>
          ))}
        </div>
      )}
      {openRow && anchor ? <MonthTooltip row={openRow} anchor={anchor} /> : null}
      <div style={{ fontSize: 11.5, color: 'var(--tms-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div>Each pie is the month's revenue. Profit is what remains after fuel, driver pay and maintenance, before other costs.</div>
        {rows.some((r) => r.partial) && <div>The current month is to date and drawn lighter.</div>}
        {rows.some((r) => r.noCosts && r.revenue > 0) && <div>Earlier months show a grey pie: costs were not on file.</div>}
        {flagged.map((r) => (
          <div key={r.key} style={{ color: 'var(--tms-badge-orange)' }}>
            {r.month}: {r.lowEntry.map((k) => LABELS[k].toLowerCase()).join(' and ')} looks incomplete, so its share reads low and the profit looks better than it is.
          </div>
        ))}
      </div>
    </DashCard>
  )
}
