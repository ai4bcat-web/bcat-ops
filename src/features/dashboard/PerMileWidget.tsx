import { useMemo, useState } from 'react'
import { Gauge, Table2, LineChart as LineChartIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { useFleetProfitability } from '@/hooks/useFleetProfitability'
import { monthRange, monthLabel } from '@/features/fleet-profitability/monthRange'
import { weekRange, weekLabel } from '@/features/fleet-profitability/weekRange'

const money2 = (n: number | null) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const money0 = (n: number | null) =>
  n == null || n === 0 ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

const miles0 = (n: number | null) =>
  n == null || n === 0 ? '—' : Math.round(n).toLocaleString('en-US')

const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100)

const navBtn = (disabled: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26,
  borderRadius: 6, border: 'none', background: 'transparent', padding: 0,
  cursor: disabled ? 'default' : 'pointer',
  color: disabled ? 'var(--ds-t3)' : 'var(--ds-t1)', opacity: disabled ? 0.4 : 1,
})

const COLORS = { rev: '#15803d', fuel: '#dc2626' }
// How many periods the trend graph plots, per period type.
const TREND_WINDOW = { week: 12, month: 6 } as const
const TH: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '9px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

/**
 * Per-truck efficiency for the Ivan (LOCAL) fleet — revenue per mile and fuel cost
 * per mile. Table view lists every active truck (incl. drivers without fuel cards)
 * plus a fleet-average row; graph view plots the fleet rev/mi & fuel/mi month over
 * month as lines so the trend is easy to compare.
 */
export function PerMileWidget() {
  const [view, setView] = useState<'table' | 'graph'>('table')
  const [period, setPeriod] = useState<'week' | 'month'>('month')
  const [offset, setOffset] = useState(0)   // 0 = current period, 1 = previous, …
  const range = period === 'week' ? weekRange(offset) : monthRange(offset)
  const rangeLabel = period === 'week' ? weekLabel(range) : monthLabel(range)
  const { data, loading, computeForRange } = useFleetProfitability(range, 'LOCAL')

  // Switching the period unit makes the offset ambiguous — jump back to current.
  const changePeriod = (p: 'week' | 'month') => { setPeriod(p); setOffset(0) }

  // Every truck with activity this period — revenue OR miles (keeps drivers like
  // Jason visible even while their mileage feed is still being reconciled).
  const trucks = (data?.trucks ?? []).filter((t) => t.miles > 0 || t.revenue > 0)
  const fleet = data?.rollup

  // Fleet history (oldest → newest) for the comparison line chart — a window of
  // TREND_WINDOW periods ending at the selected offset, period-aware.
  const trend = useMemo(() => {
    const count = TREND_WINDOW[period]
    const out: { label: string; revPerMile: number | null; fuelPerMile: number | null }[] = []
    for (let i = count - 1; i >= 0; i--) {
      const r = period === 'week' ? weekRange(i + offset) : monthRange(i + offset)
      const roll = computeForRange(r).rollup
      const d = new Date(`${r.start}T12:00:00`)
      out.push({
        label: period === 'week'
          ? d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
          : d.toLocaleDateString('en-US', { month: 'short' }),
        revPerMile: round2(roll.revenuePerMile),
        fuelPerMile: round2(roll.fuelPerMile),
      })
    }
    return out
  }, [computeForRange, period, offset])

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Gauge size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Revenue &amp; fuel per mile</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
              Ivan fleet · {view === 'table'
                ? `Per truck · ${rangeLabel}`
                : `${period === 'week' ? 'Weekly' : 'Monthly'} trend · last ${TREND_WINDOW[period]} ${period}s${offset > 0 ? ` through ${rangeLabel}` : ''}`}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* History navigation — step through previous periods */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {offset > 0 && (
              <button onClick={() => setOffset(0)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--ds-blue)', fontFamily: 'inherit', padding: '0 2px' }}>
                Now
              </button>
            )}
            <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
              <button onClick={() => setOffset((o) => o + 1)} aria-label="Previous period" style={navBtn(false)}>
                <ChevronLeft size={15} />
              </button>
              <button onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={offset === 0} aria-label="Next period" style={navBtn(offset === 0)}>
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
          {/* Week / month period — applies to both table and trend */}
          <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
            {(['week', 'month'] as const).map((p) => {
              const active = period === p
              return (
                <button key={p} onClick={() => changePeriod(p)}
                  style={{ padding: '5px 10px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
                    background: active ? 'var(--ds-surface)' : 'transparent', color: active ? 'var(--ds-t1)' : 'var(--ds-t2)', boxShadow: active ? 'var(--sh-sm)' : 'none' }}>
                  {p}
                </button>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
            {([['table', Table2], ['graph', LineChartIcon]] as const).map(([v, Icon]) => {
              const active = view === v
              return (
                <button key={v} onClick={() => setView(v)} aria-label={v === 'table' ? 'Table view' : 'Graph view'}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
                    background: active ? 'var(--ds-surface)' : 'transparent', color: active ? 'var(--ds-t1)' : 'var(--ds-t2)', boxShadow: active ? 'var(--sh-sm)' : 'none' }}>
                  <Icon size={13} /> {v}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {view === 'graph' ? (
        <div style={{ padding: '16px 12px 8px' }}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={trend} margin={{ top: 8, right: 24, bottom: 4, left: 8 }}>
              <CartesianGrid stroke="rgba(15,23,42,0.05)" strokeDasharray="3 4" />
              <XAxis dataKey="label" tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => money2(Number(v))} tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
              <Tooltip formatter={(value) => money2(Number(value))}
                contentStyle={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, boxShadow: 'var(--sh-md)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
              <Line type="monotone" dataKey="revPerMile"  name="Rev / mi"  stroke={COLORS.rev}  strokeWidth={2} dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="fuelPerMile" name="Fuel / mi" stroke={COLORS.fuel} strokeWidth={2} dot={{ r: 3 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : loading && trucks.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : trucks.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No truck activity recorded for this {period}.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <th style={{ ...TH, textAlign: 'left' }}>Truck</th>
                <th style={{ ...TH, textAlign: 'left' }}>Driver</th>
                <th style={TH}>Miles</th>
                <th style={TH}>Total rev</th>
                <th style={TH}>Total fuel</th>
                <th style={TH}>Rev / mi</th>
                <th style={TH}>Fuel / mi</th>
              </tr>
            </thead>
            <tbody>
              {trucks.map((t) => (
                <tr key={t.truckId} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <td style={{ ...TD, textAlign: 'left', fontFamily: 'monospace', fontWeight: 700 }}>#{t.unitNumber}</td>
                  <td style={{ ...TD, textAlign: 'left', color: t.driverName ? 'var(--ds-t1)' : 'var(--ds-t3)' }}>{t.driverName ?? '—'}</td>
                  <td style={{ ...TD, color: t.miles ? 'var(--ds-t1)' : 'var(--ds-t3)' }}>{miles0(t.miles)}</td>
                  <td style={{ ...TD, color: COLORS.rev, fontWeight: 600 }}>{money0(t.revenue)}</td>
                  <td style={{ ...TD, color: t.hasFuelCard ? COLORS.fuel : 'var(--ds-t3)' }}>{t.hasFuelCard ? money0(t.fuel) : '—'}</td>
                  <td style={{ ...TD, color: COLORS.rev }}>{money2(t.revenuePerMile)}</td>
                  <td style={{ ...TD, color: t.hasFuelCard ? COLORS.fuel : 'var(--ds-t3)' }}>{t.hasFuelCard ? money2(t.fuelPerMile) : '—'}</td>
                </tr>
              ))}
            </tbody>
            {fleet && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
                  <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }} colSpan={2}>Fleet total / average</td>
                  <td style={{ ...TD, fontWeight: 700 }}>{miles0(fleet.miles)}</td>
                  <td style={{ ...TD, color: COLORS.rev, fontWeight: 700 }}>{money0(fleet.revenue)}</td>
                  <td style={{ ...TD, color: COLORS.fuel, fontWeight: 700 }}>{money0(fleet.fuel)}</td>
                  <td style={{ ...TD, color: COLORS.rev, fontWeight: 700 }}>{money2(fleet.revenuePerMile)}</td>
                  <td style={{ ...TD, color: COLORS.fuel, fontWeight: 700 }}>{money2(fleet.fuelPerMile)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  )
}
