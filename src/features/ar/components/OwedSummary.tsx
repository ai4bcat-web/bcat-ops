/**
 * "Owed by <selection>": the open balance of what the filters selected, split by due date. Each
 * bucket filters the table to it; clicking the active one again clears it.
 */
import { TmsListCard, type TmsListRow } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDay } from '../arViews'
import { DUE_BUCKET_LABEL, type DueBucket, type OwedSummary as Summary } from '../owedFilters'

const ROWS: Array<{ bucket: DueBucket; kind?: TmsListRow['kind'] }> = [
  { bucket: 'notDue', kind: 'group' },
  { bucket: 'week', kind: 'sub' },
  { bucket: 'month', kind: 'sub' },
  { bucket: 'later', kind: 'sub' },
  { bucket: 'past' },
  { bucket: 'none' },
]

export function OwedSummary({ title, summary, unit, due, onDue, testId }: {
  title: string
  summary: Summary
  /** "invoice" / "bill", pluralised with an s. */
  unit: string
  due: DueBucket | null
  onDue: (bucket: DueBucket | null) => void
  testId?: string
}) {
  const count = (n: number) => `${n} ${unit}${n === 1 ? '' : 's'}`
  const rows: TmsListRow[] = [
    {
      key: 'next',
      label: 'Next due date',
      value: summary.nextDueAt ? formatDay(summary.nextDueAt) : null,
    },
    ...ROWS
      .filter(({ bucket }) => bucket !== 'none' || summary.buckets.none.count > 0)
      .map(({ bucket, kind }) => {
        const b = summary.buckets[bucket]
        return {
          key: bucket,
          label: DUE_BUCKET_LABEL[bucket],
          sub: count(b.count),
          value: formatCents(b.cents),
          kind,
          tone: bucket === 'past' && b.cents > 0 ? 'bad' as const : 'default' as const,
          active: due === bucket,
          onClick: () => onDue(due === bucket ? null : bucket),
        }
      }),
  ]
  return (
    <TmsListCard
      title={title}
      total={<>{formatCents(summary.totalCents)} <span className="tms-muted">· {count(summary.count)}</span></>}
      rows={rows}
      testId={testId}
      aria-label={title}
    />
  )
}
