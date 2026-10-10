import { useEffect, useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import type { DispatchMedia } from '@/lib/dispatch'

const urlCache = new Map<string, Promise<string>>()

/** A picture or file in a bubble; the signed link is fetched once per key per page load. */
export function MediaThumb({ media, getUrl }: { media: DispatchMedia; getUrl: (key: string) => Promise<string> }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let p = urlCache.get(media.key)
    if (!p) { p = getUrl(media.key); urlCache.set(media.key, p) }
    p.then((u) => { if (alive) setUrl(u) }).catch(() => { urlCache.delete(media.key); if (alive) setFailed(true) })
    return () => { alive = false }
  }, [media.key, getUrl])

  const isImage = media.contentType.startsWith('image/')
  if (failed) return <span style={{ fontSize: 12, color: 'var(--ds-red)' }}>Could not load attachment</span>
  if (!url) return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ds-t3)' }}><Loader2 className="size-3.5 animate-spin" /> Loading…</span>
  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noreferrer" style={{ display: 'block' }}>
        <img src={url} alt="Attachment" style={{ maxWidth: 240, maxHeight: 240, borderRadius: 8, display: 'block', objectFit: 'cover' }} />
      </a>
    )
  }
  if (media.contentType === 'application/pdf') {
    // A real first-page preview; the click opens the full document.
    return (
      <a href={url} target="_blank" rel="noreferrer" title="Open PDF" style={{ display: 'block', width: 200, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--ds-border)', background: '#fff' }}>
        <iframe src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`} title="PDF preview" style={{ width: 200, height: 240, border: 'none', pointerEvents: 'none', display: 'block' }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 8px', color: 'var(--ds-t2)', borderTop: '1px solid var(--ds-border)' }}><FileText className="size-3.5" /> {media.name ?? 'PDF'} · open</span>
      </a>
    )
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, textDecoration: 'underline' }}>
      <FileText className="size-4" /> {media.name ?? media.contentType.split('/')[1]?.toUpperCase() ?? 'File'}
    </a>
  )
}

/** A file picked in the composer, previewed before it is sent. */
export function PendingFilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  // Object URL made once per file; revoked when the preview goes away.
  const [url] = useState(() => URL.createObjectURL(file))
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  const isImage = file.type.startsWith('image/')
  return (
    <span style={{ position: 'relative', display: 'inline-block', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--ds-border)', background: 'var(--ds-bg-2)' }}>
      {url && isImage ? <img src={url} alt={file.name} style={{ width: 72, height: 72, objectFit: 'cover', display: 'block' }} />
        : url && file.type === 'application/pdf' ? <iframe src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`} title={file.name} style={{ width: 72, height: 72, border: 'none', pointerEvents: 'none', display: 'block', background: '#fff' }} />
        : <span style={{ width: 72, height: 72, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><FileText className="size-5" /></span>}
      <span title={file.name} style={{ display: 'block', fontSize: 10, padding: '2px 4px', maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ds-t3)' }}>{file.name}</span>
      <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove} style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: 9, border: 'none', background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', fontSize: 11, lineHeight: '18px', padding: 0 }}>×</button>
    </span>
  )
}

/** Voicemail player; the signed link is fetched on first play. */
export function VoicemailPlayer({ recordingKey, getUrl }: { recordingKey: string; getUrl: (key: string) => Promise<string> }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let p = urlCache.get(recordingKey)
    if (!p) { p = getUrl(recordingKey); urlCache.set(recordingKey, p) }
    p.then((u) => { if (alive) setUrl(u) }).catch(() => { urlCache.delete(recordingKey) })
    return () => { alive = false }
  }, [recordingKey, getUrl])
  if (!url) return <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Loading voicemail…</span>
  return <audio controls preload="none" src={url} style={{ width: '100%', maxWidth: 320, height: 36 }} />
}
