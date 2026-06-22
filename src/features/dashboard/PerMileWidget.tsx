import { useMemo, useState } from 'react'
import { Gauge, Table2, LineChart as LineChartIcon } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { useFleetProfitability } from '@/hooks/useFleetProfitability'
import { monthRange, monthLabel } from '@/features/fleet-profitability/monthRange'

const money2 = (n: number | null) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100)

const COLORS = { rev: '#15803d', fuel: '#dc2626' }
const MONTHS_BACK = 6
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
  const range = monthRange(0)
  const { data, loading, computeForRange } = useFleetProfitability(range, 'LOCAL')

  // Every truck with activity this month — revenue OR miles (keeps drivers like
  // Jason visible even while their mileage feed is still being reconciled).
  const trucks = (data?.trucks ?? []).filter((t) => t.miles > 0 || t.revenue > 0)
  const fleet = data?.rollup

  // Monthly fleet history (oldest → newest) for the comparison line chart.
  const monthly = useMemo(() => {
    const out: { month: string; revPerMile: number | null; fuelPerMile: number | null }[] = []
    for (let i = MONTHS_BACK - 1; i >= 0; i--) {
      const r = monthRange(i)
      const roll = computeForRange(r).rollup
      out.push({
        month: new Date(`${r.start}T12:00:00`).toLocaleDateString('en-US', { month: 'short' }),
        revPerMile: round2(roll.revenuePerMile),
        fuelPerMile: round2(roll.fuelPerMile),
      })
    }
    return out
  }, [computeForRange])

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Gauge size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Revenue &amp; fuel per mile</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
              Ivan fleet · {view === 'table' ? `Per truck · ${monthLabel(range)}` : `Monthly trend · last ${MONTHS_BACK} months`}
            </div>
          </div>
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

      {view === 'graph' ? (
        <div style={{ padding: '16px 12px 8px' }}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={monthly} margin={{ top: 8, right: 24, bottom: 4, left: 8 }}>
              <CartesianGrid stroke="rgba(15,23,42,0.05)" strokeDasharray="3 4" />
              <XAxis dataKey="month" tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} />
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
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No truck activity recorded this month.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <th style={{ ...TH, textAlign: 'left' }}>Truck</th>
                <th style={{ ...TH, textAlign: 'left' }}>Driver</th>
                <th style={TH}>Rev / mi</th>
                <th style={TH}>Fuel / mi</th>
              </tr>
            </thead>
            <tbody>
              {trucks.map((t) => (
                <tr key={t.truckId} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <td style={{ ...TD, textAlign: 'left', fontFamily: 'monospace', fontWeight: 700 }}>#{t.unitNumber}</td>
                  <td style={{ ...TD, textAlign: 'left', color: t.driverName ? 'var(--ds-t1)' : 'var(--ds-t3)' }}>{t.driverName ?? '—'}</td>
                  <td style={{ ...TD, color: COLORS.rev, fontWeight: 600 }}>{money2(t.revenuePerMile)}</td>
                  <td style={{ ...TD, color: t.hasFuelCard ? COLORS.fuel : 'var(--ds-t3)' }}>{t.hasFuelCard ? money2(t.fuelPerMile) : '—'}</td>
                </tr>
              ))}
            </tbody>
            {fleet && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
                  <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }} colSpan={2}>Fleet average</td>
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
