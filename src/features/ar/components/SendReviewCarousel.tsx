/**
 * Review before sending (Ryne, 2026-11-12): one invoice per page, ←/→ (buttons and arrow keys),
 * "3 of 12". Each page shows the invoice PDF and the whole e-mail exactly as it will go out —
 * From, To, CC, Subject, attachment name and body — or, for a factored customer, that the bill
 * goes to OTR instead. Edit opens the invoice and comes back; Skip takes it out of the batch;
 * "Send N invoices" sends what is left and lists each result.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog } from '@/features/tms/kit'
import { getInvoicePdfUrl, getTmsSettings, graphqlErrorText, sendInvoice, sendToFactor } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { invoiceAttachmentName, invoiceCompanyName, invoicePoNumber } from '@/lib/invoiceIdentity'
import { renderInvoiceEmail } from '@/lib/shipmentNotices'
import type { CustomerRecord, InvoiceRecord, ShipmentRecord, TmsSettings } from '@/types/tms'
import { INVOICE_FROM_ADDRESS, isFactoredInvoice, manualRecipients } from '../sendReview'

interface Result { invoiceId: string; number: string; ok: boolean; text: string }

export function SendReviewCarousel({ invoices, customerById, shipmentsById, onClose, onDone }: {
  invoices: InvoiceRecord[]
  customerById: Map<string, CustomerRecord>
  shipmentsById: Map<string, ShipmentRecord>
  onClose: () => void
  onDone: () => void
}) {
  const [batch, setBatch] = useState<InvoiceRecord[]>(invoices)
  const [index, setIndex] = useState(0)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [pdfUrls, setPdfUrls] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [results, setResults] = useState<Result[] | null>(null)

  useEffect(() => {
    let alive = true
    getTmsSettings().then((s) => { if (alive) setSettings(s) }).catch(() => { /* copy list falls back to the customer's own */ })
    return () => { alive = false }
  }, [])

  const current = batch[Math.min(index, batch.length - 1)]
  useEffect(() => {
    let alive = true
    const key = current?.pdfKey
    if (current && key && !pdfUrls[current.id]) {
      getInvoicePdfUrl(key).then((url) => { if (alive) setPdfUrls((prev) => ({ ...prev, [current.id]: url })) }).catch(() => undefined)
    }
    return () => { alive = false }
  }, [current, pdfUrls])

  const go = useCallback((delta: number) => setIndex((i) => Math.max(0, Math.min(batch.length - 1, i + delta))), [batch.length])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  const page = useMemo(() => {
    if (!current) return null
    const customer = customerById.get(current.customerId)
    const shipment = shipmentsById.get(current.shipmentId)
    const factored = isFactoredInvoice(current, customer)
    const po = invoicePoNumber(current.references)
    const pro = current.shipmentNumber || current.number
    const email = renderInvoiceEmail({
      invoice: current,
      customerName: current.customerName ?? customer?.name ?? null,
      brokerName: 'BCAT',
      po,
      companyName: invoiceCompanyName(shipment?.revDivision, shipment?.revSubdivision),
    })
    return { customer, factored, email, attachment: invoiceAttachmentName(pro, po), ...manualRecipients(customer, settings) }
  }, [current, customerById, shipmentsById, settings])

  const skip = () => {
    setBatch((rows) => rows.filter((row) => row.id !== current?.id))
    setIndex((i) => Math.max(0, Math.min(i, batch.length - 2)))
  }

  const sendAll = async () => {
    setSending(true)
    const out: Result[] = []
    for (const inv of batch) {
      const customer = customerById.get(inv.customerId)
      try {
        if (isFactoredInvoice(inv, customer)) {
          await sendToFactor({ invoiceId: inv.id })
          out.push({ invoiceId: inv.id, number: inv.number, ok: true, text: 'Queued for OTR' })
        } else {
          const sent = await sendInvoice({ invoiceId: inv.id })
          const ok = sent.emailStatus === 'SENT'
          out.push({ invoiceId: inv.id, number: inv.number, ok, text: ok ? `Sent to ${sent.to.join(', ')}` : (sent.emailError ?? `Not sent (${sent.emailStatus})`) })
        }
      } catch (err) {
        out.push({ invoiceId: inv.id, number: inv.number, ok: false, text: graphqlErrorText(err) })
      }
    }
    setResults(out)
    setSending(false)
    const okCount = out.filter((r) => r.ok).length
    if (okCount) toast.success(`Sent ${okCount} of ${out.length}`)
    onDone()
  }

  if (results) {
    return (
      <TmsDialog open onOpenChange={(open) => { if (!open) onClose() }} title="Send results" className="tms-dialog-wide"
        footer={<TmsButton variant="primary" onClick={onClose}>Done</TmsButton>}>
        <ul className="flex flex-col gap-1 text-sm" aria-label="Send results">
          {results.map((r) => (
            <li key={r.invoiceId} className="flex gap-2">
              <TmsBadge tone={r.ok ? 'green' : 'red'}>{r.ok ? 'Sent' : 'Not sent'}</TmsBadge>
              <strong>{r.number}</strong> <span className="tms-muted">{r.text}</span>
            </li>
          ))}
        </ul>
      </TmsDialog>
    )
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Review and send invoices"
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={sending}>Cancel</TmsButton>
          <TmsButton variant="primary" aria-label="Send invoices" disabled={sending || batch.length === 0} onClick={() => void sendAll()}>
            {sending ? <><Loader2 size={14} className="animate-spin" /> Sending…</> : `Send ${batch.length} invoice${batch.length === 1 ? '' : 's'}`}
          </TmsButton>
        </>
      }
    >
      {!current || !page ? <p className="tms-muted">Nothing left in this batch.</p> : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <TmsButton size="sm" variant="ghost" aria-label="Previous invoice" disabled={index === 0} onClick={() => go(-1)}><ChevronLeft size={16} /></TmsButton>
            <span aria-label="Page" className="text-sm">{index + 1} of {batch.length}</span>
            <TmsButton size="sm" variant="ghost" aria-label="Next invoice" disabled={index >= batch.length - 1} onClick={() => go(1)}><ChevronRight size={16} /></TmsButton>
            <strong className="ml-2">{current.number}</strong>
            <span className="tms-muted text-sm">{current.customerName} · {formatCents(current.totalCents)}</span>
            <span className="ml-auto flex gap-1">
              <Link className="tms-btn tms-btn-ghost tms-btn-sm" to={`/tms/invoicing/invoices/${current.id}`} target="_blank" aria-label={`Edit invoice ${current.number}`}>
                <ExternalLink size={13} /> Edit
              </Link>
              <TmsButton size="sm" variant="ghost" aria-label={`Skip invoice ${current.number}`} onClick={skip}><X size={13} /> Skip</TmsButton>
            </span>
          </div>
          {page.factored ? (
            <p className="text-sm" aria-label="Goes to OTR"><TmsBadge tone="purple">Goes to OTR</TmsBadge> Factored customer: this invoice is queued for OTR, not e-mailed.</p>
          ) : (
            <dl className="grid gap-1 text-sm" style={{ gridTemplateColumns: 'max-content 1fr' }}>
              <dt className="tms-muted">From</dt><dd>{INVOICE_FROM_ADDRESS}</dd>
              <dt className="tms-muted">To</dt><dd aria-label="Invoice to">{page.to.join(', ') || <span style={{ color: 'var(--tms-badge-red)' }}>No AP e-mail on file</span>}</dd>
              <dt className="tms-muted">CC</dt><dd aria-label="Invoice cc">{page.cc.join(', ') || '—'}</dd>
              <dt className="tms-muted">Subject</dt><dd aria-label="Invoice subject">{page.email.subject}</dd>
              <dt className="tms-muted">Attachment</dt><dd aria-label="Invoice attachment">{page.attachment}</dd>
              <dt className="tms-muted">Body</dt><dd aria-label="Invoice body" style={{ whiteSpace: 'pre-wrap' }}>{page.email.body}</dd>
            </dl>
          )}
          {pdfUrls[current.id]
            ? <iframe title={`Invoice ${current.number} PDF`} src={pdfUrls[current.id]} style={{ width: '100%', height: 480, border: '1px solid var(--tms-border)' }} />
            : <p className="text-sm tms-muted">{current.pdfKey ? 'Loading the PDF…' : 'No PDF stored yet for this invoice.'}</p>}
        </div>
      )}
    </TmsDialog>
  )
}
