/**
 * Paperwork a driver sent from their phone, shown on the load it belongs to.
 *
 * The drawer used to read only the rate confirmation on the Load row and the PODs JobsDone
 * had linked. A driver could scan a POD at a dock, watch it reach Slack, see it in their
 * own app — and the office would still see an empty slot and chase them for it. This is
 * that missing half, for both document kinds.
 *
 * It used to be read-only, with a link that opened a presigned URL in a new tab. That is
 * the one thing it should not be: the reason anyone opens a POD here is to check it is the
 * right document the right way up, and the next thing they want after "no, that is the
 * bill of lading for the wrong stop" is to take it off and put the right one on. So the
 * row opens a preview, and the preview can replace or remove.
 */
import { useState } from 'react'
import { FileText, Loader2, AlertTriangle, Eye, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { useLoadDriverDocs, type LoadDriverDoc } from '@/hooks/useLoadDriverDocs'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import {
  removeDriverDocs,
  replaceDriverDocs,
  DRIVER_DOC_ACCEPT,
} from '@/lib/driverSubmissionsClient'
import { queueDriverDocScan } from '@/lib/podsClient'
import { useAuthUser } from '@/hooks/useAuth'

const SOURCE_LABEL: Record<string, string> = {
  PWA: 'from the driver app',
  EMAIL: 'forwarded by email',
  STAFF: 'uploaded by staff',
}

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/**
 * Whether this document has actually been through the cleanup and come out as one PDF.
 *
 * Two things have to be true, and they are separate: every page has been looked at, and
 * they have been merged. A document that is still loose pages, or whose pages were parked
 * ORIGINAL_ONLY under older rules, is one somebody should be able to put right from here
 * rather than by asking a driver to send it again.
 */
function needsScanning(doc: LoadDriverDoc): boolean {
  if (doc.cleaning) return false
  if (doc.scanStatus === 'FAILED') return true
  // pageNumber is null only on the combined document this hook synthesises.
  const combined = doc.pageNumber === null
  return !combined || !doc.enhanced
}

/** "3 pages · cleaned scan" — what the preview is actually showing you. */
function describe(doc: LoadDriverDoc): string {
  const bits: string[] = []
  if (doc.pageCount > 1) bits.push(`${doc.pageCount} pages`)
  // The cleanup runs after the upload returns, so this is a normal first state rather than
  // a problem. The document is already readable; it just is not the finished copy yet.
  if (doc.cleaning) bits.push('cleaning up…')
  else if (doc.enhanced) bits.push('cleaned scan')
  else if (doc.scanStatus === 'FAILED') bits.push('original only — the cleanup did not run')
  return bits.join(' · ')
}

export function LoadDriverDocs({
  loadId, proNumber, kind,
}: {
  loadId: string | null | undefined
  proNumber: string | null | undefined
  kind: 'POD' | 'RATECON'
}) {
  const { pods, ratecons, loading, error, refresh } = useLoadDriverDocs(loadId, proNumber)
  const user = useAuthUser()
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [scanning, setScanning] = useState<string | null>(null)

  /**
   * Run the cleanup over a document that never had it.
   *
   * The same queued pass a fresh upload gets: every page cleaned, then merged into the one
   * PDF everything downstream reads. Queued rather than awaited, so this returns as soon as
   * the work is handed off and the row polls until it lands.
   */
  async function runScan(doc: LoadDriverDoc): Promise<void> {
    setScanning(doc.submissionId)
    try {
      await queueDriverDocScan(doc.submissionId, kind)
      toast.success('Cleaning it up — the finished PDF appears here in a moment')
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the cleanup')
    } finally {
      setScanning(null)
    }
  }
  const docs = kind === 'POD' ? pods : ratecons
  const open = docs.find((d) => d.id === previewing) ?? null

  if (error) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-amber-700">
        <AlertTriangle className="size-3" /> {error}
      </p>
    )
  }

  // Nothing sent is the normal case and needs no words; the upload control is right there.
  if (loading || docs.length === 0) return null

  const label = kind === 'POD' ? 'POD' : 'Rate confirmation'

  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <FileText className="size-3" />
        {kind === 'POD' ? 'Sent by the driver' : 'Rate con sent by the driver'}
        <span className="font-normal normal-case tracking-normal">({docs.length})</span>
      </p>
      <ul className="space-y-1.5">
        {docs.map((doc) => {
          const name = doc.fileName?.trim() || `${doc.kind} page ${doc.pageNumber ?? 1}`
          const who = SOURCE_LABEL[doc.source ?? 'PWA'] ?? 'from the driver app'
          const note = describe(doc)
          return (
            <li key={doc.id}>
              <button
                type="button"
                onClick={() => setPreviewing(doc.id)}
                aria-label={`Preview ${name}`}
                className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-foreground">{name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {doc.driverName} · {who} · {when(doc.uploadedAt)}
                    {note && (
                      <span
                        className={
                          doc.cleaning
                            ? 'text-muted-foreground'
                            : doc.enhanced
                              ? 'text-emerald-600'
                              : 'text-amber-700'
                        }
                      >
                        {' '}· {note}
                      </span>
                    )}
                  </span>
                </span>
                {doc.url ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-primary">
                    Preview <Eye className="size-3" />
                  </span>
                ) : (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
              </button>
              {/* Not scanned, or still loose pages: offer to put it right from here. */}
              {needsScanning(doc) && (
                <button
                  type="button"
                  disabled={scanning === doc.submissionId}
                  onClick={() => void runScan(doc)}
                  className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-primary disabled:opacity-50"
                >
                  {scanning === doc.submissionId ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Wand2 className="size-3" />
                  )}
                  Clean it up and combine into one PDF
                </button>
              )}
            </li>
          )
        })}
      </ul>

      {open && (
        <DocumentPreview
          open
          onClose={() => setPreviewing(null)}
          title={`${label} · PRO ${proNumber || '—'}`}
          subtitle={[open.driverName, describe(open)].filter(Boolean).join(' · ')}
          url={open.url}
          contentType={open.contentType}
          downloadName={`${kind === 'POD' ? 'POD' : 'RateCon'}-${proNumber || open.submissionId.slice(-6)}`}
          accept={DRIVER_DOC_ACCEPT}
          onReplace={async (files) => {
            await replaceDriverDocs({
              submissionId: open.submissionId,
              driver: { id: open.driverId, name: open.driverName, email: null },
              kind,
              files,
              submittedByEmail: user?.email ?? 'staff',
              referenceNumber: proNumber ?? undefined,
              loadId: loadId ?? undefined,
            })
            toast.success(`${label} replaced`)
            refresh()
          }}
          onRemove={async () => {
            await removeDriverDocs(open.submissionId, kind)
            toast.success(`${label} removed`)
            refresh()
          }}
        />
      )}
    </div>
  )
}
