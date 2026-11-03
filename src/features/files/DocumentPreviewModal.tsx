import { useEffect, useState } from 'react'
import { Download, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { isPdfKey, isImageKey, isUnembeddableKey } from '@/lib/filePacketPdf'
import { downloadFromUrl } from '@/lib/download'
import type { ComplianceDocument } from '@/types'
import { errorText } from '@/lib/errorText'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'

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
    if (!doc.s3Key) return
    getUrl(doc.s3Key)
      .then((u) => { if (alive) { setUrl(u); setError(null) } })
      .catch((err) => { if (alive) setError(errorText(err)) })
    return () => { alive = false }
  }, [doc.s3Key, getUrl])

  const fetchError = !doc.s3Key ? 'This item has no file attached.' : error

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

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      className="tms-dialog-xl"
      title={doc.title}
      description={`${filename}${doc.expirationDate ? ` · expires ${doc.expirationDate.slice(0, 10)}` : ''}`}
      footer={(
        <>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" className="tms-btn tms-btn-secondary" style={{ textDecoration: 'none' }}>
              <ExternalLink size={14} /> New tab
            </a>
          )}
          <TmsButton variant="primary" onClick={() => void download()} disabled={!url || saving} style={{ cursor: saving ? 'wait' : undefined }}>
            <Download size={14} /> {saving ? 'Downloading…' : 'Download'}
          </TmsButton>
        </>
      )}
    >
      <div style={{ height: '68vh', background: 'var(--tms-surface)', borderRadius: 'var(--tms-radius)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
        {fetchError ? (
          <div style={{ fontSize: 13, color: 'var(--tms-badge-red)', padding: 24, textAlign: 'center' }}>Couldn't open this document: {fetchError}</div>
        ) : !url ? (
          <div style={{ fontSize: 13, color: 'var(--tms-muted)' }}>Loading…</div>
        ) : isUnembeddableKey(key) ? (
          <div style={{ fontSize: 13, color: 'var(--tms-text-2)', padding: 24, textAlign: 'center', lineHeight: 1.6 }}>
            This is a HEIC photo, which browsers can't display.<br />
            <span style={{ color: 'var(--tms-muted)' }}>Download it to view — it opens fine on a Mac or iPhone.</span>
          </div>
        ) : isImageKey(key) ? (
          <img data-tms-paper src={url} alt={doc.title} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', background: 'var(--tms-paper)' }} />
        ) : canRender ? (
          <iframe data-tms-paper src={url} title={doc.title} style={{ width: '100%', height: '100%', border: 'none', background: 'var(--tms-paper)' }} />
        ) : (
          <div style={{ fontSize: 13, color: 'var(--tms-text-2)', padding: 24, textAlign: 'center' }}>
            This file type can't be previewed — download it to open.
          </div>
        )}
      </div>
    </TmsDialog>
  )
}
