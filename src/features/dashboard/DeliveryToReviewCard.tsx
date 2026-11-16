/**
 * Delivery → Load review (Ryne 2026-11-15): the average days from delivery to the Load Review push, this week and the
 * eight before it, and what is still waiting. The math is src/lib/reviewLag.ts; the look is the AR/AP summary card.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Timer } from 'lucide-react'
import { useShipments } from '@/hooks/useShipments'
import { waitingForReview, weeklyReviewLag } from '@/lib/reviewLag'
import { DashboardSummaryCard, type DashboardSummaryRow } from './DashboardSummaryCard'

const days = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)} d`)

/** Pickup months covering the last ~4 months, so loads delivered 8 weeks ago are in the read. */
function recentMonths(nowMs: number): string[] {
  const d = new Date(nowMs)
  return Array.from({ length: 4 }, (_, i) => {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1))
    return m.toISOString().slice(0, 7)
  })
}

function weekLabel(monday: string): string {
  const [y, m, d] = monday.split('-').map(Number)
  return `Week of ${new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
}

export function DeliveryToReviewCard() {
  const navigate = useNavigate()
  const [now] = useState(() => Date.now())
  const months = useMemo(() => recentMonths(now), [now])
  const windowRead = useShipments({ kind: 'window', months })
  const workingRead = useShipments({ kind: 'working' })
  const windowRows = windowRead.shipments
  const workingRows = workingRead.shipments
  const rows = useMemo(() => {
    const byId = new Map<string, (typeof workingRows)[number]>()
    for (const r of [...windowRows, ...workingRows]) byId.set(r.id, r)
    return [...byId.values()]
  }, [windowRows, workingRows])
  const weeks = useMemo(() => weeklyReviewLag(rows, now, 8), [rows, now])
  const waiting = useMemo(() => waitingForReview(rows, now), [rows, now])
  const loading = windowRead.loading || workingRead.loading
  const thisWeek = weeks[weeks.length - 1]
  const lastWeek = weeks[weeks.length - 2]
  const change = thisWeek?.avgDays != null && lastWeek?.avgDays != null ? thisWeek.avgDays - lastWeek.avgDays : null

  const weekRows: DashboardSummaryRow[] = [...weeks].reverse().slice(1).map((w) => ({
    key: `wk-${w.week}`, label: weekLabel(w.week), count: w.count || null, cents: null, valueText: days(w.avgDays),
    color: 'var(--tms-muted)', title: w.avgDays == null ? 'Nothing pushed to Load Review that week (or before Load Review existed)' : `${w.count} loads pushed`,
  }))

  return (
    <DashboardSummaryCard
      testId="delivery-to-review-card"
      title="Delivery → Load review"
      icon={<Timer size={15} />}
      headline={null}
      headlineText={loading ? '…' : thisWeek?.avgDays == null ? '—' : `${thisWeek.avgDays.toFixed(1)} days`}
      sublabel={`avg this week · ${thisWeek?.count ?? 0} pushed${change == null ? '' : ` · ${change > 0 ? '+' : ''}${change.toFixed(1)} d vs last week`}`}
      accent={change != null && change > 0 ? 'var(--tms-badge-orange)' : 'var(--tms-badge-green)'}
      rows={[{
        key: 'waiting', label: 'Still waiting now', count: waiting.count, cents: null, valueText: waiting.avgDays == null ? '—' : `avg ${days(waiting.avgDays)}`,
        color: 'var(--tms-badge-orange)', title: 'Delivered, or past the delivery date, and not pushed to Load Review yet',
        onOpen: () => navigate('/tms/shipments'),
      }]}
      groups={[{ key: 'weeks', label: 'Earlier weeks', rows: weekRows }]}
      onOpen={() => navigate('/tms/load-review')}
    />
  )
}
