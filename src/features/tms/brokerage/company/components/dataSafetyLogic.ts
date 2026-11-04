/** Pure rules of the Data & backups page: when a CSV export may start, and what a job's progress is. */
import type { DataExportJob, DataExportScope } from '@/types/tms'

export const EXPORT_ALL_PHRASE = 'EXPORT ALL'

/** Why "Start CSV export" is disabled, or null. The Lambda enforces the same rule; this only saves the trip. */
export function csvExportBlockReason(input: { scope: DataExportScope; acknowledgePii: boolean; confirmText: string }): string | null {
  if (!input.acknowledgePii) return 'Tick the box to confirm you understand the files contain customer and carrier personal data.'
  if (input.scope === 'ALL' && input.confirmText !== EXPORT_ALL_PHRASE) return `Type ${EXPORT_ALL_PHRASE} to export every table.`
  return null
}

export const ACTIVE_EXPORT: ReadonlyArray<DataExportJob['status']> = ['PENDING', 'RUNNING']

export function tablesDone(job: DataExportJob): { done: number; total: number; failed: number } {
  const tables = job.tables ?? []
  return {
    total: tables.length,
    done: tables.filter((t) => t.status === 'COMPLETED' || t.status === 'SKIPPED_NO_PITR').length,
    failed: tables.filter((t) => t.status === 'FAILED').length,
  }
}

export function bytesLabel(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
