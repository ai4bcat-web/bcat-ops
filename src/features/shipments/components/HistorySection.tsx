/**
 * What happened to this shipment, from the audit log the routers write.
 *
 * Every write action stamps a row — `VOID_SHIPMENT` included, which is the whole point
 * of the tab: a PRO is never deleted, so the record of why it stopped moving has to be
 * readable beside it. The rows are keyed by the record they touched (the shipment, its
 * order, its loads, its carrier assignments), so one shipment's history is the union of
 * those ids rather than one table's slice.
 *
 * The read is deliberately lazy: the audit table has no index on `entityId`, so it is
 * only pulled once somebody opens the tab.
 */
import { useEffect, useState } from 'react'
import { listAuditLogs } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { TmsCard, TmsBadge } from '@/features/tms/kit'
import type { AuditLogEntry } from '@/types'
import type { ShipmentBundle } from '@/types/tms'

/** Every record id this shipment is made of; the audit rows point at one of them. */
function auditIdsFor(bundle: ShipmentBundle): string[] {
  return [
    bundle.shipment.id,
    ...bundle.orders.map((o) => o.id),
    ...bundle.loads.map((l) => l.id),
    ...bundle.loadCarriers.map((c) => c.id),
  ]
}

export function HistorySection({ bundle }: { bundle: ShipmentBundle }) {
  const [rows, setRows] = useState<AuditLogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ids = auditIdsFor(bundle).join(',')

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    const wanted = new Set(ids.split(','))
    listAuditLogs()
      .then((all) => {
        if (!live) return
        setRows(
          all
            .filter((row) => wanted.has(row.entityId))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        )
      })
      .catch((err: unknown) => {
        if (!live) return
        setError(err instanceof Error ? err.message : 'The history could not be read.')
      })
    return () => { live = false }
  }, [ids])

  return (
    <TmsCard title="History">
      {error && <p className="text-sm text-[color:var(--tms-badge-red)]">{error}</p>}
      {!error && rows === null && <p className="tms-muted text-sm">Reading the audit log…</p>}
      {!error && rows?.length === 0 && (
        <p className="tms-muted text-sm">No audited change has been recorded against this shipment.</p>
      )}
      {rows && rows.length > 0 && (
        <ol className="space-y-2" data-testid="shipment-history">
          {rows.map((row) => (
            <li key={row.id} className="border-b border-[color:var(--tms-border)] pb-2 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <TmsBadge tone={row.action.startsWith('VOID') ? 'red' : 'gray'}>{row.action}</TmsBadge>
                <span>{row.user}</span>
                <span className="tms-muted ml-auto">{formatDateTime(row.createdAt)}</span>
              </div>
              <ChangeSummary changes={row.changes} />
            </li>
          ))}
        </ol>
      )}
    </TmsCard>
  )
}

function ChangeSummary({ changes }: { changes: AuditLogEntry['changes'] }) {
  const entries = Object.entries(changes ?? {})
  if (entries.length === 0) return null
  return (
    <p className="tms-muted mt-0.5 text-xs">
      {entries.map(([key, value]) => `${key}: ${describe(value)}`).join(' · ')}
    </p>
  )
}

/**
 * An audit row's `changes` is whatever the router passed: sometimes `{from, to}`, more
 * often a flat value. Printing both shapes keeps the tab honest instead of showing
 * `[object Object]` for half the actions.
 */
function describe(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'object' && 'from' in value && 'to' in value) {
    const pair = value as { from: unknown; to: unknown }
    return `${String(pair.from ?? '—')} → ${String(pair.to ?? '—')}`
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
