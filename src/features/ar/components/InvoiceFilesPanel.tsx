/**
 * The files a draft invoice goes out with: its POD and the customer's rate confirmation (Ryne, 2026-11-18). Each shows what is on
 * file with a Preview (in place, internal viewing only) and a Replace, or an Add when none is. A replacement is filed and the old file is kept as history (SUPERSEDED, audited on the
 * shipment); the invoice preview and the list's POD / RC chips follow. Only these two kinds: BCAT's own rate confirmation to a carrier
 * holds carrier pay, is never part of an invoice and is neither shown nor offered here. Read-only once the invoice has gone out.
 */
import { useEffect, useState } from 'react'
import { Eye, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton } from '@/features/tms/kit'
import { UploadDocumentDialog } from '@/features/shipments/components/UploadDocumentDialog'
import { getShipmentBundle, getShipmentDocumentUrl, graphqlErrorText } from '@/lib/apiClient'
import { getDriverDocUrl } from '@/lib/driverSubmissionsClient'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import { isCustomerRateCon, type InvoiceAttachmentPlanRow } from '@/lib/invoiceDelivery'
import { formatDateTime } from '@/lib/date'
import type { FactoringItem } from '@/types'
import type { InvoiceRecord, ShipmentBundle, ShipmentDocumentRecord, ShipmentDocumentType } from '@/types/tms'
import { docsLockedReason } from '../arDocuments'
import './invoiceRateEdit.css'
import { useInvoiceAttachmentPlans } from '../useInvoiceAttachmentPlans'

type Dialog = { type: ShipmentDocumentType; replaces?: ShipmentDocumentRecord } | null

const live = (doc: ShipmentDocumentRecord): boolean => doc.status === 'ACTIVE' && doc.reviewStatus !== 'REJECTED'

export function InvoiceFilesPanel({ invoice, factoringItem, plan, onChanged }: {
  invoice: InvoiceRecord
  factoringItem?: Pick<FactoringItem, 'status' | 'otrInvoiceId'> | null
  /** The invoice's attachment plan when the page already has it; otherwise the panel reads its own. */
  plan?: InvoiceAttachmentPlanRow
  /** A file was replaced or added: the page refreshes its plans, chips, preview and e-mail. */
  onChanged: () => void
}) {
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [epoch, setEpoch] = useState(0)
  const [preview, setPreview] = useState<{ doc: ShipmentDocumentRecord; url: string | null } | null>(null)
  const own = useInvoiceAttachmentPlans(plan ? [] : [invoice.id])
  const mine = plan ?? own.plans.get(invoice.id)
  const lockedReason = docsLockedReason(invoice, factoringItem ?? null)

  useEffect(() => {
    let alive = true
    getShipmentBundle(invoice.shipmentId)
      .then((next) => { if (alive) { setBundle(next); setError(null) } })
      .catch((err: unknown) => { if (alive) setError(graphqlErrorText(err)) })
    return () => { alive = false }
  }, [invoice.shipmentId, epoch])

  if (error && !bundle) return <TmsAlert tone="red">{error}</TmsAlert>
  if (!bundle) return <p className="tms-muted text-xs" role="status">Loading the files…</p>

  const docs = (bundle.documents ?? []) as ShipmentDocumentRecord[]
  const pods = docs.filter((d) => d.type === 'POD' && live(d))
  // The customer's rate confirmation only: never BCAT's own to a carrier, whatever else is on the shipment.
  const rateCons = docs.filter((d) => isCustomerRateCon(d) && live(d))
  const podNeeded = mine?.pod !== 'NOT_INCLUDED'
  const rateConApplies = mine?.rateCon !== 'NOT_INCLUDED'

  // Internal viewing only: opening a file here changes nothing about what the invoice or its e-mail carries.
  const openPreview = async (doc: ShipmentDocumentRecord) => {
    setPreview({ doc, url: null })
    try {
      const url = doc.source === 'DRIVER_APP' ? await getDriverDocUrl(doc.s3Key) : await getShipmentDocumentUrl(doc.s3Key)
      setPreview((open) => (open && open.doc.id === doc.id ? { doc, url } : open))
    } catch (err) {
      setPreview(null)
      toast.error(err instanceof Error ? err.message : 'Could not open that file')
    }
  }

  const saved = () => { setDialog(null); setEpoch((n) => n + 1); if (!plan) own.refresh(); onChanged() }

  const row = (doc: ShipmentDocumentRecord) => (
    <li key={doc.id} className="ifp-row" data-testid={`invoice-file-${doc.id}`}>
      <span className="ifp-name" title={doc.name}>{doc.name}</span>
      <span className="tms-muted text-xs">{doc.uploadedBy} · {formatDateTime(doc.uploadedAt)}</span>
      <TmsButton size="sm" aria-label={`Preview ${doc.name}`} onClick={() => { void openPreview(doc) }}>
        <Eye size={13} />Preview
      </TmsButton>
      {!lockedReason && (
        <TmsButton size="sm" aria-label={`Replace ${doc.name}`} onClick={() => setDialog({ type: doc.type, replaces: doc })}>
          <RefreshCw size={13} />Replace
        </TmsButton>
      )}
    </li>
  )

  const section = (title: string, type: ShipmentDocumentType, rows: ShipmentDocumentRecord[], applies: boolean, noneText: string, notIncluded: string) => (
    <div className="ifp-section" aria-label={title}>
      <p className="ifp-title">
        <strong>{title}</strong>
        {applies && rows.length === 0 && <TmsBadge tone="red">Missing</TmsBadge>}
        {!applies && rows.length === 0 && <TmsBadge tone="gray">Not included</TmsBadge>}
      </p>
      {rows.length > 0 && <ul className="ifp-list">{rows.map(row)}</ul>}
      {rows.length === 0 && <p className="tms-muted text-xs">{applies ? noneText : notIncluded}</p>}
      {applies && rows.length === 0 && !lockedReason && (
        <TmsButton size="sm" aria-label={`Add ${title.toLowerCase()}`} onClick={() => setDialog({ type })}><Plus size={13} />Add {title.toLowerCase()}</TmsButton>
      )}
    </div>
  )

  return (
    <div className="ifp" data-testid="invoice-files-panel">
      {lockedReason && <TmsAlert tone="orange">{lockedReason}</TmsAlert>}
      {section('POD', 'POD', pods, podNeeded, 'No POD is on file for this load.', 'This customer does not need a POD on its invoices.')}
      {section('Rate confirmation', 'RATE_CON', rateCons, rateConApplies, "No customer rate confirmation is on file for this load.", "The customer's rate confirmation is not attached to this customer's invoices.")}
      {!lockedReason && <p className="tms-muted text-xs">A replaced file stays on the shipment as history. The invoice below and its e-mail use the new one.</p>}
      {preview && (
        <DocumentPreview
          open
          onClose={() => setPreview(null)}
          title={preview.doc.name}
          subtitle={`${preview.doc.uploadedBy} · ${formatDateTime(preview.doc.uploadedAt)}`}
          url={preview.url}
          contentType={preview.doc.contentType}
          downloadName={preview.doc.name}
        />
      )}
      {dialog && (
        <UploadDocumentDialog
          bundle={bundle}
          initialType={dialog.type}
          replaces={dialog.replaces ?? null}
          supersede
          lockType
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
    </div>
  )
}
