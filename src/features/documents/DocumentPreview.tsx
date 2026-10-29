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
 * It renders in place rather than through a portal, so it inherits whichever theme its
 * host page defines: inside `.tms-shell` the `--tms-*` tokens resolve and it is dark;
 * on the existing BCAT Ops pages those tokens are undefined and the `--ds-*` fallbacks
 * keep it exactly as it was.
 */
import { useRef, useState } from 'react'
import { Download, Loader2, RefreshCw, Trash2, X, FileText, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
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

/** Theme-following tokens: the TMS shell's value, else the app's own. */
const SURFACE = 'var(--tms-card, var(--ds-surface))'
const BORDER = 'var(--tms-border, var(--ds-border))'
const BG = 'var(--tms-bg, var(--ds-bg))'
const TEXT = 'var(--tms-text, var(--ds-t1))'
const MUTED = 'var(--tms-muted, var(--ds-t2))'
const FAINT = 'var(--tms-muted, var(--ds-t3))'
const DANGER = 'var(--tms-badge-red, #dc2626)'

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  height: 32, padding: '0 12px', borderRadius: 4, fontSize: 13, fontWeight: 500,
  border: `1px solid ${BORDER}`, background: BG, color: TEXT,
  cursor: 'pointer', fontFamily: 'inherit',
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(8,8,8,0.62)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex', flexDirection: 'column',
          width: 'min(900px, 100%)', maxHeight: '92vh',
          borderRadius: 6, overflow: 'hidden',
          background: SURFACE, border: `1px solid ${BORDER}`,
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
          color: TEXT,
        }}
      >
        <header
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 12,
            padding: '12px 14px', borderBottom: `1px solid ${BORDER}`,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: TEXT }}>{title}</p>
            {subtitle && (
              <p style={{ margin: '2px 0 0', fontSize: 12, color: MUTED }}>{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the preview"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${BORDER}`, background: BG,
              color: MUTED,
            }}
          >
            <X size={15} />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 320, overflow: 'auto', background: BG }}>
          {!url ? (
            <div style={{ display: 'grid', placeItems: 'center', height: 360, gap: 8, color: MUTED }}>
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
              <FileText size={28} style={{ color: FAINT }} />
              <p style={{ margin: 0, fontSize: 13, color: MUTED, maxWidth: 420 }}>
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
            padding: '10px 14px', borderTop: `1px solid ${BORDER}`,
          }}
        >
          <button
            type="button"
            style={buttonStyle}
            disabled={!url || busy !== null}
            onClick={() => void run('download', () => downloadPodAsPdf(url!, downloadName))}
          >
            {busy === 'download' ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />}
            Download PDF
          </button>

          {onReplace && (
            <button
              type="button"
              style={buttonStyle}
              disabled={busy !== null}
              onClick={() => input.current?.click()}
            >
              {busy === 'replace' ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
              Replace
            </button>
          )}

          {onRemove && (
            <button
              type="button"
              style={{ ...buttonStyle, color: DANGER }}
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
            </button>
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
