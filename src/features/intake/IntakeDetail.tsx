import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, ExternalLink, X, ChevronDown, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/useAppStore'
import { getIntakePdfUrl } from '@/lib/apiClient'
import { cn } from '@/lib/utils'
import type { IntakeItem, IntakeStatus } from '@/types'

const STATUS_OPTIONS: { value: IntakeStatus; label: string }[] = [
  { value: 'NEW',         label: 'New'         },
  { value: 'IN_PROGRESS', label: 'In Progress'  },
  { value: 'BUILT',       label: 'Built'        },
  { value: 'DONE',        label: 'Done'         },
  { value: 'ARCHIVED',    label: 'Archived'     },
]

const ASSIGNEE_OPTIONS = [
  { value: 'dennis@bcatcorp.com', label: 'Dennis' },
  { value: 'arcie@bcatcorp.com',  label: 'Arcie'  },
]

interface IntakeDetailProps {
  item: IntakeItem
  onUpdate: (id: string, patch: { status?: IntakeStatus; assignedTo?: string; notes?: string; builtLoadId?: string | null }) => Promise<IntakeItem>
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}

export function IntakeDetail({ item, onUpdate, onDelete, onClose }: IntakeDetailProps) {
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)

  // Notes — autosave with 800 ms debounce
  const [notes, setNotes]           = useState(item.notes ?? '')
  const [savingNotes, setSavingNotes] = useState(false)
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // PDF previews
  const [pdfUrls, setPdfUrls]       = useState<string[]>([])
  const [pdfLoading, setPdfLoading] = useState(false)
  const [activePdf, setActivePdf]   = useState(0)

  const isSlack   = item.externalSource === 'slack'
  const isIvan    = item.source === 'IVAN_CARTAGE'
  const isActive  = item.status === 'NEW' || item.status === 'IN_PROGRESS'

  // Sync notes when item changes
  useEffect(() => { setNotes(item.notes ?? '') }, [item.id, item.notes])

  // Resolve S3 presigned URLs
  useEffect(() => {
    if (!item.s3KeyPdfAttachments?.length) { setPdfUrls([]); return }
    setPdfLoading(true)
    Promise.all(item.s3KeyPdfAttachments.map((k) => getIntakePdfUrl(k)))
      .then(setPdfUrls)
      .catch(() => setPdfUrls([]))
      .finally(() => setPdfLoading(false))
  }, [item.id, item.s3KeyPdfAttachments?.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleNotes = useCallback((val: string) => {
    setNotes(val)
    if (notesTimer.current) clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(async () => {
      setSavingNotes(true)
      try { await onUpdate(item.id, { notes: val }) }
      finally { setSavingNotes(false) }
    }, 800)
  }, [item.id, onUpdate])

  const handleStatus = async (status: IntakeStatus) => {
    await onUpdate(item.id, { status })
  }

  const handleAssignee = async (assignedTo: string) => {
    await onUpdate(item.id, { assignedTo })
  }

  // Ivan Cartage: open load builder and mark as BUILT
  const handleBuildLoad = async () => {
    await onUpdate(item.id, { status: 'BUILT' })
    setSelectedLoad(null, 'create')
  }

  // BCAT Logistics: mark as DONE (no load building needed)
  const handleMarkDone = async () => {
    await onUpdate(item.id, { status: 'DONE' })
  }

  const handleDelete = async () => {
    if (!confirm('Delete this intake item? This cannot be undone.')) return
    await onDelete(item.id)
    onClose()
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white">
      {/* Header */}
      <div className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-slate-100 shrink-0">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground leading-snug truncate">
            {item.subject || '(no subject)'}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{item.fromEmail}</p>
          <p className="text-xs text-muted-foreground">
            {new Date(item.receivedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-0.5">
          {/* Open in Slack / Gmail */}
          {item.externalUrl && (
            <a
              href={item.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-sky-600 hover:text-sky-700 font-medium"
            >
              {isSlack ? 'Open in Slack' : 'Open in Gmail'}
              <ExternalLink className="size-3" />
            </a>
          )}
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-slate-100 shrink-0 flex-wrap">
        {/* Status */}
        <div className="relative">
          <select
            value={item.status}
            onChange={(e) => handleStatus(e.target.value as IntakeStatus)}
            className="h-7 pl-2 pr-6 text-xs font-medium rounded border border-slate-200 bg-white appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
        </div>

        {/* Assignee */}
        <div className="relative">
          <select
            value={item.assignedTo}
            onChange={(e) => handleAssignee(e.target.value)}
            className="h-7 pl-2 pr-6 text-xs font-medium rounded border border-slate-200 bg-white appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {ASSIGNEE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
        </div>

        <div className="flex-1" />

        {/* Delete */}
        <button
          onClick={handleDelete}
          className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors"
          title="Delete"
        >
          <Trash2 className="size-3.5" />
        </button>

        {/* Primary action — source-aware */}
        {isIvan && isActive && (
          <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={handleBuildLoad}>
            Build Load
          </Button>
        )}
        {!isIvan && isActive && (
          <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={handleMarkDone}>
            Mark as Done
          </Button>
        )}
        {item.status === 'BUILT' && (
          <span className="text-xs text-emerald-700 font-medium">Built</span>
        )}
        {item.status === 'DONE' && (
          <span className="text-xs text-slate-500 font-medium">Done</span>
        )}
        {item.status === 'ARCHIVED' && (
          <span className="text-xs text-slate-400 font-medium">Archived</span>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        {/* PDF preview */}
        {item.s3KeyPdfAttachments?.length > 0 && (
          <div className="border-b border-slate-100">
            {item.s3KeyPdfAttachments.length > 1 && (
              <div className="flex gap-1 px-4 pt-2 overflow-x-auto">
                {item.s3KeyPdfAttachments.map((key, i) => (
                  <button
                    key={key}
                    onClick={() => setActivePdf(i)}
                    className={cn(
                      'shrink-0 text-[11px] px-2 py-1 rounded border transition-colors',
                      i === activePdf
                        ? 'bg-sky-50 border-sky-200 text-sky-700'
                        : 'bg-white border-slate-200 text-muted-foreground hover:border-slate-300',
                    )}
                  >
                    {key.split('/').pop()}
                  </button>
                ))}
              </div>
            )}

            <div className="p-4">
              {pdfLoading ? (
                <div className="flex items-center justify-center h-48 text-muted-foreground text-sm gap-2">
                  <Loader2 className="size-4 animate-spin" /> Loading PDF…
                </div>
              ) : pdfUrls[activePdf] ? (
                <div className="relative">
                  <iframe
                    src={pdfUrls[activePdf]}
                    className="w-full h-[420px] rounded border border-slate-200"
                    title="PDF preview"
                  />
                  <a
                    href={pdfUrls[activePdf]}
                    target="_blank"
                    rel="noreferrer"
                    className="absolute top-2 right-2 bg-white/80 backdrop-blur rounded p-1 text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground py-4 text-center">PDF not available</p>
              )}
            </div>
          </div>
        )}

        {/* Message body */}
        <div className="px-6 py-5 space-y-4">
          {item.bodyText && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                {isSlack ? 'Slack Message' : 'Email Body'}
              </p>
              <pre className="text-xs text-foreground whitespace-pre-wrap font-sans leading-relaxed bg-slate-50 rounded-lg border border-slate-100 p-4 max-h-48 overflow-y-auto">
                {item.bodyText}
              </pre>
            </div>
          )}

          {/* Notes */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Notes
              </p>
              {savingNotes && (
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="size-2.5 animate-spin" /> saving
                </span>
              )}
            </div>
            <textarea
              value={notes}
              onChange={(e) => handleNotes(e.target.value)}
              placeholder="Add notes…"
              rows={4}
              className="w-full text-xs rounded-lg border border-slate-200 px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-slate-400"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
