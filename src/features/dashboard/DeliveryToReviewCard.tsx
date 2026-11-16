/**
 * Delivery → Load review (Ryne 2026-11-15): the average days from delivery to the Load Review push, this week and the
 * eight before it, and what is still waiting. The math is src/lib/reviewLag.ts; the look is the AR/AP summary card.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Timer } from 'lucide-react'
import { useShipments } from '@/hooks/useShipments'
import { waitingForReview, weeklyReviewLag } from '@/lib/reviewLag'
import { DashboardSummaryCard } from './DashboardSummaryCard'

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

  // Weeks with something pushed, oldest first, as a small bar strip (hover a bar for its week).
  const shown = weeks.filter((w) => w.avgDays != null)
  const maxDays = Math.max(1, ...shown.map((w) => w.avgDays ?? 0))
  const bars = shown.length < 2 ? null : (
    <div data-testid="review-lag-weeks" style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tms-muted)', marginBottom: 6 }}>
        Weekly average
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 40 }}>
        {shown.map((w, i) => {
          const last = i === shown.length - 1
          return (
            <div
              key={w.week}
              title={`${weekLabel(w.week)} · ${days(w.avgDays)} · ${w.count} pushed`}
              style={{
                flex: 1, minWidth: 6, borderRadius: 3,
                height: `${Math.max(8, Math.round(((w.avgDays ?? 0) / maxDays) * 100))}%`,
                background: last ? 'var(--tms-primary)' : 'var(--tms-muted)',
                opacity: last ? 1 : 0.55,
              }}
            />
          )
        })}
      </div>
    </div>
  )

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
      extra={bars}
      onOpen={() => navigate('/tms/load-review')}
    />
  )
}
