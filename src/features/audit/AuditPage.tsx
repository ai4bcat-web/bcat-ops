/**
 * The audit log, as the Audit tab of My Brokerage.
 *
 * `BrokeragePage` owns the h1 and the tab strip, so this is an embedded list: the
 * MVMNT filter row, table, empty state and footer, with no title row of its own.
 */
import { useMemo, useState } from 'react'
import { TmsBadge, TmsListPage } from '@/features/tms/kit'
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
        <summary style={{ cursor: 'pointer' }}>{Object.keys(e.changes).length} field(s)</summary>
        <pre style={{ margin: '6px 0 0', fontSize: 10, maxWidth: 360, overflow: 'auto' }}>
          {JSON.stringify(e.changes, null, 2)}
        </pre>
      </details>
    ),
  },
]

export function AuditPage() {
  const { entries } = useAuditLog()
  const [query, setQuery] = useState('')

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
      search={{ value: query, onChange: setQuery, placeholder: 'Search entity, id or user' }}
      emptyText={
        entries.length === 0
          ? 'No audit entries yet. Make a change to see it here.'
          : 'Please try again using a different query.'
      }
      onClearFilters={query ? () => setQuery('') : undefined}
      page={{ from: rows.length === 0 ? 0 : 1, to: rows.length, total: rows.length, pageSize: rows.length }}
    />
  )
}
