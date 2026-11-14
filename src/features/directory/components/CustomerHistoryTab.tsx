import { useEffect, useMemo, useState } from 'react'
import { listAuditLogsFor } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { TmsButton, TmsEmptyState } from '@/features/tms/kit'
import type { EntityType } from '@/types'
import {
  CUSTOMER_AUDIT_ENTITY_TYPES, customerFieldLabel, customerHistory, formatAuditValue,
} from '@/lib/customerAudit'

const PAGE = 25

/**
 * Customer profile › History: who changed what on this customer, when, and why — newest first.
 * Internal only (the profile is a staff screen; nothing here reaches customer-facing output).
 * Reads both entity spellings the writers have used ('CUSTOMER' and 'Customer').
 */
export function CustomerHistoryTab({ customerId, refreshKey }: { customerId: string; refreshKey?: string }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listAuditLogsFor>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    let live = true
    listAuditLogsFor(CUSTOMER_AUDIT_ENTITY_TYPES.map((t) => ({ entityType: t as EntityType, entityId: customerId })))
      .then((r) => { if (live) { setRows(r); setError(null) } })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : 'The history could not be read.') })
    return () => { live = false }
  }, [customerId, refreshKey])

  const entries = useMemo(() => (rows ? customerHistory(rows) : []), [rows])

  if (error) return <p className="text-sm text-[color:var(--tms-badge-red)]">{error}</p>
  if (rows === null) return <p className="tms-muted text-sm">Reading the history…</p>
  if (entries.length === 0) return <TmsEmptyState title="No changes recorded yet" message="Edits to this customer will show here with who made them and why." />

  return (
    <div data-testid="customer-history" style={{ display: 'grid', gap: 10 }}>
      <ol style={{ display: 'grid', gap: 10, listStyle: 'none', margin: 0, padding: 0 }}>
        {entries.slice(0, shown).map((e) => (
          <li key={e.id} data-testid="customer-history-entry" style={{ padding: '10px 12px', display: 'grid', gap: 4, border: '1px solid var(--tms-border)', borderRadius: 6, background: 'var(--tms-card)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
              <strong className="text-sm">{e.title}</strong>
              <span className="tms-muted text-xs" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDateTime(e.at)} · {e.user}</span>
            </div>
            {e.reason && <p className="text-xs" data-testid="customer-history-reason"><strong>Why:</strong> {e.reason}</p>}
            {e.source && <p className="tms-muted text-xs">Where: {e.source}</p>}
            {e.fields.length > 0 && (
              <ul style={{ display: 'grid', gap: 2, margin: 0, paddingLeft: 16 }}>
                {e.fields.map((f) => (
                  <li key={f.field} className="text-xs" style={{ overflowWrap: 'anywhere' }}>
                    <span>{customerFieldLabel(f.field)}:</span>{' '}
                    <span className="tms-muted">{formatAuditValue(f.field, f.before)}</span>{' → '}
                    <span>{formatAuditValue(f.field, f.after)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {entries.length > shown && (
        <div><TmsButton size="sm" onClick={() => setShown((n) => n + PAGE)}>Show older ({entries.length - shown} more)</TmsButton></div>
      )}
    </div>
  )
}
