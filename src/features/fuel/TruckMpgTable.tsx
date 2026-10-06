/**
 * Miles per gallon by truck, from Motive, week over week.
 *
 * Both halves of the figure come from Motive and cover the same week: miles from the IFTA
 * summary, gallons from vehicle utilisation (driving fuel plus idle). It is deliberately
 * NOT computed from fuel-card purchases — a card transaction is money leaving on a date,
 * not fuel burned in a period, so a driver filling a tank on the last day of a week would
 * wreck that week and flatter the next.
 *
 * Idle fuel is included. A truck idling at a dock burns fuel no mile accounts for, and on a
 * local fleet that idles, leaving it out would flatter every figure here.
 */
import { useMemo } from 'react'
import { Gauge, TrendingDown, TrendingUp } from 'lucide-react'
import { useTruckMileage } from '@/hooks/useTruckMileage'
import { useAppStore } from '@/store/useAppStore'
import { weeklyMpg, weekOverWeek, type MileageRow } from '@/lib/truckMpg'

/** How many weeks of history to show beside the current one. */
const WEEKS_SHOWN = 6

function weekLabel(periodStart: string): string {
  return new Date(`${periodStart}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'numeric', day: 'numeric', timeZone: 'UTC',
  })
}

export function TruckMpgTable() {
  const { rows, loading, error } = useTruckMileage('WEEK')
  const equipment = useAppStore((s) => s.equipment)

  const trucks = useMemo(() => {
    const mileage = rows as unknown as MileageRow[]
    const ids = [...new Set(mileage.filter((r) => r.periodType === 'WEEK').map((r) => r.truckId))]
    return ids
      .map((truckId) => {
        const series = weeklyMpg(mileage, truckId).slice(0, WEEKS_SHOWN)
        const eq = equipment.find((e) => e.id === truckId)
        return {
          truckId,
          unitNumber: eq?.unitNumber ?? mileage.find((r) => r.truckId === truckId)?.unitNumber ?? truckId,
          retired: eq ? eq.active === false : false,
          series,
          ...weekOverWeek(series),
        }
      })
      // A truck with no figure at all sinks; among the rest, worst economy first — that is
      // the one worth asking about.
      .filter((t) => !t.retired)
      .sort((a, b) => (a.current ?? Infinity) - (b.current ?? Infinity))
  }, [rows, equipment])

  /** The weeks any truck has data for, newest first — the table's columns. */
  const weeks = useMemo(() => {
    const all = new Set<string>()
    for (const t of trucks) for (const s of t.series) all.add(s.periodStart)
    return [...all].sort((a, b) => b.localeCompare(a)).slice(0, WEEKS_SHOWN)
  }, [trucks])

  const th: React.CSSProperties = { padding: '8px 16px', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '9px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Gauge size={15} style={{ color: 'var(--ds-t3)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>MPG by Truck · Motive</span>
        <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
          · week over week, driving + idle fuel
        </span>
      </div>

      {error && (
        <div style={{ padding: '10px 20px', fontSize: 12.5, color: '#b45309', background: '#fffbeb' }}>{error}</div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 620 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
              <th style={{ ...th, textAlign: 'left' }}>Truck</th>
              <th style={{ ...th, textAlign: 'right' }}>This week</th>
              <th style={{ ...th, textAlign: 'right' }}>Change</th>
              {weeks.map((w) => (
                <th key={w} style={{ ...th, textAlign: 'right' }}>{weekLabel(w)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={3 + weeks.length} style={{ padding: 28, textAlign: 'center', color: 'var(--ds-t3)' }}>Loading…</td></tr>
            ) : trucks.length === 0 ? (
              <tr><td colSpan={3} style={{ padding: 28, textAlign: 'center', color: 'var(--ds-t3)' }}>
                No weekly mileage from Motive yet.
              </td></tr>
            ) : trucks.map((t) => (
              <tr key={t.truckId} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <td style={{ padding: '9px 16px', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ds-t1)' }}>
                  #{t.unitNumber}
                </td>
                {/* A dash, never 0.0 — a truck that did not move has no economy, not a bad one. */}
                <td style={{ ...td, fontWeight: 700, color: 'var(--ds-t1)' }}>
                  {t.current != null ? t.current.toFixed(1) : '—'}
                </td>
                <td style={{ ...td }}>
                  {t.deltaPct == null ? (
                    <span style={{ color: 'var(--ds-t3)' }}>—</span>
                  ) : (
                    <span style={{ color: t.deltaPct >= 0 ? '#15803d' : '#b91c1c', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      {t.deltaPct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      {t.deltaPct > 0 ? '+' : ''}{t.deltaPct.toFixed(1)}%
                    </span>
                  )}
                </td>
                {weeks.map((w) => {
                  const hit = t.series.find((s) => s.periodStart === w)
                  return (
                    <td key={w} style={{ ...td, color: 'var(--ds-t3)' }}>
                      {hit?.mpg != null ? hit.mpg.toFixed(1) : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
