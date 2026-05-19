import { Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { IntakeItem, IntakeStatus } from '@/types'

const STATUS_STYLES: Record<IntakeStatus, string> = {
  NEED_TO_BUILD: 'bg-amber-50 text-amber-700 border-amber-200',
  BUILT:         'bg-emerald-50 text-emerald-700 border-emerald-200',
}

const STATUS_LABELS: Record<IntakeStatus, string> = {
  NEED_TO_BUILD: 'Need to Build',
  BUILT:         'Built',
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

interface IntakeCardProps {
  item: IntakeItem
  selected: boolean
  onClick: () => void
}

export function IntakeCard({ item, selected, onClick }: IntakeCardProps) {
  const hasPdfs = (item.s3KeyPdfAttachments?.length ?? 0) > 0

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-3 border-b border-slate-100 transition-colors',
        selected ? 'bg-sky-50' : 'hover:bg-slate-50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground truncate leading-tight">
          {item.subject || '(no subject)'}
        </p>
        <span className={cn(
          'shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border',
          STATUS_STYLES[item.status],
        )}>
          {STATUS_LABELS[item.status]}
        </span>
      </div>
      <p className="text-xs text-muted-foreground truncate mt-0.5">{item.fromEmail}</p>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[11px] text-muted-foreground">
          {relativeTime(item.receivedAt)}
        </span>
        {hasPdfs && (
          <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
            <Paperclip className="size-2.5" />
            {item.s3KeyPdfAttachments.length}
          </span>
        )}
      </div>
    </button>
  )
}
