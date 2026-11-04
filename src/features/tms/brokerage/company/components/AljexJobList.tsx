/** The job list above the stepper: every run is resumable from here. */
import { TmsBadge, TmsButton, TmsCard, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import type { AljexImportJob } from '@/types/tms'
import { isStalled, jobTone, processedOf } from './aljexImportLogic'

export function AljexJobList({
  jobs, selectedId, now, onOpen,
}: { jobs: AljexImportJob[]; selectedId: string | null; now: number; onOpen: (job: AljexImportJob) => void }) {
  const columns: Array<ColumnDef<AljexImportJob>> = [
    {
      key: 'status', header: 'Status', width: 130,
      render: (j) => <TmsBadge tone={jobTone(j, now)}>{isStalled(j, now) ? 'Stalled' : j.status}</TmsBadge>,
    },
    { key: 'phase', header: 'Phase', width: 110, render: (j) => j.phase ?? '—' },
    { key: 'file', header: 'File', render: (j) => j.fileName ?? '—' },
    {
      key: 'target', header: 'Target', width: 150,
      render: (j) => (j.target ? `${j.target}${j.targetTag ? ` · ${j.targetTag}` : ''}${j.synthetic ? ' · synthetic' : ''}` : '—'),
    },
    {
      key: 'counts', header: 'Rows', width: 120,
      render: (j) => {
        const { done, staged } = processedOf(j)
        return staged > 0 ? `${done.toLocaleString('en-US')} / ${staged.toLocaleString('en-US')}` : String(j.rowCount ?? '—')
      },
    },
    { key: 'who', header: 'Started by', render: (j) => j.createdBy },
    { key: 'when', header: 'When', width: 170, render: (j) => (j.startedAt ?? j.createdAt ? new Date(j.startedAt ?? j.createdAt ?? '').toLocaleString() : '—') },
    {
      key: 'open', header: '', width: 90,
      render: (j) => (
        <TmsButton size="sm" aria-label={`Open ${j.id}`} aria-current={j.id === selectedId} onClick={() => onOpen(j)}>
          {isStalled(j, now) || j.status === 'PAUSED' ? 'Resume…' : 'Open'}
        </TmsButton>
      ),
    },
  ]
  return (
    <TmsCard title="Aljex import runs">
      <TmsTable
        columns={columns}
        rows={jobs}
        rowKey={(j) => j.id}
        empty={<span className="tms-muted">No Aljex import runs yet.</span>}
      />
    </TmsCard>
  )
}
