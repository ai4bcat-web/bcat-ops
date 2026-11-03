/**
 * Section 3: when each background job last left an honest timestamp. A job that leaves
 * none is listed as "No heartbeat recorded" rather than guessed, and on the dev stack
 * (schedules disabled) a stale one reads "Paused on dev", never red.
 */
import { TmsBadge, TmsCard, TmsTable } from '@/features/tms/kit'
import type { ColumnDef, TmsTone } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { formatAge } from '@/lib/platformHealth'
import type { SyncRow, SyncState } from '@/lib/platformHealth'

const STATE: Record<SyncState, { label: string; tone: TmsTone }> = {
  FRESH: { label: 'Fresh', tone: 'green' },
  LATE: { label: 'Late', tone: 'red' },
  NO_DATA: { label: 'No data', tone: 'gray' },
  PAUSED: { label: 'Paused on dev', tone: 'gray' },
  RECORDED: { label: 'Recorded', tone: 'gray' },
  NO_HEARTBEAT: { label: 'No heartbeat recorded', tone: 'gray' },
}

export interface SyncTableProps {
  rows: SyncRow[]
}

const columns: ColumnDef<SyncRow>[] = [
  { key: 'source', header: 'SOURCE', render: (r) => r.source },
  { key: 'at', header: 'LAST AT', width: 180, render: (r) => (r.at ? formatDateTime(r.at) : '—') },
  { key: 'age', header: 'AGE', width: 110, render: (r) => formatAge(r.ageMs) ?? '—' },
  { key: 'cadence', header: 'CADENCE', width: 230, render: (r) => r.cadenceLabel },
  {
    key: 'state',
    header: 'STATE',
    width: 200,
    render: (r) => <TmsBadge tone={STATE[r.state].tone}>{STATE[r.state].label}</TmsBadge>,
  },
]

export function SyncTable({ rows }: SyncTableProps) {
  return (
    <TmsCard title="Last sync times" flush>
      <TmsTable<SyncRow> columns={columns} rows={rows} rowKey={(r) => r.key} empty="No sync sources" />
    </TmsCard>
  )
}

export default SyncTable
