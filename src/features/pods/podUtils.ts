import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle, Loader2, CheckCircle2, ImageIcon,
} from 'lucide-react'
import { getPodAssets } from '@/lib/podsClient'
import { graphqlErrorText } from '@/lib/apiClient'
import type { PodAssets, PodDocument } from '@/types/pods'

export function usePodAssets(doc: PodDocument) {
  const [assets, setAssets] = useState<PodAssets | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fetchedRef = useRef<string | null>(null)

  useEffect(() => {
    const sig = `${doc.id}:${doc.version}:${doc.processingStatus}`
    if (fetchedRef.current === sig) return
    fetchedRef.current = sig
    let alive = true
    getPodAssets(doc.id)
      .then((a) => { if (alive) { setAssets(a); setError(null) } })
      .catch((err) => { if (alive) setError(graphqlErrorText(err) || 'Could not load image') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [doc.id, doc.version, doc.processingStatus])

  return { assets, loading, error }
}

export function statusBadge(doc: PodDocument) {
  switch (doc.processingStatus) {
    case 'READY':
      return doc.scanReviewReason
        ? { label: 'Review scan', color: '#b45309', bg: '#fffbeb', icon: AlertCircle }
        : { label: 'Enhanced', color: '#15803d', bg: '#f0fdf4', icon: CheckCircle2 }
    case 'ORIGINAL_ONLY':
      return { label: 'Original only', color: '#0369a1', bg: '#f0f9ff', icon: ImageIcon }
    case 'PENDING':
      return { label: 'Processing…', color: '#b45309', bg: '#fffbeb', icon: Loader2 }
    case 'FAILED':
      return { label: 'Failed', color: '#b91c1c', bg: '#fef2f2', icon: AlertCircle }
    default:
      return { label: doc.processingStatus, color: 'var(--ds-t3)', bg: 'var(--ds-bg)', icon: AlertCircle }
  }
}

/**
 * Processing is normally done within seconds; a document still PENDING after the
 * backend's 5-minute lease window was never finished (e.g. an async invoke that
 * died) and needs a manual retry, which the backend accepts once the lease expired.
 * The clock is state (render stays pure) and only ticks while the row is pending.
 */
export function useStalePending(doc: PodDocument): boolean {
  const [now, setNow] = useState<number | null>(null)
  const pending = doc.processingStatus === 'PENDING'
  useEffect(() => {
    if (!pending) return
    const tick = () => setNow(Date.now())
    const id = setInterval(tick, 30_000)
    const first = setTimeout(tick, 0)
    return () => { clearInterval(id); clearTimeout(first) }
  }, [pending])
  return pending && now != null && now > Date.parse(doc.updatedAt) + 5 * 60_000
}

/** Human-readable sender line: "Lalo Cortez - +12247136044". */
export function senderLabel(doc: Pick<PodDocument, 'senderName' | 'senderContact'>): string {
  if (doc.senderName && doc.senderContact) return `${doc.senderName} - ${doc.senderContact}`
  return doc.senderName || doc.senderContact || 'Unknown sender'
}
