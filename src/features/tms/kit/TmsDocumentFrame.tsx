import { Download } from 'lucide-react'
import { isPdfKey, isImageKey, isUnembeddableKey } from '@/lib/filePacketPdf'

export interface TmsDocumentFrameProps {
  /** `null` = loading. */
  url: string | null
  /** `null`/`''` = nothing attached. */
  fileKey: string | null
  title: string
  error?: string | null
  height?: number | string
  /** Renders a Download button in the frame corner when given. */
  onDownload?: () => void
  className?: string
}

/** The framed page preview: PDF/image on matte paper, or a plain message for what can't render. */
export function TmsDocumentFrame({ url, fileKey, title, error, height = 520, onDownload, className }: TmsDocumentFrameProps) {
  const key = fileKey ?? ''
  const fetchError = !key ? 'This item has no file attached.' : error
  return (
    <div className={`tms-docframe${className ? ` ${className}` : ''}`} style={{ height }}>
      {fetchError ? (
        <div className="tms-docframe-msg tms-docframe-error">
          {key ? `Couldn't open this document: ${fetchError}` : fetchError}
        </div>
      ) : !url ? (
        <div className="tms-docframe-msg tms-docframe-muted">Loading…</div>
      ) : isUnembeddableKey(key) ? (
        <div className="tms-docframe-msg">
          This is a HEIC photo, which browsers can't display.<br />
          <span className="tms-docframe-muted">Download it to view — it opens fine on a Mac or iPhone.</span>
        </div>
      ) : isImageKey(key) ? (
        <img data-tms-paper className="tms-docframe-media" src={url} alt={title} />
      ) : isPdfKey(key) ? (
        <iframe data-tms-paper className="tms-docframe-media tms-docframe-pdf" src={url} title={title} />
      ) : (
        <div className="tms-docframe-msg">This file type can't be previewed — download it to open.</div>
      )}
      {onDownload ? (
        <button type="button" className="tms-icon-btn tms-docframe-download" aria-label="Download" onClick={onDownload}>
          <Download size={14} />
        </button>
      ) : null}
    </div>
  )
}

export default TmsDocumentFrame
