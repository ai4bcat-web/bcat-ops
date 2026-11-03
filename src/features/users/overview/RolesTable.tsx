import { TmsBadge, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import type { RoleSummaryRow } from '@/lib/registrations'

const COLUMNS: Array<ColumnDef<RoleSummaryRow>> = [
  { key: 'role', header: 'Role', render: (r) => <TmsBadge tone="purple">{r.label}</TmsBadge> },
  { key: 'description', header: 'What it is for', render: (r) => <span className="tms-muted">{r.description}</span> },
  { key: 'users', header: 'Users', render: (r) => r.total },
  {
    key: 'status',
    header: 'Status',
    render: (r) => (
      <span style={{ display: 'inline-flex', gap: 6 }}>
        <TmsBadge tone="green">Active {r.active}</TmsBadge>
        <TmsBadge tone="orange">Pending {r.pending}</TmsBadge>
        <TmsBadge tone="gray">Inactive {r.inactive}</TmsBadge>
      </span>
    ),
  },
  { key: 'pages', header: 'Pages granted', render: (r) => (r.pages === null ? 'All' : r.pages) },
]

/** Read-only lens over the profiles the Users page already loaded. */
export function RolesTable({ rows }: { rows: RoleSummaryRow[] }) {
  return <TmsTable columns={COLUMNS} rows={rows} rowKey={(r) => r.role} />
}
