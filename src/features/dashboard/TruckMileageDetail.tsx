import { useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { X, Gauge } from 'lucide-react'
import { listTruckMileages, type TruckMileage } from '@/lib/apiClient'
import {
  PERIOD_TYPES, PERIOD_LABELS, periodStartIso, periodTickLabel,
  recentPeriodStarts, type PeriodType,
} from '@/lib/mileagePeriods'

function fmt(n: number): string {
  return Math.round(n).toLocaleString()
}

interface Props {
  truck: { truckId: string; unitNumber: string }
  periodType: PeriodType
  onClose: () => void
}

export function TruckMileageDetail({ truck, periodType, onClose }: Props) {
  const [records, setRecords] = useState<TruckMileage[]>([])
  const [loading, setLoading] = useState(true)
  const [type, setType] = useState<PeriodType>(periodType)

  useEffect(() => {
    let active = true
    listTruckMileages(truck.truckId)
      .then((r) => { if (active) setRecords(r) })
      .catch((e) => console.error('listTruckMileages(detail) failed', e))
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [truck.truckId])

  // Current total per granularity (today / this week / this month / this year).
  const totals = useMemo(() => {
    const map = { DAY: 0, WEEK: 0, MONTH: 0, YEAR: 0 } as Record<PeriodType, number>
    for (const t of PERIOD_TYPES) {
      const start = periodStartIso(t, 0)
      map[t] = records.find((r) => r.periodType === t && r.periodStart === start)?.miles ?? 0
    }
    return map
  }, [records])

  // Trend: last 12 periods of the selected granularity (0-filled where missing).
  const trend = useMemo(() => {
    const byStart = new Map(records.filter((r) => r.periodType === type).map((r) => [r.periodStart, r.miles]))
    return recentPeriodStarts(type, 12).map((s) => ({
      start: s,
      label: periodTickLabel(type, s),
      miles: Math.round(byStart.get(s) ?? 0),
    }))
  }, [records, type])

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 500, maxWidth: '94vw', height: '100%', background: 'var(--ds-surface)', boxShadow: '-8px 0 28px rgba(0,0,0,0.16)', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Gauge size={16} />
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>Unit {truck.unitNumber} — Mileage</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ds-t3)', padding: 4 }}><X size={18} /></button>
        </div>

        {/* Current totals */}
        <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {PERIOD_TYPES.map((t) => (
            <div key={t} style={{ background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: '10px 12px' }}>
              <div style={{ fontSize: 10.5, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{PERIOD_LABELS[t]}</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 3, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>{fmt(totals[t])}</div>
              <div style={{ fontSize: 10.5, color: 'var(--ds-t3)' }}>mi</div>
            </div>
          ))}
        </div>

        {/* Trend */}
        <div style={{ padding: '4px 20px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)' }}>Trend — last 12 {PERIOD_LABELS[type].toLowerCase()}s</div>
            <div style={{ display: 'flex', gap: 3, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, padding: 3 }}>
              {PERIOD_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  style={{
                    padding: '3px 9px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11.5, fontFamily: 'inherit',
                    fontWeight: type === t ? 600 : 500,
                    background: type === t ? '#fff' : 'transparent',
                    color: type === t ? 'var(--ds-t1)' : 'var(--ds-t3)',
                    boxShadow: type === t ? 'var(--sh-sm)' : 'none',
                  }}
                >
                  {PERIOD_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          {loading ? (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={trend} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
                <XAxis dataKey="label" tick={{ fontSize: 10.5 }} tickLine={false} axisLine={false} interval={0} angle={trend.length > 8 ? -35 : 0} textAnchor={trend.length > 8 ? 'end' : 'middle'} height={trend.length > 8 ? 44 : 24} />
                <YAxis tick={{ fontSize: 10.5 }} tickLine={false} axisLine={false} width={44} />
                <RTooltip
                  cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <div style={{ background: '#fff', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '7px 12px', fontSize: 13, boxShadow: 'var(--sh-md)' }}>
                        <span style={{ fontWeight: 600 }}>{fmt(Number(payload[0].value))} mi</span>
                      </div>
                    ) : null
                  }
                />
                <Bar dataKey="miles" radius={[4, 4, 0, 0]} maxBarSize={36}>
                  {trend.map((_, i) => <Cell key={i} fill="#1ea8f3" />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  )
}
