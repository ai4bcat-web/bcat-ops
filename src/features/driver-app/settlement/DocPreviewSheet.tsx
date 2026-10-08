/**
 * A driver looking at the document they sent.
 *
 * Built for a phone rather than reusing the office preview: full-bleed, big targets, and
 * the three things a driver actually wants in order — see it, send a different one, take
 * it off. A PDF goes in an iframe, which every phone browser renders; an image goes in an
 * <img>, which beats an iframe on iOS.
 *
 * Removing is behind a confirm because a POD is what releases the load onto their check.
 * The wording says that out loud rather than asking "are you sure?" about nothing.
 */
import { useEffect, useState } from 'react'
import { X, Download, Upload, Trash2, Loader2, AlertTriangle, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchDocUrl, removeSubmissionDocs, type SubmissionKind } from '../driverApi'
import { downloadPodAsPdf } from '@/lib/podDownload'
import type { TripDoc } from './useTripDocs'

const LABEL: Record<SubmissionKind, string> = { POD: 'POD', RATECON: 'Rate confirmation', MISC: 'Photo' }

export function DocPreviewSheet({
  doc, kind, shipment, onClose, onReplace, onAddPages, onRemoved,
}: {
  doc: TripDoc
  kind: SubmissionKind
  /** The PRO, so the driver can see they are looking at the right shipment. */
  shipment: string
  onClose: () => void
  onReplace: () => void
  /** Keep what is there and add more pages to it. */
  onAddPages: () => void
  onRemoved: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'download' | 'remove' | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchDocUrl(doc.submissionId, doc.document.docId)
      .then((u) => { if (!cancelled) setUrl(u) })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not open that document')
      })
    return () => { cancelled = true }
  }, [doc.submissionId, doc.document.docId])

  const pdf = /pdf/i.test(doc.document.contentType || '') || doc.document.combined
  const pages = doc.document.pageCount > 1 ? `${doc.document.pageCount} pages · ` : ''
  const quality = doc.document.enhanced ? 'cleaned up for the office' : 'as you sent it'

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Over the tab bar and under the status bar, so both insets are this sheet's to pay. */}
      <header
        className="flex items-start gap-3 border-b border-border px-4 py-3"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 0.75rem)' }}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {LABEL[kind]} · {shipment}
          </p>
          <p className="truncate text-xs text-muted-foreground">{pages}{quality}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md border border-border p-1.5 text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-auto bg-muted/40">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <AlertTriangle className="h-6 w-6 text-amber-300" />
            <p className="text-sm text-foreground">{error}</p>
          </div>
        ) : !url ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <p className="text-sm">Opening it…</p>
          </div>
        ) : pdf ? (
          <iframe src={url} title={`${LABEL[kind]} for ${shipment}`} className="h-full w-full border-0 bg-white" />
        ) : (
          <img src={url} alt={`${LABEL[kind]} for ${shipment}`} className="mx-auto block max-w-full bg-white" />
        )}
      </div>

      <footer
        className="grid grid-cols-2 gap-2 border-t border-border p-3"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!url || busy !== null}
          onClick={() => {
            setBusy('download')
            void downloadPodAsPdf(url!, `${kind === 'POD' ? 'POD' : 'RateCon'}-${shipment}`)
              .catch(() => setError('Could not download that document'))
              .finally(() => setBusy(null))
          }}
        >
          {busy === 'download' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Save
        </Button>

        {/*
          * Adding is not replacing. A driver who finds a second sheet in the cab wants it
          * ON the POD they already sent, not instead of it — and the server puts further
          * pages onto the submission this shipment already has, so the office still ends
          * up with one document.
          */}
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={onAddPages}>
          <Plus className="h-3.5 w-3.5" />
          Add pages
        </Button>

        {/*
          * Replace takes the old one off and opens the upload screen in one move. Leaving
          * both on would mean the office has two PODs for one shipment and no way to tell
          * which the driver meant, which is worse than the wrong one being on its own.
          */}
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            if (!window.confirm(`Send a different ${LABEL[kind].toLowerCase()} for ${shipment}?\n\nThis one comes off and you will be taken to the upload screen.`)) return
            setBusy('remove')
            void removeSubmissionDocs(doc.submissionId, kind)
              .then(() => onReplace())
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : 'Could not remove that document')
              })
              .finally(() => setBusy(null))
          }}
        >
          <Upload className="h-3.5 w-3.5" />
          Replace
        </Button>

        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          className="text-red-400"
          onClick={() => {
            const warning =
              kind === 'POD'
                ? `Take this POD off ${shipment}?\n\nThis load goes back to waiting on a POD and comes off your check until you send another one.`
                : `Take this rate confirmation off ${shipment}?`
            if (!window.confirm(warning)) return
            setBusy('remove')
            void removeSubmissionDocs(doc.submissionId, kind)
              .then(() => onRemoved())
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : 'Could not remove that document')
              })
              .finally(() => setBusy(null))
          }}
        >
          {busy === 'remove' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          Remove
        </Button>
      </footer>
    </div>
  )
}
