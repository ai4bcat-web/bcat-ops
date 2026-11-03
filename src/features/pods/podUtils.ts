import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle, Loader2, CheckCircle2, ImageIcon,
} from 'lucide-react'
import { getPodAssets } from '@/lib/podsClient'
import { graphqlErrorText } from '@/lib/apiClient'
import type { Load } from '@/types'
import type { TmsTone } from '@/features/tms/kit/TmsBadge'
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
        ? { label: 'Review scan', tone: 'orange' as TmsTone, icon: AlertCircle }
        : { label: 'Enhanced', tone: 'green' as TmsTone, icon: CheckCircle2 }
    case 'ORIGINAL_ONLY':
      return { label: 'Original only', tone: 'blue' as TmsTone, icon: ImageIcon }
    case 'PENDING':
      return { label: 'Processing…', tone: 'orange' as TmsTone, icon: Loader2 }
    case 'FAILED':
      return { label: 'Failed', tone: 'red' as TmsTone, icon: AlertCircle }
    default:
      return { label: doc.processingStatus, tone: 'gray' as TmsTone, icon: AlertCircle }
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

/**
 * The identifier a dispatcher recognises for a shipment, in the order they'd say it out
 * loud. Falls back to the tail of the internal id so a linked load never renders blank.
 */
export function shipmentLabel(load: Load | undefined, loadId: string): string {
  if (!load) return `#${loadId.slice(-6)}`
  if (load.aljexId) return `Pro #${load.aljexId}`
  if (load.tmsId) return `TMS/PO ${load.tmsId}`
  if (load.pickupNumber) return `PU ${load.pickupNumber}`
  return `#${loadId.slice(-6)}`
}

/** "Chicago, IL -> Indianapolis, IN", or whichever half we actually know. */
export function shipmentRoute(load: Load | undefined): string {
  if (!load) return ''
  const from = load.originCity || load.originName || ''
  const to = load.destinationCity || load.destinationName || ''
  if (from && to) return `${from} → ${to}`
  return from || to
}
