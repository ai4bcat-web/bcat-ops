/**
 * The POD on the tracking view (Ryne 2026-11-16: "upload the POD in the tracking page if it's missing").
 *
 * On file / Driver sent · review / NEED is the same rule the shipment editor's Documents box and the
 * board read (shipmentDocPresence). An upload here is the editor's upload (uploadShipmentDocument:
 * a ShipmentDocument of type POD on the shipment's order), so it shows on the shipment, the board,
 * Load Review and settlements the moment it lands.
 */
import { useRef, useState } from 'react'
import { Check, Circle, Eye, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton } from '@/features/tms/kit'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import { getShipmentDocumentUrl } from '@/lib/apiClient'
import { formatBoardDateTime } from '@/lib/date'
import { ACCEPTED_CONTENT_TYPES, MAX_DOCUMENT_BYTES, shipmentDocPresence } from '@/lib/shipmentDocuments'
import { uploadShipmentDocument } from '@/lib/shipmentDocumentUpload'
import type { ShipmentBundle, ShipmentDocumentRecord } from '@/types/tms'

export interface TrackingPodBoxProps {
  bundle: ShipmentBundle
  /** The shipment's new bundle after an upload (the drawer replaces its copy and refreshes the grid). */
  onUploaded: (next: ShipmentBundle) => void
  /** Injected in tests; the live path is the editor's upload. */
  upload?: typeof uploadShipmentDocument
}

function originOf(d: ShipmentDocumentRecord): string {
  const by = d.uploadedBy ?? ''
  if (by.startsWith('link:')) return 'from the carrier'
  if (by.toLowerCase().includes('driver') || d.source === 'DRIVER_APP') return 'from the driver'
  return 'uploaded'
}

export function TrackingPodBox({ bundle, onUploaded, upload = uploadShipmentDocument }: TrackingPodBoxProps) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<{ doc: ShipmentDocumentRecord; url: string | null } | null>(null)

  const documents = bundle.documents ?? []
  const presence = shipmentDocPresence({
    documents,
    orders: bundle.orders,
    loads: bundle.loads as { id: string; orderId?: string | null; rateConfirmKey?: string | null }[],
    loadCarriers: bundle.loadCarriers,
    shipment: bundle.shipment,
  }, 'POD')
  const pods = documents.filter((d) => d.type === 'POD' && d.status === 'ACTIVE')

  const pick = async (file: File | undefined) => {
    if (!file) return
    if (!(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      toast.error(`${file.name} must be a PDF, a PNG or a JPEG.`)
      return
    }
    if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES) {
      toast.error(`${file.name} is ${file.size === 0 ? 'empty' : `over ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB`}.`)
      return
    }
    setBusy(true)
    try {
      onUploaded(await upload(bundle, file, 'ALL', 'POD'))
      toast.success(`POD added to ${bundle.shipment.number}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const view = async (doc: ShipmentDocumentRecord) => {
    setViewing({ doc, url: null })
    try {
      const url = await getShipmentDocumentUrl(doc.s3Key)
      setViewing((open) => (open && open.doc.id === doc.id ? { doc, url } : open))
    } catch (err) {
      setViewing(null)
      toast.error(err instanceof Error ? err.message : 'Could not open that document')
    }
  }

  const label = presence === 'PRESENT' ? 'On file' : presence === 'REVIEW' ? 'Driver sent · review' : 'NEED'

  return (
    <section className="tms-tracking-pod" data-testid="tracking-pod" data-presence={presence}>
      <header className="tms-tracking-pod-head">
        {presence === 'MISSING' ? <Circle size={14} aria-hidden /> : <Check size={14} aria-hidden />}
        <strong>Proof of delivery (POD)</strong>
        <span className={presence === 'MISSING' ? 'tms-tracking-pod-need' : 'tms-muted'} data-testid="tracking-pod-state">{label}</span>
      </header>
      {pods.length > 0 && (
        <ul className="tms-tracking-pod-list">
          {pods.map((d) => (
            <li key={d.id}>
              <button type="button" className="tms-link" onClick={() => void view(d)} data-testid={`tracking-pod-view-${d.id}`}>
                <Eye size={13} aria-hidden /> {d.name}
              </button>
              <span className="tms-muted"> · {originOf(d)}{d.uploadedAt ? ` · ${formatBoardDateTime(d.uploadedAt)}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {presence === 'MISSING' && (
        <p className="tms-muted text-sm">No POD on this load yet. Upload it here and it files on the shipment.</p>
      )}
      <input
        ref={input} type="file" hidden accept={ACCEPTED_CONTENT_TYPES.join(',')}
        data-testid="tracking-pod-input"
        onChange={(e) => { void pick(e.target.files?.[0]) }}
      />
      <TmsButton
        size="sm" variant={presence === 'MISSING' ? 'primary' : 'secondary'} disabled={busy}
        data-testid="tracking-pod-upload" onClick={() => input.current?.click()}
      >
        <Upload size={13} aria-hidden /> {busy ? 'Uploading…' : presence === 'MISSING' ? 'Upload POD' : 'Upload another'}
      </TmsButton>
      {viewing && (
        <DocumentPreview
          open onClose={() => setViewing(null)} title={`Proof of delivery · ${viewing.doc.name}`}
          url={viewing.url} contentType={viewing.doc.contentType ?? 'application/pdf'} downloadName={viewing.doc.name}
        />
      )}
    </section>
  )
}
