import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import { TmsCard } from '@/features/tms/kit/TmsCard'
import { TmsEmptyState } from '@/features/tms/kit/TmsEmptyState'
import { relativeDays } from '@/lib/complianceOverview'
import type { OverviewRow } from '@/lib/complianceOverview'

/** The next documents to lapse (expired first). Pure view over `expiringQueue(rows)`. */
export function ExpiringQueue({ rows, onOpen, limit = 8 }: { rows: OverviewRow[]; onOpen: (row: OverviewRow) => void; limit?: number }) {
  const shown = rows.slice(0, limit)
  return (
    <TmsCard title="Expiring soon" actions={rows.length > limit ? <span className="tms-meta-empty">{rows.length - limit} more</span> : undefined}>
      {shown.length === 0 ? (
        <TmsEmptyState compact title="Nothing is expiring in the next 30 days." />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--tms-gap)' }}>
          {shown.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                className="tms-btn tms-btn-ghost"
                style={{ width: '100%', justifyContent: 'space-between', textAlign: 'left' }}
                onClick={() => onOpen(row)}
              >
                <span>
                  <strong>{row.entityName}</strong>
                  <span className="tms-meta-empty"> · {row.title}</span>
                </span>
                <TmsBadge tone={row.state === 'EXPIRED' ? 'red' : 'orange'}>
                  {row.state === 'EXPIRED' ? 'Expired' : 'Expiring'} {relativeDays(row.daysLeft)}
                </TmsBadge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </TmsCard>
  )
}
