/**
 * The audit log, as the Audit tab of My Brokerage.
 *
 * `BrokeragePage` owns the h1 and the tab strip, so this is an embedded list: the
 * MVMNT filter row, table, empty state and footer, with no title row of its own.
 */
import { useMemo, useState } from 'react'
import { TmsBadge, TmsButton, TmsInput, TmsListPage } from '@/features/tms/kit'
import type { ColumnDef, TmsTone } from '@/features/tms/kit'
import { useAuditLog } from '@/hooks/useAuditLog'
import { formatDateTime } from '@/lib/date'
import type { AuditAction, AuditLogEntry } from '@/types'

const ACTION_TONES: Record<AuditAction, TmsTone> = {
  create: 'green',
  update: 'orange',
  delete: 'red',
}

const COLUMNS: ColumnDef<AuditLogEntry>[] = [
  { key: 'time', header: 'TIME', width: 170, render: (e) => formatDateTime(e.createdAt) },
  { key: 'action', header: 'ACTION', width: 110, render: (e) => <TmsBadge tone={ACTION_TONES[e.action] ?? 'gray'}>{e.action}</TmsBadge> },
  { key: 'entity', header: 'ENTITY', width: 150, render: (e) => e.entityType },
  { key: 'id', header: 'ID', width: 120, render: (e) => `${e.entityId.slice(0, 8)}…` },
  { key: 'user', header: 'USER', width: 200, render: (e) => e.user },
  {
    key: 'changes',
    header: 'CHANGES',
    render: (e) => (
      <details>
        <summary className="tms-details-summary">{Object.keys(e.changes).length} field(s)</summary>
        <pre className="tms-code tms-code-compact">
          {JSON.stringify(e.changes, null, 2)}
        </pre>
      </details>
    ),
  },
]

/**
 * Every `entityType` literal a writer uses, in both spellings: the browser store writes
 * PascalCase (`EntityType`), the Lambdas write some as UPPER_SNAKE (`SHIPMENT`, `ORDER`,
 * `LOAD_CARRIER`, `CARRIER`, `DRIVER`). A lookup by id must cover both.
 */
const LOOKUP_ENTITY_TYPES = [
  'Load', 'LOAD', 'Shipment', 'SHIPMENT', 'Order', 'ORDER', 'LoadCarrier', 'LOAD_CARRIER',
  'Driver', 'DRIVER', 'Carrier', 'CARRIER', 'Customer', 'CUSTOMER', 'Quote', 'QUOTE',
  'Invoice', 'INVOICE', 'CarrierBill', 'CARRIER_BILL', 'Equipment',
]

export function AuditPage() {
  const [lookupDraft, setLookupDraft] = useState('')
  const [lookupId, setLookupId] = useState('')
  const lookupEntities = useMemo(
    () => (lookupId ? LOOKUP_ENTITY_TYPES.map((entityType) => ({ entityType, entityId: lookupId })) : undefined),
    [lookupId],
  )
  const { entries: found, loading } = useAuditLog(lookupEntities)
  const entries = useMemo(
    () => (lookupId ? [...found].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : found),
    [found, lookupId],
  )
  const [query, setQuery] = useState('')
  const submitLookup = () => setLookupId(lookupDraft.trim())

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((e) =>
      `${e.entityType} ${e.entityId} ${e.user} ${e.action}`.toLowerCase().includes(needle),
    )
  }, [entries, query])

  return (
    <TmsListPage
      embedded
      title="Audit log"
      columns={COLUMNS}
      rows={rows}
      rowKey={(e) => e.id}
      banner={
        <form
          className="tms-filter-row"
          onSubmit={(e) => { e.preventDefault(); submitLookup() }}
        >
          <TmsInput
            aria-label="Entity lookup"
            placeholder="Entity lookup: paste a load, shipment, order, driver, carrier or customer id"
            value={lookupDraft}
            onChange={(e) => setLookupDraft(e.target.value)}
          />
          <TmsButton type="submit" variant="secondary">Look up</TmsButton>
          {lookupId ? (
            <TmsButton type="button" variant="secondary" onClick={() => { setLookupDraft(''); setLookupId('') }}>
              Back to this session
            </TmsButton>
          ) : null}
        </form>
      }
      search={{ value: query, onChange: setQuery, placeholder: 'Search entity, id or user' }}
      emptyText={
        loading
          ? 'Looking up audit entries…'
          : entries.length === 0
          ? lookupId
            ? `No audit entries found for ${lookupId}.`
            : 'Showing this session’s changes only. Use Entity lookup to read the history of a load, shipment, order, driver, carrier or customer by id.'
          : 'Please try again using a different query.'
      }
      onClearFilters={query ? () => setQuery('') : undefined}
      page={{ from: rows.length === 0 ? 0 : 1, to: rows.length, total: rows.length, pageSize: rows.length }}
    />
  )
}
