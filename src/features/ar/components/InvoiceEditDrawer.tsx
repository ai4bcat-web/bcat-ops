/**
 * View and edit one invoice in place (Ryne, 2026-11-12): the PDF, the e-mail exactly as it will
 * go out (or, factored, where it stands with OTR), the lines, and hand credits/debits with
 * reasons. "Save & regenerate" saves INTO this invoice (REVISE_INVOICE) — never a second one —
 * and a sent invoice becomes 'Rev N'. Send / Resend hands it to the review carousel.
 *
 * This drawer is where a single invoice is sent from (Ryne, 2026-11-12): its Actions bar holds
 * Send / Resend, Regenerate, Send to factor, Receive payment and Void (admin). The preview is the
 * invoice exactly as it goes out — one PDF with the POD pages merged in. Nothing here links to
 * the shipment.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsInput, TmsSelect } from '@/features/tms/kit'
import { getInvoicePdfUrl, getTmsSettings, graphqlErrorText, renderInvoicePdf, reviseInvoice } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { invoiceAttachmentName, invoiceCompanyName, invoicePoNumber } from '@/lib/invoiceIdentity'
import { renderInvoiceEmail } from '@/lib/shipmentNotices'
import type { FactoringItem } from '@/types'
import type { CustomerRecord, InvoiceAdjustment, InvoiceRecord, ShipmentRecord, TmsSettings } from '@/types/tms'
import { centsFromInput, inputFromCents } from './money'
import { InvoicePacketFrame } from './InvoicePacketFrame'
import { useCustomerPaymentFacts } from '@/hooks/useCustomerPaymentFacts'
import { PAYMENT_METHOD_LABEL, settlementOf } from '@/lib/daysToPay'
import { formatDay } from '../arViews'
import { INVOICE_FROM_ADDRESS, isFactoredInvoice, manualRecipients } from '../sendReview'
import { AttachmentInfo, AttachmentRow, AttachmentsSection, InvoiceEnvelope, MessageSection } from './InvoiceEmailSections'

interface Draft { kind: 'CREDIT' | 'DEBIT'; description: string; amount: string; reason: string }

export function InvoiceEditDrawer({ invoice, customer, shipment, factoringItem, canEdit, canVoid = false, onClose, onSaved, onSend, onFactor, onPayment, onMarkPaid, onVoid }: {
  invoice: InvoiceRecord
  customer: CustomerRecord | undefined
  shipment: ShipmentRecord | undefined
  factoringItem: FactoringItem | undefined
  canEdit: boolean
  onClose: () => void
  onSaved: () => void
  onSend: (invoice: InvoiceRecord) => void
  /** Owner / ADMIN (Ryne or Jenny): Void shows. */
  canVoid?: boolean
  onFactor?: (invoice: InvoiceRecord) => void
  onPayment?: (invoice: InvoiceRecord) => void
  /** Paid date, ACH or check, check # — the same dialog as the Invoiced tab's batch. */
  onMarkPaid?: (invoice: InvoiceRecord) => void
  onVoid?: (invoice: InvoiceRecord) => void
}) {
  const [current, setCurrent] = useState(invoice)
  const paymentFacts = useCustomerPaymentFacts([invoice.customerId])
  const paymentLines = paymentFacts.linesByInvoice.get(invoice.id) ?? []
  const settled = settlementOf(current, paymentLines)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>(() => (invoice.adjustments ?? []).map((a) => ({
    kind: a.kind, description: a.description, amount: inputFromCents(a.amountCents), reason: a.reason,
  })))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getTmsSettings().then((s) => { if (alive) setSettings(s) }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  useEffect(() => {
    let alive = true
    if (current.pdfKey) getInvoicePdfUrl(current.pdfKey).then((u) => { if (alive) setPdfUrl(u) }).catch(() => undefined)
    return () => { alive = false }
  }, [current.pdfKey])

  const factored = isFactoredInvoice(current, customer)
  const sent = Boolean(current.sentAt || current.markedSentAt || (current.sentCount ?? 0) > 0)
  const locked = current.paidCents > 0 || current.writtenOffCents > 0 || Boolean(factoringItem?.otrInvoiceId) || current.status === 'VOID'
  const po = invoicePoNumber(current.references)
  const pro = current.shipmentNumber || current.number
  const email = useMemo(() => renderInvoiceEmail({
    invoice: current,
    brokerName: 'BCAT',
    po,
    companyName: invoiceCompanyName(shipment?.revDivision, shipment?.revSubdivision),
  }), [current, po, shipment])
  const recipients = manualRecipients(customer, settings)

  const adjustments: InvoiceAdjustment[] | null = useMemo(() => {
    const out: InvoiceAdjustment[] = []
    for (const d of drafts) {
      const cents = centsFromInput(d.amount)
      if (!cents || cents <= 0 || !d.description.trim() || !d.reason.trim()) return null
      out.push({ kind: d.kind, description: d.description.trim(), amountCents: cents, reason: d.reason.trim() })
    }
    return out
  }, [drafts])
  const chargeTotal = (current.lines ?? []).filter((l) => l.code !== 'ADJUSTMENT').reduce((sum, l) => sum + l.amountCents, 0)
  const newTotal = adjustments ? chargeTotal + adjustments.reduce((s, a) => s + (a.kind === 'CREDIT' ? -a.amountCents : a.amountCents), 0) : null

  const save = () => {
    if (!adjustments) return
    setSaving(true)
    setError(null)
    reviseInvoice({ invoiceId: current.id, adjustments })
      .then(({ invoice: fresh, revision }) => {
        setCurrent(fresh)
        toast.success(`Saved ${fresh.number}${revision > 1 ? ` Rev ${revision}` : ''} and regenerated the PDF`)
        onSaved()
      })
      .catch((err: unknown) => setError(graphqlErrorText(err)))
      .finally(() => setSaving(false))
  }

  const regenerate = () => {
    setSaving(true)
    setError(null)
    renderInvoicePdf({ invoiceId: current.id })
      .then(({ invoice: fresh }) => { setCurrent(fresh); toast.success(`Regenerated ${fresh.number}`); onSaved() })
      .catch((err: unknown) => setError(graphqlErrorText(err)))
      .finally(() => setSaving(false))
  }

  const set = (i: number, patch: Partial<Draft>) => setDrafts((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const rev = (current.revision ?? 1) > 1 ? ` Rev ${current.revision}` : ''

  // Ryne 2026-11-14: the invoice opens in the middle of the page (centered dialog; a full-screen sheet on phones).
  return (
    <TmsDialog
      open
      className="tms-dialog-xl tms-dialog-invoice"
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`Invoice ${current.number}${rev}`}
      description={`${current.customerName ?? ''} · PRO ${pro}${po ? ` · PO ${po}` : ''} · ${formatCents(current.totalCents)} · balance ${formatCents(current.balanceCents)}`}
      footer={
        <>
          {canEdit && !locked && (
            <TmsButton variant="primary" aria-label="Save and regenerate" disabled={saving || !adjustments} onClick={save}>
              {saving ? 'Saving…' : 'Save & regenerate'}
            </TmsButton>
          )}
          <Link className="tms-btn tms-btn-ghost tms-btn-sm" to={`/tms/invoicing/invoices/${current.id}`}>Full record</Link>
          <TmsButton variant="ghost" onClick={onClose}>Close</TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <section aria-label="Invoice actions" className="flex flex-wrap items-center gap-2 rounded p-2" style={{ border: '1px solid var(--tms-border)', background: 'var(--tms-surface-2, transparent)' }}>
          {canEdit && current.status !== 'VOID' && current.status !== 'PAID' && (
            <TmsButton variant="primary" aria-label={sent ? 'Resend invoice' : 'Send invoice'} disabled={saving} onClick={() => onSend(current)}>
              {factored ? 'Send to OTR' : sent ? 'Review & resend' : 'Review & send'}
            </TmsButton>
          )}
          {canEdit && current.status !== 'VOID' && !locked && (
            <TmsButton aria-label="Regenerate invoice PDF" disabled={saving} onClick={regenerate}><RefreshCw size={13} /> Regenerate PDF</TmsButton>
          )}
          {canEdit && onFactor && !factored && !sent && current.status !== 'VOID' && current.status !== 'PAID' && (
            <TmsButton aria-label="Send to factor instead" disabled={saving} onClick={() => onFactor(current)}>Send to factor</TmsButton>
          )}
          {onMarkPaid && sent && !factored && current.status !== 'VOID' && current.status !== 'PAID' && current.balanceCents > 0 && (
            <TmsButton variant="primary" aria-label="Mark paid" disabled={saving} onClick={() => onMarkPaid(current)}>Mark paid</TmsButton>
          )}
          {onPayment && sent && current.status !== 'VOID' && current.status !== 'PAID' && (
            <TmsButton variant="ghost" aria-label="Receive payment" disabled={saving} onClick={() => onPayment(current)}>Receive payment</TmsButton>
          )}
          {canVoid && onVoid && current.status !== 'VOID' && (
            <TmsButton variant="ghost" aria-label="Void invoice" disabled={saving} onClick={() => onVoid(current)}>Void</TmsButton>
          )}
        </section>
        <div className="flex flex-wrap gap-2">
          <TmsBadge tone={factored ? 'purple' : 'blue'}>{factored ? 'OTR' : 'Manual'}</TmsBadge>
          <TmsBadge tone={sent ? 'green' : 'orange'}>{sent ? 'Sent' : 'Draft — not sent'}</TmsBadge>
          {current.status === 'PAID' && (
            <TmsBadge tone="green" data-testid="invoice-paid-badge">
              Paid {formatDay(settled.paidOn)}{settled.method ? ` · ${PAYMENT_METHOD_LABEL[settled.method] ?? settled.method}` : ''}{settled.reference ? ` #${settled.reference}` : ''}{settled.daysToPay != null ? ` · ${settled.daysToPay} days to pay` : ''}
            </TmsBadge>
          )}
          {current.status === 'PARTIAL' && <TmsBadge tone="orange">Partially paid · {formatCents(current.balanceCents)} open</TmsBadge>}
          {locked && <TmsBadge tone="gray">{current.paidCents > 0 ? 'Payment applied: use a credit memo' : factoringItem?.otrInvoiceId ? 'With OTR: edit from factoring' : 'Locked'}</TmsBadge>}
        </div>
        {paymentLines.length > 0 && (
          <ul className="text-sm" data-testid="invoice-payment-history" style={{ display: 'grid', gap: 2, margin: 0, paddingLeft: 16 }}>
            {paymentLines.map((l) => (
              <li key={`${l.paymentId}:${l.receivedOn}`}>
                {formatDay(l.receivedOn)} · {l.method ? PAYMENT_METHOD_LABEL[l.method] ?? l.method : 'Write-off'}{l.reference ? ` #${l.reference}` : ''} · {formatCents(l.amountCents)}
              </li>
            ))}
          </ul>
        )}

        {factored ? (
          <section aria-label="OTR submission">
            <h3 className="font-semibold">OTR</h3>
            {factoringItem
              ? <p>Status {factoringItem.status}{factoringItem.otrStatus ? ` · OTR ${factoringItem.otrStatus}` : ''}{factoringItem.otrInvoiceId ? ` · OTR invoice ${factoringItem.otrInvoiceId}` : ''}{factoringItem.otrSubmittedAt ? ` · submitted ${factoringItem.otrSubmittedAt.slice(0, 10)}` : ' · not submitted yet'}</p>
              : <p className="tms-muted">Not in the factoring queue yet — Send to OTR queues it.</p>}
          </section>
        ) : (
          <section aria-label="E-mail preview" className="flex flex-col gap-3">
            <InvoiceEnvelope from={INVOICE_FROM_ADDRESS} to={recipients.to} cc={recipients.cc} subject={email.subject} />
            <AttachmentsSection>
              <ul className="inv-email-files" aria-label="Attachment list">
                <AttachmentRow name={invoiceAttachmentName(pro, po)} type="Invoice + POD" note="one PDF: the invoice, then every POD page" />
              </ul>
              <AttachmentInfo>The BOL, and the customer rate confirmation on Ivan Cartage loads, go as separate files — Review &amp; send lists each one.</AttachmentInfo>
            </AttachmentsSection>
            <MessageSection body={email.body} />
          </section>
        )}

        <section aria-label="Invoice lines">
          <h3 className="font-semibold">Lines</h3>
          <ul>
            {(current.lines ?? []).filter((l) => l.code !== 'ADJUSTMENT').map((l) => (
              <li key={l.chargeId} className="flex justify-between"><span>{l.label ?? l.code}</span><span>{formatCents(l.amountCents)}</span></li>
            ))}
          </ul>
          <p className="tms-muted text-xs">Charges come from the shipment; change them there, then Save & regenerate here.</p>
        </section>

        <section aria-label="Adjustments">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Credits and debits</h3>
            {canEdit && !locked && (
              <TmsButton size="sm" aria-label="Add adjustment" onClick={() => setDrafts((rows) => [...rows, { kind: 'CREDIT', description: '', amount: '', reason: '' }])}>
                <Plus size={12} /> Add
              </TmsButton>
            )}
          </div>
          {drafts.length === 0 && <p className="tms-muted text-xs">None.</p>}
          {drafts.map((d, i) => (
            <div key={i} className="mt-1 flex flex-wrap items-center gap-1">
              <TmsSelect aria-label={`Adjustment ${i + 1} kind`} value={d.kind} disabled={locked} onChange={(e) => set(i, { kind: e.target.value as Draft['kind'] })}>
                <option value="CREDIT">Credit</option>
                <option value="DEBIT">Debit</option>
              </TmsSelect>
              <TmsInput aria-label={`Adjustment ${i + 1} description`} placeholder="Description" value={d.description} disabled={locked} onChange={(e) => set(i, { description: e.target.value })} />
              <TmsInput aria-label={`Adjustment ${i + 1} amount`} placeholder="0.00" inputMode="decimal" className="w-24" value={d.amount} disabled={locked} onChange={(e) => set(i, { amount: e.target.value })} />
              <TmsInput aria-label={`Adjustment ${i + 1} reason`} placeholder="Reason (required)" value={d.reason} disabled={locked} onChange={(e) => set(i, { reason: e.target.value })} />
              {!locked && <TmsButton size="sm" variant="ghost" aria-label={`Remove adjustment ${i + 1}`} onClick={() => setDrafts((rows) => rows.filter((_, j) => j !== i))}><Trash2 size={12} /></TmsButton>}
            </div>
          ))}
          {newTotal != null && <p className="mt-1">New total <strong aria-label="New total">{formatCents(newTotal)}</strong>{sent && !locked ? ` — saves as Rev ${(current.revision ?? 1) + 1}` : ''}</p>}
          {adjustments == null && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>Each adjustment needs a description, an amount and a reason.</p>}
        </section>

        {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}

        {!factored && current.status !== 'VOID'
          ? <section aria-label="Invoice preview"><h3 className="font-semibold">What the customer receives</h3><InvoicePacketFrame invoiceId={current.id} pdfKey={current.pdfKey} /></section>
          : pdfUrl
            ? <iframe title={`Invoice ${current.number} PDF`} src={pdfUrl} style={{ width: '100%', height: 520, border: '1px solid var(--tms-border)' }} />
            : <p className="tms-muted">{current.pdfKey ? 'Loading the PDF…' : 'No PDF stored yet.'}</p>}
      </div>
    </TmsDialog>
  )
}
