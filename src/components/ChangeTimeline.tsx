/**
 * "What happened": the billing-relevant audit trail of a shipment or invoice, oldest first.
 * Release, send, queue, payment and every post-invoice change with its reason and before/after.
 * Used on the shipment History tab and on the invoice page (Step AW D.4).
 */
import { useEffect, useState } from 'react'
import { listAuditLogsFor } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { TmsCard, TmsTimeline } from '@/features/tms/kit'
import type { AuditLogEntry } from '@/types'
import { timelineEvents, type AuditEntity } from './changeTimelineModel'

export function ChangeTimeline({ entities, refreshKey }: { entities: readonly AuditEntity[]; refreshKey?: string | number }) {
  const [rows, setRows] = useState<AuditLogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = entities.map((e) => `${e.entityType}:${e.entityId}`).join(',')

  useEffect(() => {
    if (!key) return
    let live = true
    listAuditLogsFor(entities)
      .then((all) => { if (live) { setRows(all); setError(null) } })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : 'What happened could not be read.') })
    return () => { live = false }
    // `key` is the identity of `entities`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey])

  const events = rows ? timelineEvents(rows) : []
  return (
    <TmsCard title="What happened">
      {error && <p className="text-sm text-[color:var(--tms-badge-red)]">{error}</p>}
      {!error && rows === null && <p className="tms-muted text-sm">Reading the audit log…</p>}
      {!error && rows && events.length === 0 && <p className="tms-muted text-sm">Nothing billing-related has happened yet.</p>}
      {events.length > 0 && (
        <TmsTimeline
          data-testid="change-timeline"
          items={events.map((e) => ({
            id: e.id,
            title: e.title,
            description: (
              <>
                <span>{e.user}</span>
                {e.reason && <p className="mt-0.5 text-xs">Reason: {e.reason}</p>}
                {e.details.map((line) => <p key={line} className="tms-muted mt-0.5 text-xs">{line}</p>)}
              </>
            ),
            at: formatDateTime(e.at),
            tone: e.tone === 'amber' ? 'orange' : e.tone,
          }))}
        />
      )}
    </TmsCard>
  )
}
