/**
 * Pending with OTR and OTR rejected, as two list cards over the factoring queue. The expected
 * advance after OTR's fee is not shown: no fee rate or advance amount is stored anywhere
 * (settings, the queue row, or what the OTR sync writes back), so it would be a guess.
 */
import { TmsListCard } from '@/features/tms/kit'
import type { FactoringItem } from '@/types'
import { money } from './factoringTotals'
import { otrRejectedStats, pendingOtrStats } from './factoringQueueStats'

const n = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`

export function FactoringCards({ items, asOf, customerName, onTab }: {
  items: readonly FactoringItem[]
  asOf: string
  customerName: (item: FactoringItem) => string
  onTab: (tab: 'PENDING_WITH_OTR' | 'OTR_REJECTED') => void
}) {
  const p = pendingOtrStats(items, asOf)
  const r = otrRejectedStats(items, asOf, customerName)
  return (
    <div className="flex flex-wrap gap-3" style={{ padding: '4px 8px' }} data-testid="factoring-cards">
      <TmsListCard
        title="Pending with OTR"
        total={money(p.dollars)}
        testId="otr-pending-card"
        rows={[
          { key: 'pending', label: 'Submitted, not funded', value: money(p.dollars), sub: n(p.count, 'invoice'), onClick: () => onTab('PENDING_WITH_OTR') },
          { key: 'avg', label: 'Avg days waiting', value: p.avgDaysWaiting == null ? null : `${p.avgDaysWaiting} d`, sub: 'since submitted' },
          {
            key: 'oldest',
            label: 'Oldest submission',
            value: p.oldest ? `${p.oldest.days} d` : null,
            sub: p.oldest ? `PRO ${p.oldest.proNumber}` : null,
            tone: (p.oldest?.days ?? 0) > 14 ? 'warn' : 'default',
          },
        ]}
      />
      <TmsListCard
        title="OTR rejected"
        total={money(r.dollars)}
        testId="otr-rejected-card"
        rows={[
          { key: 'rejected', label: 'Rejected, in the queue', value: money(r.dollars), sub: n(r.count, 'invoice'), tone: r.count ? 'bad' : 'default', onClick: () => onTab('OTR_REJECTED') },
          ...(r.topReasons.length
            ? [
              { key: 'reasons', label: 'Top reasons · last 30 days', value: '', kind: 'group' as const },
              ...r.topReasons.map((t, i) => ({ key: `reason-${i}`, label: t.reason, value: String(t.count), kind: 'sub' as const, title: t.reason })),
            ]
            : []),
          {
            key: 'manual',
            label: 'Moved to manual invoice this month',
            value: String(r.movedToManual.count),
            sub: r.movedToManual.customers.length ? n(r.movedToManual.customers.length, 'customer') : null,
            title: r.movedToManual.customers.join(', ') || 'None this month',
          },
        ]}
      />
    </div>
  )
}
