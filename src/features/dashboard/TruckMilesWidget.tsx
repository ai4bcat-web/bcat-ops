import { useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, Cell,
} from 'recharts'
import { Gauge } from 'lucide-react'
import { listTruckMileages, type TruckMileage } from '@/lib/apiClient'

interface Row {
  truckId:    string
  unitNumber: string
  week:       number
  month:      number
}

function fmtMiles(n: number): string {
  return Math.round(n).toLocaleString()
}

function prettyDate(iso?: string): string {
  if (!iso) return '—'
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function TruckMilesWidget() {
  const [mileages, setMileages] = useState<TruckMileage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listTruckMileages()
      .then(setMileages)
      .catch((e) => console.error('listTruckMileages failed', e))
      .finally(() => setLoading(false))
  }, [])

  const { rows, weekStart, monthStart } = useMemo(() => {
    // Latest WEEK / MONTH periodStart present in the data = "this week"/"this month".
    const weekStarts = mileages.filter((m) => m.periodType === 'WEEK').map((m) => m.periodStart).sort()
    const monthStarts = mileages.filter((m) => m.periodType === 'MONTH').map((m) => m.periodStart).sort()
    const weekStart = weekStarts[weekStarts.length - 1]
    const monthStart = monthStarts[monthStarts.length - 1]

    const byTruck = new Map<string, Row>()
    for (const m of mileages) {
      const r = byTruck.get(m.truckId) ?? { truckId: m.truckId, unitNumber: m.unitNumber, week: 0, month: 0 }
      if (m.periodType === 'WEEK' && m.periodStart === weekStart) r.week = m.miles
      if (m.periodType === 'MONTH' && m.periodStart === monthStart) r.month = m.miles
      byTruck.set(m.truckId, r)
    }
    const rows = [...byTruck.values()].sort((a, b) => b.week - a.week)
    return { rows, weekStart, monthStart }
  }, [mileages])

  const weekTotal = rows.reduce((s, r) => s + r.week, 0)
  const monthTotal = rows.reduce((s, r) => s + r.month, 0)

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', display: 'flex', alignItems: 'center', gap: 7 }}>
          <Gauge size={15} /> Miles per Truck
        </div>
        <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
          {loading ? 'Loading…' : `Week of ${prettyDate(weekStart)} · from Motive ELD`}
        </div>
      </div>

      <div style={{ padding: '16px 20px' }}>
        {!loading && rows.length === 0 ? (
          <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ds-t3)', textAlign: 'center', padding: '0 24px' }}>
            No mileage synced yet. Confirm the Motive API key is set and trucks are marked COMPANY in the Trucks page.
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 40)}>
              <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 28, top: 4, bottom: 4 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="unitNumber" width={56} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                <RTooltip
                  cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <div style={{ background: '#fff', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '7px 12px', fontSize: 13, boxShadow: 'var(--sh-md)' }}>
                        <span style={{ fontWeight: 600 }}>Unit {payload[0].payload.unitNumber}</span>
                        <div style={{ color: 'var(--ds-t3)', marginTop: 2 }}>
                          {fmtMiles(payload[0].payload.week)} mi this week
                        </div>
                        <div style={{ color: 'var(--ds-t3)' }}>
                          {fmtMiles(payload[0].payload.month)} mi this month
                        </div>
                      </div>
                    ) : null
                  }
                />
                <Bar dataKey="week" radius={[0, 4, 4, 0]} maxBarSize={24}>
                  {rows.map((_, i) => (
                    <Cell key={i} fill="#1ea8f3" />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>

            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--ds-border)', display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ds-t3)' }}>
              <div>
                Fleet this week <span style={{ color: 'var(--ds-t1)', fontFamily: 'var(--font-mono)' }}>{fmtMiles(weekTotal)}</span> mi
              </div>
              <div>
                This month ({prettyDate(monthStart)}) <span style={{ color: 'var(--ds-t1)', fontFamily: 'var(--font-mono)' }}>{fmtMiles(monthTotal)}</span> mi
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
