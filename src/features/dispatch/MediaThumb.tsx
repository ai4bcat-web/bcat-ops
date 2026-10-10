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
  return (
    <a href={url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, textDecoration: 'underline' }}>
      <FileText className="size-4" /> {media.name ?? media.contentType.split('/')[1]?.toUpperCase() ?? 'File'}
    </a>
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
