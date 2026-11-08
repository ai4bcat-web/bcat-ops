import {
  Eye, Link2, Unlink, RotateCcw, FileText, Loader2,
} from 'lucide-react'
import { formatDateTime } from '@/lib/date'
import type { PodDocument } from '@/types/pods'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import { statusBadge, usePodAssets, useStalePending, senderLabel } from './podUtils'
import { PodActionBtn, PodDownloadBtn } from './PodShared'

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
  const isStalePending = useStalePending(doc)

  return (
    <div
      style={{
        border: '1px solid var(--tms-border)',
        borderRadius: 12,
        background: 'var(--tms-card)',
        boxShadow: 'var(--tms-shadow)',
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
          background: 'var(--tms-bg)',
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
          <Loader2 size={24} style={{ color: 'var(--tms-muted)', animation: 'spin 1s linear infinite' }} />
        ) : error || !imageUrl ? (
          <div style={{ textAlign: 'center', color: 'var(--tms-muted)' }}>
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
              background: 'var(--tms-badge-green-tint)',
              color: 'var(--tms-badge-green)',
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
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {doc.companyName || 'Unknown company'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--tms-text-2)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: doc.isAllowed ? 'var(--tms-badge-green)' : 'var(--tms-badge-red)',
                  }}
                  title={doc.isAllowed ? 'Active sender' : 'Inactive sender'}
                />
                {senderLabel(doc)}
              </span>
            </div>
          </div>
          <TmsBadge tone={badge.tone} style={{ flexShrink: 0 }}>
            <BadgeIcon size={12} className={doc.processingStatus === 'PENDING' ? 'animate-spin' : undefined} />
            {badge.label}
          </TmsBadge>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: '4px 16px', fontSize: 12, color: 'var(--tms-text-2)' }}>
          <div>
            <span style={{ color: 'var(--tms-muted)' }}>Reference: </span>
            {doc.referenceNumber || '—'}
          </div>
          <div>
            <span style={{ color: 'var(--tms-muted)' }}>Received: </span>
            {formatDateTime(doc.receivedAt)}
          </div>
          {doc.notes && (
            <div style={{ gridColumn: compact ? undefined : '1 / -1', color: 'var(--tms-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {doc.notes}
            </div>
          )}
        </div>

        {doc.processingError && (
          <div style={{ fontSize: 11, color: 'var(--tms-badge-red)', background: 'var(--tms-badge-red-tint)', padding: '6px 10px', borderRadius: 8 }}>
            {doc.processingError}
          </div>
        )}

        {doc.loadId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ color: 'var(--tms-muted)' }}>Assigned to load</span>
            {onViewLoad ? (
              <button
                onClick={() => onViewLoad(doc.loadId!)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: 'var(--tms-primary)',
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
              <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--tms-text-2)' }}>{doc.loadId.slice(-6)}</span>
            )}
          </div>
        )}

        {doc.scanReviewReason && (
          <div className="text-xs text-[color:var(--tms-badge-orange)] bg-[color:var(--tms-badge-orange-tint)] rounded-md px-2 py-1.5">
            Review scan: {doc.scanReviewReason}
          </div>
        )}
        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 6 }}>
          <PodActionBtn onClick={() => onPreview(doc)} icon={<Eye size={13} />} label="View" />
          {/* Enhanced first and emphasised; the raw photo stays reachable but quiet. */}
          {assets?.enhancedUrl && doc.processingStatus === 'READY' && (
            <PodDownloadBtn podId={doc.id} variant="enhanced" filename={doc.fileName} label="Enhanced" />
          )}
          {assets?.originalUrl && (
            <PodDownloadBtn
              podId={doc.id}
              variant="original"
              filename={doc.fileName}
              label={hasEnhanced ? 'Raw photo' : 'Original'}
              tone={hasEnhanced ? 'muted' : 'primary'}
            />
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
