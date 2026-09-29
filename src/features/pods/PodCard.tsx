import { useEffect, useRef, useState } from 'react'
import {
  Eye, Download, Link2, Unlink, RotateCcw, FileText, ImageIcon,
  AlertCircle, Loader2, CheckCircle2,
} from 'lucide-react'
import { getPodAssets } from '@/lib/podsClient'
import { graphqlErrorText } from '@/lib/apiClient'
import { downloadFromUrl } from '@/lib/download'
import { formatDateTime } from '@/lib/date'
import type { PodAssets, PodDocument } from '@/types/pods'

function usePodAssets(doc: PodDocument) {
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

function statusBadge(doc: PodDocument) {
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

export function PodCard({
  doc,
  compact = false,
  onPreview,
  onAssign,
  onUnassign,
  onRetry,
  onViewLoad,
}: {
  doc: PodDocument
  compact?: boolean
  onPreview: (d: PodDocument) => void
  onAssign?: (d: PodDocument) => void
  onUnassign?: (d: PodDocument) => void
  onRetry?: (d: PodDocument) => void
  onViewLoad?: (loadId: string) => void
}) {
  const { assets, loading, error } = usePodAssets(doc)
  const badge = statusBadge(doc)
  const BadgeIcon = badge.icon

  // Thumbnails prefer the cleaned copy (always JPEG); originals only when the
  // browser can decode them — PDFs/HEIC would otherwise render as a broken image.
  const hasEnhanced = assets?.enhancedUrl && doc.processingStatus === 'READY'
  const originalIsImage = /^image\/(jpeg|png|webp|gif)/i.test(doc.contentType ?? '')
  const imageUrl = hasEnhanced ? assets?.enhancedUrl : originalIsImage ? assets?.originalUrl : undefined
  const canOpen = Boolean(assets?.originalUrl)
  // Processing is normally done within seconds; a document still PENDING after the
  // backend's 5-minute lease window was never finished (e.g. an async invoke that
  // died) and needs a manual retry, which the backend accepts once the lease expired.
  // The clock is state (render stays pure) and only ticks while the card is pending.
  const [now, setNow] = useState<number | null>(null)
  const pending = doc.processingStatus === 'PENDING'
  useEffect(() => {
    if (!pending) return
    const tick = () => setNow(Date.now())
    const id = setInterval(tick, 30_000)
    const first = setTimeout(tick, 0)
    return () => { clearInterval(id); clearTimeout(first) }
  }, [pending])
  const isStalePending = pending && now != null && now > Date.parse(doc.updatedAt) + 5 * 60_000

  return (
    <div
      style={{
        border: '1px solid var(--ds-border)',
        borderRadius: 12,
        background: 'var(--ds-surface)',
        boxShadow: 'var(--sh-sm)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: compact ? 'column' : 'row',
      }}
    >
      {/* Thumbnail */}
      <button
        onClick={() => onPreview(doc)}
        disabled={!canOpen}
        style={{
          width: compact ? '100%' : 180,
          minHeight: compact ? 160 : 140,
          flexShrink: 0,
          background: 'var(--ds-bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: canOpen ? 'pointer' : 'default',
          border: 'none',
          padding: 0,
          position: 'relative',
        }}
      >
        {loading ? (
          <Loader2 size={24} style={{ color: 'var(--ds-t3)', animation: 'spin 1s linear infinite' }} />
        ) : error || !imageUrl ? (
          <div style={{ textAlign: 'center', color: 'var(--ds-t3)' }}>
            <FileText size={32} style={{ margin: '0 auto 6px' }} />
            <div style={{ fontSize: 11 }}>{error || (canOpen ? 'Open to download' : 'No preview')}</div>
          </div>
        ) : (
          <img
            src={imageUrl}
            alt={doc.fileName}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
        {hasEnhanced && (
          <span
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              padding: '3px 7px',
              borderRadius: 999,
              background: '#f0fdf4',
              color: '#15803d',
            }}
          >
            Enhanced
          </span>
        )}
      </button>

      {/* Body */}
      <div style={{ flex: 1, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {doc.companyName || 'Unknown company'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ds-t2)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: doc.isAllowed ? '#16a34a' : '#dc2626',
                  }}
                  title={doc.isAllowed ? 'Active sender' : 'Inactive sender'}
                />
                {doc.senderName || doc.senderContact || 'Unknown sender'}
              </span>
              {!doc.senderName && doc.senderContact && (
                <span style={{ color: 'var(--ds-t3)' }}>({doc.senderContact})</span>
              )}
            </div>
          </div>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontWeight: 600,
              padding: '3px 8px',
              borderRadius: 999,
              background: badge.bg,
              color: badge.color,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <BadgeIcon size={12} className={doc.processingStatus === 'PENDING' ? 'animate-spin' : undefined} />
            {badge.label}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: '4px 16px', fontSize: 12, color: 'var(--ds-t2)' }}>
          <div>
            <span style={{ color: 'var(--ds-t3)' }}>Reference: </span>
            {doc.referenceNumber || '—'}
          </div>
          <div>
            <span style={{ color: 'var(--ds-t3)' }}>Received: </span>
            {formatDateTime(doc.receivedAt)}
          </div>
          {doc.notes && (
            <div style={{ gridColumn: compact ? undefined : '1 / -1', color: 'var(--ds-t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {doc.notes}
            </div>
          )}
        </div>

        {doc.processingError && (
          <div style={{ fontSize: 11, color: '#b91c1c', background: '#fef2f2', padding: '6px 10px', borderRadius: 8 }}>
            {doc.processingError}
          </div>
        )}

        {doc.loadId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ color: 'var(--ds-t3)' }}>Assigned to load</span>
            {onViewLoad ? (
              <button
                onClick={() => onViewLoad(doc.loadId!)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: 'var(--ds-blue)',
                  fontWeight: 600,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <Link2 size={12} /> {doc.loadId.slice(-6)}
              </button>
            ) : (
              <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--ds-t2)' }}>{doc.loadId.slice(-6)}</span>
            )}
          </div>
        )}

        {doc.scanReviewReason && (
          <div className="text-xs text-amber-800 bg-amber-50 rounded-md px-2 py-1.5">
            Review scan: {doc.scanReviewReason}
          </div>
        )}
        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 6 }}>
          <PodActionBtn onClick={() => onPreview(doc)} icon={<Eye size={13} />} label="View" />
          {assets?.originalUrl && (
            <PodDownloadBtn url={assets.originalUrl} filename={doc.fileName} label="Original" />
          )}
          {assets?.enhancedUrl && doc.processingStatus === 'READY' && (
            <PodDownloadBtn url={assets.enhancedUrl} filename={`${doc.fileName}.enhanced.jpg`} label="Enhanced" />
          )}
          {(doc.processingStatus === 'FAILED' || isStalePending) && onRetry && (
            <PodActionBtn onClick={() => onRetry(doc)} icon={<RotateCcw size={13} />} label="Retry" />
          )}
          {doc.loadId ? (
            onUnassign && (
              <PodActionBtn onClick={() => onUnassign(doc)} icon={<Unlink size={13} />} label="Unassign" />
            )
          ) : (
            onAssign && (
              <PodActionBtn onClick={() => onAssign(doc)} icon={<Link2 size={13} />} label="Assign" />
            )
          )}
        </div>
      </div>
    </div>
  )
}

function PodActionBtn({
  onClick,
  icon,
  label,
  danger = false,
}: {
  onClick: () => void
  icon: React.ReactNode
  label: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 28,
        padding: '0 10px',
        borderRadius: 7,
        border: '1px solid var(--ds-border)',
        background: 'var(--ds-surface)',
        color: danger ? '#dc2626' : 'var(--ds-t2)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {icon} {label}
    </button>
  )
}

function PodDownloadBtn({ url, filename, label }: { url: string; filename: string; label: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      onClick={async () => {
        setBusy(true)
        try {
          await downloadFromUrl(url, filename)
        } catch {
          // download.ts already surfaces a toast; avoid duplicate noise
        } finally {
          setBusy(false)
        }
      }}
      disabled={busy}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 28,
        padding: '0 10px',
        borderRadius: 7,
        border: '1px solid var(--ds-border)',
        background: 'var(--ds-surface)',
        color: 'var(--ds-blue)',
        fontSize: 12,
        fontWeight: 600,
        cursor: busy ? 'wait' : 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      {label}
    </button>
  )
}


