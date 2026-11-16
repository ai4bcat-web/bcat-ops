/**
 * Load Review, Documents card: the files on the shipment, and the way to fix what the release gate says is
 * missing without leaving the drawer. Required types come first, each with what is on file (view, download,
 * replace) or an Upload button when it is missing; anything else on the shipment follows.
 *
 * The rows and the required list are the Documents tab's own (`useShipmentDocuments` runs `evaluateDocGate`, the
 * function the Lambda runs before it lets an order release), so this card and the release gate cannot disagree.
 * A write here re-reads the documents and asks the drawer to run the review again.
 */
import { isLegacyHistory } from '@/lib/legacyHistory'
import { isCarShipperLoad } from '@/lib/carShipper'
import { useEffect, useState } from 'react'
import { CheckCircle2, Download, Eye, Plus, RefreshCw, Trash2, Upload, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton } from '@/features/tms/kit'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import { UploadDocumentDialog } from '@/features/shipments/components/UploadDocumentDialog'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipmentDocuments } from '@/hooks/useShipmentDocuments'
import { getRateConfirmUrl, getShipmentBundle, getShipmentDocumentUrl, getTmsSettings, voidDocument } from '@/lib/apiClient'
import { assetRateConTenders, isBcatRateCon } from '@/lib/shipmentDocuments'
import { getDriverDocUrl } from '@/lib/driverSubmissionsClient'
import { formatDateTime } from '@/lib/date'
import { downloadPodAsPdf } from '@/lib/podDownload'
import { DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import type { ShipmentBundle, ShipmentDocumentRecord, ShipmentDocumentType, TmsSettings } from '@/types/tms'

type Dialog = { type?: ShipmentDocumentType; replaces?: ShipmentDocumentRecord } | null

/** Marks the load's intake tender in the rail's document rows (it is not a ShipmentDocument). */
const TENDER_SOURCE = 'LOAD_TENDER'

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
  const [confirmDelete, setConfirmDelete] = useState<ShipmentDocumentRecord | null>(null)
  const [deleting, setDeleting] = useState(false)
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
  const docs = useShipmentDocuments(shipmentId, { bundle, customer, settings, legacyImported: isLegacyHistory(bundle?.shipment), carShipper: isCarShipperLoad(bundle?.shipment), enabled: !!bundle })
  const gate = order ? docs.orderGates[order.id] : undefined

  const filed = docs.documents.filter((d) => d.status === 'ACTIVE')
  const required = gate?.required ?? []
  const other = filed.filter((d) => !required.includes(d.type))

  // The customer's tender attached to the load from the intake e-mail counts as the rate confirmation (presentDocTypes), but it
  // lives on the Load record in the rate-confirmation store, not in the shipment's documents. Shown as a row so it can be opened.
  const tenders: ShipmentDocumentRecord[] = assetRateConTenders((bundle?.loads ?? []) as { id: string; rateConfirmKey?: string | null }[])
    .map((t) => ({ id: `tender:${t.loadId}`, type: 'RATE_CON', name: 'Rate confirmation (from the intake e-mail).pdf', version: 1, uploadedBy: 'intake e-mail',
      uploadedAt: '', sizeBytes: 0, contentType: 'application/pdf', s3Key: t.key, status: 'ACTIVE', source: TENDER_SOURCE }) as unknown as ShipmentDocumentRecord)
  const urlOf = (doc: ShipmentDocumentRecord) => (doc.source as string) === TENDER_SOURCE ? getRateConfirmUrl(doc.s3Key)
    : doc.source === 'DRIVER_APP' ? getDriverDocUrl(doc.s3Key) : getShipmentDocumentUrl(doc.s3Key)

  const open = async (doc: ShipmentDocumentRecord) => {
    setPreview({ doc, url: null })
    try {
      const url = await urlOf(doc)
      setPreview((cur) => (cur && cur.doc.id === doc.id ? { doc, url } : cur))
    } catch (err) {
      setPreview(null)
      toast.error(err instanceof Error ? err.message : 'Could not open that document')
    }
  }
  const download = async (doc: ShipmentDocumentRecord) => {
    try {
      const url = await urlOf(doc)
      await downloadPodAsPdf(url, doc.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download that document')
    }
  }
  const saved = async () => {
    await docs.refresh()
    await onChanged()
  }

  // Same delete as the shipment's Documents card (VOID_DOCUMENT: kept as void, audited), then the checks re-run.
  const remove = async (doc: ShipmentDocumentRecord) => {
    setDeleting(true)
    try {
      await voidDocument({ documentId: doc.id, reason: 'Deleted in Load Review' })
      toast.success(`Deleted ${doc.name}`)
      setConfirmDelete(null)
      await saved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete that document')
    } finally { setDeleting(false) }
  }

  if (error) return <TmsAlert tone="orange">{error}</TmsAlert>
  if (!bundle) return <p className="tms-muted text-sm" role="status">Loading documents…</p>

  const file = (doc: ShipmentDocumentRecord) => {
    // No POD review step: only another kind of carrier upload waits on a person.
    const waiting = doc.reviewStatus === 'PENDING' && doc.type !== 'POD'
    const rejected = doc.reviewStatus === 'REJECTED'
    // System documents (the BCAT Rate Confirmation, generated invoices and PDFs) are not deleted from the review.
    const tender = (doc.source as string) === TENDER_SOURCE
    const system = !tender && (isBcatRateCon(doc) || doc.source === 'GENERATED')
    const asking = confirmDelete?.id === doc.id
    return (
      <li key={doc.id} className="lr-doc-row" data-testid={`lr-doc-${doc.id}`}>
        <span className="lr-doc-name" title={doc.name}>{doc.name}</span>
        <span className="lr-doc-actions">
          <TmsButton size="sm" className="h-7" aria-label={`View ${doc.name}`} onClick={() => { void open(doc) }}><Eye size={13} className="mr-1" />View</TmsButton>
          <TmsButton size="sm" className="h-7" aria-label={`Download ${doc.name}`} onClick={() => { void download(doc) }}><Download size={13} className="mr-1" />Download</TmsButton>
          {!readOnly && (
            <TmsButton size="sm" className="h-7" disabled={disabled} aria-label={`Replace ${doc.name}`} onClick={() => setDialog(tender ? { type: 'RATE_CON' } : { replaces: doc })}>
              <RefreshCw size={13} className="mr-1" />Replace
            </TmsButton>
          )}
          {!readOnly && !system && !tender && (
            <TmsButton size="sm" className="h-7" disabled={disabled || deleting} aria-label={`Delete ${doc.name}`} onClick={() => setConfirmDelete(doc)}>
              <Trash2 size={13} className="mr-1" />Delete
            </TmsButton>
          )}
          {!readOnly && system && <span className="tms-muted text-xs">System document</span>}
          {!readOnly && tender && <span className="tms-muted text-xs" title="Kept on the load from the intake e-mail. Upload a replacement to use a different rate confirmation.">From intake</span>}
        </span>
        {asking && <span className="lr-doc-confirm" role="alertdialog" aria-label={`Delete ${doc.name}`} data-testid={`lr-doc-confirm-${doc.id}`}>
          <span className="text-sm">{`Delete ${doc.name}? This removes it from the shipment.`}</span>
          <TmsButton size="sm" className="h-7" variant="destructive" disabled={deleting} onClick={() => { void remove(doc) }}>{deleting ? 'Deleting…' : 'Delete'}</TmsButton>
          <TmsButton size="sm" className="h-7" variant="ghost" disabled={deleting} onClick={() => setConfirmDelete(null)}>Cancel</TmsButton>
        </span>}
        <span className="lr-doc-meta tms-muted">
          {tender ? 'Rate confirmation · attached to the load from the intake e-mail'
            : <>{DOCUMENT_TYPE_LABELS[doc.type]} · v{doc.version}{doc.sizeBytes > 0 ? ` · ${sizeLabel(doc.sizeBytes)}` : ''} · {doc.uploadedBy} · {formatDateTime(doc.uploadedAt)}</>}
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
            const onFile = [...filed.filter((d) => d.type === type), ...(type === 'RATE_CON' ? tenders : [])]
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
      {(other.length > 0 || (!required.includes('RATE_CON') && tenders.length > 0)) && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wider tms-muted">Other files</p>
          <ul className="space-y-1" data-testid="lr-documents-other">{[...other, ...(required.includes('RATE_CON') ? [] : tenders)].map(file)}</ul>
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
