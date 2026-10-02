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
 * Deliberately one component for the Loads drawer, the factoring queue and the settlement
 * rows: the same document is reached from all three, and three different previews would
 * drift until they disagreed about what is on file.
 */
import { useRef, useState } from 'react'
import { Download, Loader2, RefreshCw, Trash2, X, FileText, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { downloadPodAsPdf } from '@/lib/podDownload'

export interface DocumentPreviewProps {
  open: boolean
  onClose: () => void
  /** "POD · PRO 14559" — says which document, on which load. */
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
  if (contentType) return /pdf/i.test(contentType)
  return !!url && /\.pdf(\?|$)/i.test(url)
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex', flexDirection: 'column',
          width: 'min(900px, 100%)', maxHeight: '92vh',
          borderRadius: 12, overflow: 'hidden',
          background: 'var(--ds-surface)', border: '1px solid var(--ds-border)',
          boxShadow: '0 24px 60px rgba(15,23,42,0.35)',
        }}
      >
        <header
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 12,
            padding: '12px 14px', borderBottom: '1px solid var(--ds-border)',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)' }}>{title}</p>
            {subtitle && (
              <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--ds-t2)' }}>{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the preview"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--ds-border)', background: 'var(--ds-bg)',
              color: 'var(--ds-t2)',
            }}
          >
            <X size={15} />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 320, overflow: 'auto', background: 'var(--ds-bg)' }}>
          {!url ? (
            <div style={{ display: 'grid', placeItems: 'center', height: 360, gap: 8, color: 'var(--ds-t2)' }}>
              <Loader2 className="animate-spin" size={20} />
              <span style={{ fontSize: 13 }}>Opening the document…</span>
            </div>
          ) : pdf ? (
            <iframe
              src={url}
              title={title}
              style={{ display: 'block', width: '100%', height: '70vh', border: 0, background: '#fff' }}
            />
          ) : image ? (
            <img
              src={url}
              alt={title}
              style={{ display: 'block', maxWidth: '100%', margin: '0 auto', background: '#fff' }}
            />
          ) : (
            /*
             * A type no browser will render inline — a HEIC off an iPhone, a TIFF off a
             * fax. Saying so and offering the file beats an empty grey box that reads as
             * a broken upload.
             */
            <div style={{ display: 'grid', placeItems: 'center', height: 360, gap: 10, padding: 24, textAlign: 'center' }}>
              <FileText size={28} style={{ color: 'var(--ds-t3)' }} />
              <p style={{ margin: 0, fontSize: 13, color: 'var(--ds-t2)', maxWidth: 420 }}>
                This file type cannot be shown in the browser. Download it to check it, or
                replace it with a photo or PDF.
              </p>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                Open in a new tab <ExternalLink size={12} />
              </a>
            </div>
          )}
        </div>

        <footer
          style={{
            display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
            padding: '10px 14px', borderTop: '1px solid var(--ds-border)',
          }}
        >
          <Button
            size="sm"
            variant="outline"
            disabled={!url || busy !== null}
            onClick={() => void run('download', () => downloadPodAsPdf(url!, downloadName))}
          >
            {busy === 'download' ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            Download PDF
          </Button>

          {onReplace && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => input.current?.click()}
            >
              {busy === 'replace' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Replace
            </Button>
          )}

          {onRemove && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              className="text-red-600 hover:text-red-700"
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
              {busy === 'remove' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Remove
            </Button>
          )}

          <input
            ref={input}
            type="file"
            multiple
            accept={accept}
            style={{ display: 'none' }}
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
        </footer>
      </div>
    </div>
  )
}
