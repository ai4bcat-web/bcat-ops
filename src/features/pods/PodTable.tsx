import { Eye, Link2, Unlink, RotateCcw, FileText, Loader2 } from 'lucide-react'
import { formatDateTime } from '@/lib/date'
import { matchPodDriver } from '@/lib/podDriver'
import type { Driver, Load } from '@/types'
import type { PodDocument, PodSenderMapping } from '@/types/pods'
import { statusBadge, usePodAssets, useStalePending, senderLabel, shipmentLabel, shipmentRoute } from './podUtils'
import { PodActionBtn, PodDownloadBtn } from './PodShared'

const th: React.CSSProperties = {
  textAlign: 'left', fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase',
  color: 'var(--ds-t3)', padding: '10px 12px', borderBottom: '1px solid var(--ds-border)', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid var(--ds-border)', verticalAlign: 'middle', fontSize: 13 }

export function PodTable({
  docs,
  loads,
  drivers,
  mappings,
  onPreview,
  onAssign,
  onUnassign,
  onRetry,
  onViewLoad,
}: {
  docs: PodDocument[]
  loads: Load[]
  drivers: Driver[]
  mappings: PodSenderMapping[]
  onPreview: (d: PodDocument) => void
  onAssign: (d: PodDocument) => void
  onUnassign: (d: PodDocument) => void
  onRetry: (d: PodDocument) => void
  onViewLoad: (loadId: string) => void
}) {
  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Shipment</th>
            <th style={{ ...th, width: 72 }}>Image</th>
            <th style={th}>Sender</th>
            <th style={th}>Driver</th>
            <th style={th}>Received</th>
            <th style={th}>Reference</th>
            <th style={th}>Scan</th>
            <th style={th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((doc) => (
            <PodRow key={doc.id} doc={doc} loads={loads} drivers={drivers} mappings={mappings} onPreview={onPreview} onAssign={onAssign} onUnassign={onUnassign} onRetry={onRetry} onViewLoad={onViewLoad} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PodRow({
  doc, loads, drivers, mappings, onPreview, onAssign, onUnassign, onRetry, onViewLoad,
}: {
  doc: PodDocument
  loads: Load[]
  drivers: Driver[]
  mappings: PodSenderMapping[]
  onPreview: (d: PodDocument) => void
  onAssign: (d: PodDocument) => void
  onUnassign: (d: PodDocument) => void
  onRetry: (d: PodDocument) => void
  onViewLoad: (loadId: string) => void
}) {
  const { assets, loading } = usePodAssets(doc)
  const badge = statusBadge(doc)
  const BadgeIcon = badge.icon
  const driver = matchPodDriver(doc, drivers, mappings)
  const hasEnhanced = Boolean(assets?.enhancedUrl) && doc.processingStatus === 'READY'
  const originalIsImage = /^image\/(jpeg|png|webp|gif)/i.test(doc.contentType ?? '')
  const thumbUrl = hasEnhanced ? assets?.enhancedUrl : originalIsImage ? assets?.originalUrl : undefined
  const canOpen = Boolean(assets?.originalUrl)
  const isStalePending = useStalePending(doc)
  const assignedLoad = doc.loadId ? loads.find((l) => l.id === doc.loadId) : undefined
  const route = shipmentRoute(assignedLoad)

  return (
    <tr>
      <td style={{ ...td, maxWidth: 260 }}>
        {doc.loadId ? (
          <>
            <button
              onClick={() => onViewLoad(doc.loadId!)}
              title="View shipment"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, color: '#15803d', background: '#f0fdf4', border: '1px solid #bbf7d0', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
            >
              <Link2 size={12} /> {shipmentLabel(assignedLoad, doc.loadId)}
            </button>
            {assignedLoad?.customer && (
              <div style={{ fontSize: 12, color: 'var(--ds-t2)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{assignedLoad.customer}</div>
            )}
            {route && (
              <div style={{ fontSize: 12, color: 'var(--ds-t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{route}</div>
            )}
          </>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', whiteSpace: 'nowrap' }}>
            <Unlink size={12} /> Unassigned
          </span>
        )}
      </td>
      <td style={{ ...td, padding: 6 }}>
        <button
          onClick={() => onPreview(doc)}
          disabled={!canOpen}
          title="View"
          style={{ width: 60, height: 60, border: '1px solid var(--ds-border)', borderRadius: 6, background: 'var(--ds-bg)', padding: 0, overflow: 'hidden', cursor: canOpen ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {loading ? <Loader2 size={16} className="animate-spin" style={{ color: 'var(--ds-t3)' }} />
            : thumbUrl ? <img src={thumbUrl} alt={doc.fileName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <FileText size={20} style={{ color: 'var(--ds-t3)' }} />}
        </button>
      </td>
      <td style={td}>
        <div style={{ fontWeight: 600, color: 'var(--ds-t1)' }}>{senderLabel(doc)}</div>
        <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>{doc.companyName || '—'}</div>
      </td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>
        {driver ? (
          <span style={{ fontWeight: 600, color: 'var(--ds-t1)' }}>{driver.name}</span>
        ) : (
          <span style={{ color: 'var(--ds-t3)' }}>Not on roster</span>
        )}
      </td>
      <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--ds-t2)' }}>{formatDateTime(doc.receivedAt)}</td>
      <td style={{ ...td, color: 'var(--ds-t2)', maxWidth: 220 }}>
        <div>{doc.referenceNumber || '—'}</div>
        {doc.notes && <div style={{ fontSize: 12, color: 'var(--ds-t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.notes}</div>}
      </td>
      <td style={{ ...td, maxWidth: 260 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: badge.color, background: badge.bg, whiteSpace: 'nowrap' }}>
          <BadgeIcon size={12} className={doc.processingStatus === 'PENDING' ? 'animate-spin' : undefined} /> {badge.label}
        </span>
        {doc.scanReviewReason && <div style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>{doc.scanReviewReason}</div>}
        {doc.processingError && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>{doc.processingError}</div>}
      </td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <PodActionBtn onClick={() => onPreview(doc)} icon={<Eye size={13} />} label="View" />
          {/* The enhanced scan leads: it is the copy that goes to a broker or to OTR. The
              original is the raw photo, kept as evidence and deliberately quiet. */}
          {hasEnhanced && assets?.enhancedUrl && (
            <PodDownloadBtn url={assets.enhancedUrl} filename={doc.fileName} label="Enhanced" />
          )}
          {assets?.originalUrl && (
            <PodDownloadBtn
              url={assets.originalUrl}
              filename={doc.fileName}
              label={hasEnhanced ? 'Raw photo' : 'Original'}
              tone={hasEnhanced ? 'muted' : 'primary'}
            />
          )}
          {(doc.processingStatus === 'FAILED' || isStalePending) && (
            <PodActionBtn onClick={() => onRetry(doc)} icon={<RotateCcw size={13} />} label="Retry" />
          )}
          {doc.loadId
            ? <PodActionBtn onClick={() => onUnassign(doc)} icon={<Unlink size={13} />} label="Unassign" />
            : <PodActionBtn onClick={() => onAssign(doc)} icon={<Link2 size={13} />} label="Assign" />}
        </div>
      </td>
    </tr>
  )
}
