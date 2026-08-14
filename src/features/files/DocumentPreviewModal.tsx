import { useEffect, useState } from 'react'
import { X, Download, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { isPdfKey, isImageKey, isUnembeddableKey } from '@/lib/filePacketPdf'
import { downloadFromUrl } from '@/lib/download'
import type { ComplianceDocument } from '@/types'

/**
 * Look at a document without leaving the file.
 *
 * Previously the eye icon opened a new browser tab, which loses your place in the panel
 * and buries the file among other tabs. PDFs and images render here; HEIC can't be
 * displayed by any browser, so it says so plainly and offers the download rather than
 * showing an empty frame.
 */
export function DocumentPreviewModal({
  doc, getUrl, onClose,
}: {
  doc: ComplianceDocument
  getUrl: (s3Key: string) => Promise<string>
  onClose: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!doc.s3Key) { setError('This item has no file attached.'); return }
    getUrl(doc.s3Key)
      .then((u) => { if (alive) setUrl(u) })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)) })
    return () => { alive = false }
  }, [doc.s3Key, getUrl])

  const key = doc.s3Key ?? ''
  const filename = key.split('/').pop() ?? doc.title
  const canRender = isPdfKey(key) || isImageKey(key)

  const [saving, setSaving] = useState(false)

  // Same cross-origin trap as the Files tab: pointing <a download> at the presigned S3 URL
  // navigates instead of saving. Fetch the bytes and save a blob. See src/lib/download.ts.
  const download = async () => {
    if (!url || saving) return
    setSaving(true)
    try {
      await downloadFromUrl(url, filename)
    } catch (err) {
      toast.error(`Couldn't download ${filename}: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  const btn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 8,
    border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)',
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  }

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--ds-surface)', borderRadius: 14, width: 900, maxWidth: '96vw', height: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--ds-border)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {doc.title}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {filename}{doc.expirationDate ? ` · expires ${doc.expirationDate.slice(0, 10)}` : ''}
            </div>
          </div>
          <button onClick={() => void download()} disabled={!url || saving}
            style={{ ...btn, opacity: url ? 1 : 0.5, cursor: saving ? 'wait' : 'pointer' }}>
            <Download size={14} /> {saving ? 'Downloading…' : 'Download'}
          </button>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" style={{ ...btn, textDecoration: 'none' }}>
              <ExternalLink size={14} /> New tab
            </a>
          )}
          <button onClick={onClose} aria-label="Close" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, background: 'var(--ds-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
          {error ? (
            <div style={{ fontSize: 13, color: '#b91c1c', padding: 24, textAlign: 'center' }}>Couldn't open this document: {error}</div>
          ) : !url ? (
            <div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
          ) : isUnembeddableKey(key) ? (
            <div style={{ fontSize: 13, color: 'var(--ds-t2)', padding: 24, textAlign: 'center', lineHeight: 1.6 }}>
              This is a HEIC photo, which browsers can't display.<br />
              <span style={{ color: 'var(--ds-t3)' }}>Download it to view — it opens fine on a Mac or iPhone.</span>
            </div>
          ) : isImageKey(key) ? (
            <img src={url} alt={doc.title} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          ) : canRender ? (
            <iframe src={url} title={doc.title} style={{ width: '100%', height: '100%', border: 'none' }} />
          ) : (
            <div style={{ fontSize: 13, color: 'var(--ds-t2)', padding: 24, textAlign: 'center' }}>
              This file type can't be previewed — download it to open.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
