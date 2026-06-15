import { useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, Cell,
} from 'recharts'
import { Gauge, ChevronLeft, ChevronRight } from 'lucide-react'
import { listTruckMileages, type TruckMileage } from '@/lib/apiClient'
import {
  PERIOD_TYPES, PERIOD_LABELS, periodStartIso, periodLabel, type PeriodType,
} from '@/lib/mileagePeriods'
import { TruckMileageDetail } from './TruckMileageDetail'

interface Row {
  truckId:    string
  unitNumber: string
  miles:      number
}

function fmtMiles(n: number): string {
  return Math.round(n).toLocaleString()
}

// Motive vehicles that aren't tracked trucks (trailers / test / decommissioned units) —
// hidden from Miles per Truck. Add unit numbers here to exclude them.
const EXCLUDED_UNITS = new Set(['828', '125'])

export function TruckMilesWidget() {
  const [periodType, setPeriodType] = useState<PeriodType>('WEEK')
  const [offset, setOffset] = useState(0)               // 0 = current, 1 = previous…
  const [userStepped, setUserStepped] = useState(false) // true once the user steps periods
  const [mileages, setMileages] = useState<TruckMileage[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<{ truckId: string; unitNumber: string } | null>(null)

  // Fetch only the selected granularity. Refetch on type change + every 5 min.
  useEffect(() => {
    let active = true
    const load = () => {
      listTruckMileages(undefined, periodType)
        .then((d) => { if (active) setMileages(d) })
        .catch((e) => console.error('listTruckMileages failed', e))
        .finally(() => { if (active) setLoading(false) })
    }
    load()
    const id = setInterval(load, 300_000)
    return () => { active = false; clearInterval(id) }
  }, [periodType])

  // Day view: Motive's IFTA miles lag a day or two, so "today" is usually empty.
  // Default the Day view to the most recent day that actually has miles (until the
  // user steps periods manually). Week/Month/Year stay on the current period.
  useEffect(() => {
    if (periodType !== 'DAY' || userStepped) return
    const latest = mileages
      .filter((m) => m.periodType === 'DAY' && m.miles > 0)
      .reduce<string | null>((max, m) => (max === null || m.periodStart > max ? m.periodStart : max), null)
    if (!latest) return
    for (let off = 0; off <= 400; off++) {
      if (periodStartIso('DAY', off) === latest) { setOffset(off); break }
    }
  }, [mileages, periodType, userStepped])

  const targetStart = periodStartIso(periodType, offset)

  const rows = useMemo(() => {
    const byTruck = new Map<string, Row>()
    for (const m of mileages) {
      if (m.periodType !== periodType || m.periodStart !== targetStart) continue
      if (EXCLUDED_UNITS.has(m.unitNumber)) continue
      const r = byTruck.get(m.truckId) ?? { truckId: m.truckId, unitNumber: m.unitNumber, miles: 0 }
      r.miles += m.miles
      byTruck.set(m.truckId, r)
    }
    // A unit can have a stale `motive:`/`blueink:` orphan row alongside its real
    // Equipment-keyed row. Keep one bar per unit (prefer the Equipment-keyed id, else
    // the larger value) so the same truck isn't charted twice or its miles doubled.
    const isOrphanKey = (id: string) => id.startsWith('motive:') || id.startsWith('blueink:')
    const byUnit = new Map<string, Row>()
    for (const r of byTruck.values()) {
      const prev = byUnit.get(r.unitNumber)
      if (!prev) { byUnit.set(r.unitNumber, r); continue }
      const prevOrphan = isOrphanKey(prev.truckId)
      const rOrphan    = isOrphanKey(r.truckId)
      const better = prevOrphan !== rOrphan ? !rOrphan : r.miles > prev.miles
      if (better) byUnit.set(r.unitNumber, r)
    }
    return [...byUnit.values()].sort((a, b) => b.miles - a.miles)
  }, [mileages, periodType, targetStart])

  const fleetTotal = rows.reduce((s, r) => s + r.miles, 0)

  function changeType(t: PeriodType) {
    setPeriodType(t)
    setOffset(0)
    setUserStepped(false)   // re-enable the "latest day with data" default for the new type
    setLoading(true)
  }

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', display: 'flex', alignItems: 'center', gap: 7 }}>
            <Gauge size={15} /> Miles per Truck
          </div>
          {/* Day / Week / Month / Year toggle */}
          <div style={{ display: 'flex', gap: 3, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, padding: 3 }}>
            {PERIOD_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => changeType(t)}
                style={{
                  padding: '3px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11.5, fontFamily: 'inherit',
                  fontWeight: periodType === t ? 600 : 500,
                  background: periodType === t ? '#fff' : 'transparent',
                  color: periodType === t ? 'var(--ds-t1)' : 'var(--ds-t3)',
                  boxShadow: periodType === t ? 'var(--sh-sm)' : 'none',
                }}
              >
                {PERIOD_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Look-back stepper */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <button onClick={() => { setUserStepped(true); setOffset((o) => o + 1) }} title="Previous period"
            style={{ display: 'flex', alignItems: 'center', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 6, cursor: 'pointer', padding: '3px 5px', color: 'var(--ds-t2)' }}>
            <ChevronLeft size={15} />
          </button>
          <div style={{ fontSize: 12.5, color: 'var(--ds-t2)', fontWeight: 500, minWidth: 130, textAlign: 'center' }}>
            {periodLabel(periodType, targetStart)}{offset === 0 ? ' (current)' : ''}
          </div>
          <button onClick={() => { setUserStepped(true); setOffset((o) => Math.max(0, o - 1)) }} disabled={offset === 0} title="Next period"
            style={{ display: 'flex', alignItems: 'center', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 6, cursor: offset === 0 ? 'default' : 'pointer', padding: '3px 5px', color: 'var(--ds-t2)', opacity: offset === 0 ? 0.4 : 1 }}>
            <ChevronRight size={15} />
          </button>
          <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ds-t3)' }}>from Motive ELD</div>
        </div>
      </div>

      <div style={{ padding: '16px 20px' }}>
        {!loading && rows.length === 0 ? (
          <div style={{ height: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ds-t3)', textAlign: 'center', padding: '0 24px' }}>
            No mileage for this {PERIOD_LABELS[periodType].toLowerCase()}. Mileage syncs from Motive (IFTA data); a truck shows miles once it has moved in the period.
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={Math.max(150, rows.length * 40)}>
              <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 28, top: 4, bottom: 4 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="unitNumber" width={56} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                <RTooltip
                  cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <div style={{ background: '#fff', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '7px 12px', fontSize: 13, boxShadow: 'var(--sh-md)' }}>
                        <span style={{ fontWeight: 600 }}>Unit {payload[0].payload.unitNumber}</span>
                        <span style={{ color: 'var(--ds-t3)', marginLeft: 8 }}>{fmtMiles(payload[0].payload.miles)} mi</span>
                      </div>
                    ) : null
                  }
                />
                <Bar dataKey="miles" radius={[0, 4, 4, 0]} maxBarSize={24} cursor="pointer"
                  onClick={(d: { payload?: Row }) => d?.payload && setSelected({ truckId: d.payload.truckId, unitNumber: d.payload.unitNumber })}>
                  {rows.map((_, i) => <Cell key={i} fill="#1ea8f3" />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>

            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--ds-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--ds-t3)' }}>
              <div>
                Fleet total <span style={{ color: 'var(--ds-t1)', fontFamily: 'var(--font-mono)' }}>{fmtMiles(fleetTotal)}</span> mi
              </div>
              <div style={{ fontSize: 11.5 }}>Click a truck for its breakdown &amp; trend</div>
            </div>
          </>
        )}
      </div>

      {selected && (
        <TruckMileageDetail truck={selected} periodType={periodType} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
