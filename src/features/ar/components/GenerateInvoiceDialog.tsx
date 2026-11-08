/**
 * Issuing one bill: the last look a person gets before the order stops being editable.
 *
 * The dialog shows the server's own readiness answer — every reason at once, never the
 * first one — and keeps Generate disabled until there are none, because GENERATE_INVOICE
 * refuses on exactly the same list and a button that submits a refusal is a lie.
 *
 * The PDF underneath is not a mock-up: it is `buildInvoicePdf` over `invoiceData`, the
 * same pure pair the Lambda runs, fed the preview snapshot. What is on screen is what
 * will be stored under `invoices/*`, down to the line wrapping.
 *
 * Changing the invoice date or the bill-to re-runs the preview rather than patching the
 * snapshot locally: terms, due date, addressee and recipients all move together, and
 * only the server knows how.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import {
  generateInvoice,
  getShipmentBundle,
  getTmsSettings,
  graphqlErrorText,
  listCustomers,
  listDivisions,
  previewInvoice,
  type InvoicePreview,
} from '@/lib/apiClient'
import { formatCents, invoiceData } from '@/lib/invoiceBuild'
import { buildInvoicePdf } from '@/lib/invoicePdf'
import { DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import type { CustomerRecord, Division, ShipmentBundle, TmsSettings } from '@/types/tms'

/** Everything the PDF needs that the preview snapshot does not carry itself. */
interface PdfContext {
  bundle: Pick<ShipmentBundle, 'shipment' | 'loads'> | null
  customer: CustomerRecord | null
  division: Division | null
  settings: TmsSettings | null
}

export function GenerateInvoiceDialog({ orderId, busy, onClose, onDone }: {
  orderId: string
  busy?: boolean
  onClose: () => void
  onDone: (invoiceId?: string) => void
}) {
  const [invoiceDate, setInvoiceDate] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [billToId, setBillToId] = useState('')
  const [note, setNote] = useState('')
  const [attachIds, setAttachIds] = useState<string[]>([])
  const [preview, setPreview] = useState<InvoicePreview | null>(null)
  const [context, setContext] = useState<PdfContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback((date: string, billTo: string) => {
    const input: { orderId: string; invoiceDate?: string; billToId?: string } = { orderId }
    if (date) input.invoiceDate = date
    if (billTo) input.billToId = billTo
    return Promise.all([previewInvoice(input), listCustomers(), listDivisions(), getTmsSettings()])
      .then(([result, customers, divisions, settings]) =>
        // The route on the bill comes off the shipment's stops; the preview snapshot
        // carries the money, not the geography.
        getShipmentBundle(result.snapshot.shipmentId).then((bundle) => {
          setPreview(result)
          setInvoiceDate(result.snapshot.invoiceDate)
          setDueAt(result.snapshot.dueAt)
          setBillToId(result.snapshot.billToId ?? '')
          setAttachIds(result.attachments.map((doc) => doc.id))
          setContext({
            bundle,
            customer: customers.find((row) => row.id === result.snapshot.customerId) ?? null,
            division: divisions.find((row) => row.key === result.snapshot.divisionKey) ?? null,
            settings,
          })
          setError(null)
        }))
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false))
  }, [orderId])

  useEffect(() => { load('', '') }, [load])

  // The preview the server returned, rendered here with the renderer that will store it.
  useEffect(() => {
    const snapshot = preview?.snapshot
    if (!snapshot || !context) return
    let url: string | null = null
    let dropped = false
    buildInvoicePdf(invoiceData({
      invoice: snapshot,
      bundle: { shipment: context.bundle?.shipment ?? null, loads: context.bundle?.loads ?? null },
      customer: context.customer,
      division: context.division,
      settings: context.settings,
    }))
      .then((bytes) => {
        if (dropped) return
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
        setPdfUrl(url)
      })
      .catch(() => { if (!dropped) setPdfUrl(null) })
    return () => {
      dropped = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [preview, context])

  const billToParties = context?.customer?.billToParties ?? []
  const reasons = preview?.readiness.reasons ?? []
  const ready = preview?.readiness.ready === true
  const missingDocs = preview?.gate.missing ?? []
  const disabled = busy === true || posting || loading

  const total = useMemo(() => (preview ? formatCents(preview.snapshot.totalCents) : '—'), [preview])

  const reload = (date: string, billTo: string) => {
    setLoading(true)
    setPdfUrl(null)
    load(date, billTo)
  }

  const submit = () => {
    if (!preview) return
    setPosting(true)
    setError(null)
    generateInvoice({
      orderId,
      attachDocumentIds: attachIds,
      invoiceDate: invoiceDate || undefined,
      dueAt: dueAt || undefined,
      billToId: billToId || undefined,
      note: note.trim() || undefined,
    })
      .then((result) => {
        toast.success(`Invoice ${result.invoice.number} issued`)
        onDone(result.invoice.id)
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setPosting(false))
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Generate invoice"
      className="tms-dialog-xl"
      footer={
        <>
          <p className="mr-auto text-xs tms-muted">
            Generate — moves the shipment to Unpaid and freezes its charges
          </p>
          <TmsButton variant="ghost" onClick={onClose} disabled={posting}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={disabled || !ready}>
            {posting ? 'Generating…' : 'Generate'}
          </TmsButton>
        </>
      }
    >
      {loading && (
        <p className="flex items-center gap-2 tms-muted">
          <Loader2 size={14} className="animate-spin" /> Reading the shipment…
        </p>
      )}

      {!loading && preview && (
        <div className="tms-grid tms-grid-2">
          <div className="flex flex-col gap-4">
            {ready ? (
              <p
                className="flex items-start gap-2 p-2 text-xs"
                style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
              >
                <CheckCircle2 size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-green)' }} />
                This shipment is ready to bill for {total}.
              </p>
            ) : (
              <div
                className="p-2 text-xs"
                style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
              >
                <p className="flex items-center gap-2 font-medium">
                  <AlertTriangle size={14} className="shrink-0" style={{ color: 'var(--tms-badge-orange)' }} />
                  This shipment cannot be billed yet:
                </p>
                <ul className="mt-1 list-disc pl-6">
                  {reasons.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              </div>
            )}

            <div className="tms-grid tms-grid-2">
              <TmsField label="Invoice date">
                <TmsInput
                  aria-label="Invoice date"
                  type="date"
                  value={invoiceDate}
                  disabled={disabled}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  onBlur={(e) => { if (e.target.value !== preview.snapshot.invoiceDate) reload(e.target.value, billToId) }}
                />
              </TmsField>
              <TmsField label={`Due ${preview.snapshot.termsDays ? `(net ${preview.snapshot.termsDays})` : ''}`}>
                <TmsInput
                  aria-label="Invoice due date"
                  type="date"
                  value={dueAt}
                  disabled={disabled}
                  onChange={(e) => setDueAt(e.target.value)}
                />
              </TmsField>
            </div>

            <TmsField label="Bill to">
              <TmsSelect
                aria-label="Bill to party"
                value={billToId}
                disabled={disabled}
                onChange={(e) => { setBillToId(e.target.value); reload(invoiceDate, e.target.value) }}
              >
                <option value="">— the customer —</option>
                {billToParties.map((party) => (
                  <option key={party.id} value={party.id}>{party.name}</option>
                ))}
              </TmsSelect>
            </TmsField>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Attachments</p>
              {preview.attachments.length === 0 ? (
                <p className="mt-1 text-xs tms-muted">
                  No documents will go out with this invoice.
                  {missingDocs.length > 0 && ` Missing: ${missingDocs.map((type) => DOCUMENT_TYPE_LABELS[type] ?? type).join(', ')}.`}
                </p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {preview.attachments.map((doc) => (
                    <li key={doc.id}>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Attach ${doc.name}`}
                          checked={attachIds.includes(doc.id)}
                          disabled={disabled}
                          onChange={(e) => setAttachIds((prev) => (
                            e.target.checked ? [...prev, doc.id] : prev.filter((id) => id !== doc.id)
                          ))}
                        />
                        <span className="truncate">
                          {DOCUMENT_TYPE_LABELS[doc.type as keyof typeof DOCUMENT_TYPE_LABELS] ?? doc.type} — {doc.name}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <TmsField label="Note">
              <TmsTextarea
                aria-label="Invoice note"
                rows={2}
                value={note}
                disabled={disabled}
                onChange={(e) => setNote(e.target.value)}
              />
            </TmsField>

            {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
          </div>

          <div className="min-h-[28rem]">
            <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Preview</p>
            {pdfUrl ? (
              <iframe
                title="Invoice preview"
                src={pdfUrl}
                className="mt-1 h-[28rem] w-full"
                style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
              />
            ) : (
              <p className="mt-1 flex items-center gap-2 tms-muted">
                <Loader2 size={14} className="animate-spin" /> Rendering the bill…
              </p>
            )}
          </div>
        </div>
      )}
    </TmsDialog>
  )
}
