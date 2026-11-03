/**
 * Preview one POD or rate confirmation, without leaving the page you found it on.
 *
 * Every surface that shows a document used to offer the same thing: a link that opened a
 * presigned URL in a new tab. That is not a preview — it loses the page you were on, it is
 * eaten by popup blockers on a locked-down laptop, and it gives you no way to say "that is
 * the wrong page, take it off". The one question someone actually has in front of a POD is
 * "is this the right document, the right way up, all the pages?" — which needs the document
 * on screen and a way to replace it when the answer is no.
 *
 * Deliberately one component for the shipment Documents tab, the calendar paperwork cell,
 * the factoring queue and the settlement rows: the same document is reached from all of
 * them, and separate previews would drift until they disagreed about what is on file.
 *
 * It is a `TmsDialog` (size xl): Radix portals it under `.tms-portal`, so it follows the
 * active TMS theme wherever it is opened from, including the legacy calendar page.
 */
import { useRef, useState } from 'react'
import { Download, Loader2, RefreshCw, Trash2, FileText, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { downloadPodAsPdf } from '@/lib/podDownload'

export interface DocumentPreviewProps {
  open: boolean
  onClose: () => void
  /** "POD · PRO 14559" — says which document, on which shipment. */
  title: string
  /** Presigned, already pointing at the enhanced copy where one exists. Null while it loads. */
  url: string | null
  contentType?: string | null
  /** Base name for the download; the extension is set by the download itself. */
  downloadName: string
  /** Shown under the title: how many pages, and whether this is the cleaned copy. */
  subtitle?: string
  /** Omitted where the viewer may not change the document (a driver looking at staff paperwork). */
  onReplace?: (files: File[]) => Promise<void>
  onRemove?: () => Promise<void>
  /** Mirrors the upload control's accept list so a replace cannot smuggle in a new type. */
  accept?: string
}

function isPdf(contentType: string | null | undefined, url: string | null): boolean {
  return /pdf/i.test(contentType ?? '') || /\.pdf(\?|$)/i.test(url ?? '')
}

function isImage(contentType: string | null | undefined): boolean {
  return !!contentType && /^image\//i.test(contentType)
}

export function DocumentPreview({
  open, onClose, title, url, contentType, downloadName, subtitle,
  onReplace, onRemove, accept,
}: DocumentPreviewProps) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'download' | 'replace' | 'remove' | null>(null)

  if (!open) return null

  async function run(kind: 'download' | 'replace' | 'remove', fn: () => Promise<void>) {
    setBusy(kind)
    try {
      await fn()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work')
    } finally {
      setBusy(null)
    }
  }

  const pdf = isPdf(contentType, url)
  const image = isImage(contentType)

  const footer = (
    <>
      <TmsButton
        disabled={!url || busy !== null}
        onClick={() => void run('download', () => downloadPodAsPdf(url!, downloadName))}
      >
        {busy === 'download' ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />}
        Download PDF
      </TmsButton>

      {onReplace && (
        <TmsButton disabled={busy !== null} onClick={() => input.current?.click()}>
          {busy === 'replace' ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
          Replace
        </TmsButton>
      )}

      {onRemove && (
        <TmsButton
          variant="destructive"
          disabled={busy !== null}
          onClick={() => {
            // A POD holds the driver's pay and the invoice. Taking one off is never
            // a slip of the mouse.
            if (!window.confirm(`Remove this document?\n\n${title}\n\nIt stops counting straight away. You can upload a new one in its place.`)) return
            void run('remove', async () => {
              await onRemove()
              onClose()
            })
          }}
        >
          {busy === 'remove' ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />}
          Remove
        </TmsButton>
      )}

      <input
        ref={input}
        type="file"
        multiple
        accept={accept}
        className="tms-docprev-file"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (!picked.length || !onReplace) return
          void run('replace', async () => {
            await onReplace(picked)
            onClose()
          })
        }}
      />
    </>
  )

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title={title}
      description={subtitle}
      className="tms-dialog-xl tms-docprev"
      footer={footer}
    >
      <div className="tms-docprev-stage" data-tms-paper>
        {!url ? (
          <div className="tms-docprev-center">
            <Loader2 className="animate-spin" size={20} />
            <span className="text-sm">Opening the document…</span>
          </div>
        ) : pdf ? (
          <iframe src={url} title={title} className="tms-docprev-frame" />
        ) : image ? (
          <img src={url} alt={title} className="tms-docprev-img" />
        ) : (
          /*
           * A type no browser will render inline — a HEIC off an iPhone, a TIFF off a
           * fax. Saying so and offering the file beats an empty grey box that reads as
           * a broken upload.
           */
          <div className="tms-docprev-center tms-docprev-unsupported">
            <FileText size={28} className="tms-muted" />
            <p className="text-sm tms-muted">
              This file type cannot be shown in the browser. Download it to check it, or
              replace it with a photo or PDF.
            </p>
            <a href={url} target="_blank" rel="noreferrer" className="tms-link tms-docprev-open">
              Open in a new tab <ExternalLink size={12} />
            </a>
          </div>
        )}
      </div>
    </TmsDialog>
  )
}
