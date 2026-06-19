import { useState } from 'react'
import { Gauge, Table2, BarChart3 } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { useFleetProfitability } from '@/hooks/useFleetProfitability'
import { monthRange, monthLabel } from '@/features/fleet-profitability/monthRange'

const money2 = (n: number | null) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const COLORS = { rev: '#15803d', fuel: '#dc2626' }
const TH: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--ds-t1)', padding: '9px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

/**
 * Per-truck efficiency for the Ivan (LOCAL) fleet this month — revenue per mile and
 * fuel cost per mile — as a table or grouped bar chart.
 */
export function PerMileWidget() {
  const [view, setView] = useState<'table' | 'graph'>('table')
  const range = monthRange(0)
  const { data, loading } = useFleetProfitability(range, 'LOCAL')

  const trucks = (data?.trucks ?? []).filter((t) => t.miles > 0)
  const chartData = trucks.map((t) => ({
    unit: `#${t.unitNumber}`,
    revPerMile: t.revenuePerMile == null ? 0 : Math.round(t.revenuePerMile * 100) / 100,
    fuelPerMile: t.fuelPerMile == null ? 0 : Math.round(t.fuelPerMile * 100) / 100,
  }))

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Gauge size={16} style={{ color: 'var(--ds-blue)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Revenue &amp; fuel per mile</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Per truck · Ivan fleet · {monthLabel(range)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', borderRadius: 8, padding: 2 }}>
          {([['table', Table2], ['graph', BarChart3]] as const).map(([v, Icon]) => {
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

      {loading && trucks.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : trucks.length === 0 ? (
        <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>No truck miles recorded this month.</div>
      ) : view === 'table' ? (
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
          </table>
        </div>
      ) : (
        <div style={{ padding: '16px 12px 8px' }}>
          <ResponsiveContainer width="100%" height={Math.max(220, chartData.length * 34)}>
            <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 8 }} barGap={2}>
              <CartesianGrid stroke="rgba(15,23,42,0.05)" strokeDasharray="3 4" horizontal={false} />
              <XAxis type="number" tickFormatter={(v) => money2(v)} tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="unit" tick={{ fill: '#6b7588', fontSize: 11 }} axisLine={false} tickLine={false} width={50} />
              <Tooltip cursor={{ fill: 'rgba(15,23,42,0.04)' }} formatter={(value) => money2(Number(value))}
                contentStyle={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, boxShadow: 'var(--sh-md)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="rect" />
              <Bar dataKey="revPerMile"  name="Rev / mi"  fill={COLORS.rev}  radius={[0, 3, 3, 0]} />
              <Bar dataKey="fuelPerMile" name="Fuel / mi" fill={COLORS.fuel} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
