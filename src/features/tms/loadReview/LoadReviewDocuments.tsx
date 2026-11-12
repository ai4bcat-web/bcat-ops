/**
 * Load Review, Documents card: the files on the shipment, and the way to fix what the release gate says is
 * missing without leaving the drawer. Required types come first, each with what is on file (view, download,
 * replace) or an Upload button when it is missing; anything else on the shipment follows.
 *
 * The rows and the required list are the Documents tab's own (`useShipmentDocuments` runs `evaluateDocGate`, the
 * function the Lambda runs before it lets an order release), so this card and the release gate cannot disagree.
 * A write here re-reads the documents and asks the drawer to run the review again.
 */
import { useEffect, useState } from 'react'
import { CheckCircle2, Download, Eye, Plus, RefreshCw, Upload, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton } from '@/features/tms/kit'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import { UploadDocumentDialog } from '@/features/shipments/components/UploadDocumentDialog'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipmentDocuments } from '@/hooks/useShipmentDocuments'
import { getShipmentBundle, getShipmentDocumentUrl, getTmsSettings } from '@/lib/apiClient'
import { getDriverDocUrl } from '@/lib/driverSubmissionsClient'
import { formatDateTime } from '@/lib/date'
import { downloadPodAsPdf } from '@/lib/podDownload'
import { DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import type { ShipmentBundle, ShipmentDocumentRecord, ShipmentDocumentType, TmsSettings } from '@/types/tms'

type Dialog = { type?: ShipmentDocumentType; replaces?: ShipmentDocumentRecord } | null

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function LoadReviewDocuments({ shipmentId, readOnly = false, disabled = false, onChanged }: {
  shipmentId: string
  /** The load has been released: the files are shown, nothing is offered. */
  readOnly?: boolean
  disabled?: boolean
  /** A file landed or was replaced: the drawer runs the review again. */
  onChanged: () => Promise<void>
}) {
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [preview, setPreview] = useState<{ doc: ShipmentDocumentRecord; url: string | null } | null>(null)
  const { customers } = useDirectory({ locations: false })

  useEffect(() => {
    let live = true
    Promise.all([getShipmentBundle(shipmentId), getTmsSettings().catch(() => null)])
      .then(([next, tms]) => { if (live) { setBundle(next); setSettings(tms) } })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : 'The documents could not be loaded') })
    return () => { live = false }
  }, [shipmentId])

  const order = bundle?.orders?.[0] ?? null
  const customer = customers.find((c) => c.id === (order?.customerId ?? bundle?.shipment?.customerId)) ?? null
  const docs = useShipmentDocuments(shipmentId, { bundle, customer, settings, legacyImported: bundle?.shipment?.legacyImported, enabled: !!bundle })
  const gate = order ? docs.orderGates[order.id] : undefined

  const filed = docs.documents.filter((d) => d.status === 'ACTIVE')
  const required = gate?.required ?? []
  const other = filed.filter((d) => !required.includes(d.type))

  const open = async (doc: ShipmentDocumentRecord) => {
    setPreview({ doc, url: null })
    try {
      const url = doc.source === 'DRIVER_APP' ? await getDriverDocUrl(doc.s3Key) : await getShipmentDocumentUrl(doc.s3Key)
      setPreview((cur) => (cur && cur.doc.id === doc.id ? { doc, url } : cur))
    } catch (err) {
      setPreview(null)
      toast.error(err instanceof Error ? err.message : 'Could not open that document')
    }
  }
  const download = async (doc: ShipmentDocumentRecord) => {
    try {
      const url = doc.source === 'DRIVER_APP' ? await getDriverDocUrl(doc.s3Key) : await getShipmentDocumentUrl(doc.s3Key)
      await downloadPodAsPdf(url, doc.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download that document')
    }
  }
  const saved = async () => {
    await docs.refresh()
    await onChanged()
  }

  if (error) return <TmsAlert tone="orange">{error}</TmsAlert>
  if (!bundle) return <p className="tms-muted text-sm" role="status">Loading documents…</p>

  const file = (doc: ShipmentDocumentRecord) => {
    const waiting = doc.reviewStatus === 'PENDING'
    const rejected = doc.reviewStatus === 'REJECTED'
    return (
      <li key={doc.id} className="lr-doc-row" data-testid={`lr-doc-${doc.id}`}>
        <span className="lr-doc-name" title={doc.name}>{doc.name}</span>
        <span className="lr-doc-actions">
          <TmsButton size="sm" className="h-7" aria-label={`View ${doc.name}`} onClick={() => { void open(doc) }}><Eye size={13} className="mr-1" />View</TmsButton>
          <TmsButton size="sm" className="h-7" aria-label={`Download ${doc.name}`} onClick={() => { void download(doc) }}><Download size={13} className="mr-1" />Download</TmsButton>
          {!readOnly && (
            <TmsButton size="sm" className="h-7" disabled={disabled} aria-label={`Replace ${doc.name}`} onClick={() => setDialog({ replaces: doc })}>
              <RefreshCw size={13} className="mr-1" />Replace
            </TmsButton>
          )}
        </span>
        <span className="lr-doc-meta tms-muted">
          {DOCUMENT_TYPE_LABELS[doc.type]} · v{doc.version} · {sizeLabel(doc.sizeBytes)} · {doc.uploadedBy} · {formatDateTime(doc.uploadedAt)}
          {waiting && <TmsBadge tone="orange" className="ml-1 text-[10px]">Waiting on review</TmsBadge>}
          {rejected && <TmsBadge tone="red" className="ml-1 text-[10px]">Rejected</TmsBadge>}
        </span>
      </li>
    )
  }

  return (
    <div className="space-y-3" data-testid="lr-documents">
      {docs.error && <TmsAlert tone="orange">{docs.error}</TmsAlert>}
      {gate?.legacy === true && <p className="tms-muted text-sm">Imported history: the paperwork is in the Aljex archive.</p>}
      {required.length > 0 && gate?.legacy !== true && (
        <ul className="space-y-2" data-testid="lr-documents-required">
          {required.map((type) => {
            const onFile = filed.filter((d) => d.type === type)
            const present = gate?.present.includes(type) === true
            return (
              <li key={type} className="space-y-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {present ? <CheckCircle2 size={15} aria-label="On file" className="text-[color:var(--tms-badge-green)]" /> : <XCircle size={15} aria-label="Missing" className="text-[color:var(--tms-badge-red)]" />}
                  {DOCUMENT_TYPE_LABELS[type]}
                  {!present && onFile.length === 0 && <TmsBadge tone="red" className="text-[10px]">Missing</TmsBadge>}
                  {!present && onFile.length > 0 && <TmsBadge tone="orange" className="text-[10px]">On file, not accepted yet</TmsBadge>}
                  {!readOnly && !present && (
                    <TmsButton size="sm" className="ml-auto h-7" disabled={disabled} onClick={() => setDialog({ type })}>
                      <Upload size={13} className="mr-1" />Upload {DOCUMENT_TYPE_LABELS[type].toLowerCase()}
                    </TmsButton>
                  )}
                </p>
                {onFile.length > 0 && <ul className="space-y-1 pl-5">{onFile.map(file)}</ul>}
              </li>
            )
          })}
        </ul>
      )}
      {required.length === 0 && gate?.legacy !== true && <p className="tms-muted text-sm">No documents required for this customer. BOL is optional.</p>}
      {other.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wider tms-muted">Other files</p>
          <ul className="space-y-1" data-testid="lr-documents-other">{other.map(file)}</ul>
        </div>
      )}
      {!readOnly && (
        <TmsButton size="sm" disabled={disabled} onClick={() => setDialog({})}><Plus size={13} className="mr-1" />Upload another document</TmsButton>
      )}

      {dialog && (
        <UploadDocumentDialog
          bundle={bundle}
          initialType={dialog.type}
          replaces={dialog.replaces ?? null}
          onClose={() => setDialog(null)}
          onSaved={() => { void saved() }}
        />
      )}
      {preview && (
        <DocumentPreview
          open
          onClose={() => setPreview(null)}
          title={`${DOCUMENT_TYPE_LABELS[preview.doc.type]} · ${preview.doc.name}`}
          subtitle={`v${preview.doc.version} · ${preview.doc.uploadedBy}`}
          url={preview.url}
          contentType={preview.doc.contentType}
          downloadName={preview.doc.name}
        />
      )}
    </div>
  )
}
