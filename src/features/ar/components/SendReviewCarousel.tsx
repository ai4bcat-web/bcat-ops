/**
 * Review before sending (Ryne, 2026-11-12): one invoice per page, ←/→ (buttons and arrow keys),
 * "3 of 12". Each page shows the invoice exactly as the customer opens it — ONE PDF, the invoice
 * then its POD pages — and the whole e-mail: From, To, CC, Subject, every attachment and the
 * body — or, for a factored customer, that the bill goes to OTR instead. Skip takes an invoice
 * out of the batch. An invoice that cannot go (no POD, no AP e-mail, carrier pay found, a POD
 * that will not merge, over 10 MB) is flagged on its page and left out of the send with its
 * reason; "Send N invoices" sends the rest and lists every result. Nothing goes before that.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, FileSearch, Loader2, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog } from '@/features/tms/kit'
import { getTmsSettings, graphqlErrorText, sendInvoice, sendToFactor } from '@/lib/apiClient'
import { InvoicePacketFrame } from './InvoicePacketFrame'
import { formatCents } from '@/lib/invoiceBuild'
import { invoiceAttachmentName, invoiceCompanyName, invoicePoNumber } from '@/lib/invoiceIdentity'
import { renderInvoiceEmail } from '@/lib/shipmentNotices'
import type { CustomerRecord, InvoiceRecord, ShipmentRecord, TmsSettings } from '@/types/tms'
import { INVOICE_FROM_ADDRESS, isFactoredInvoice, manualRecipients, sendBlockers } from '../sendReview'
import { attachmentStateText, useInvoiceAttachmentPlans } from '../useInvoiceAttachmentPlans'
import { DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import type { InvoiceAttachmentItem } from '@/lib/invoiceDelivery'
import { AttachmentInfo, AttachmentRow, AttachmentsSection, InvoiceEmailSection, InvoiceEnvelope, MessageSection } from './InvoiceEmailSections'


interface Result { invoiceId: string; number: string; ok: boolean; text: string }

export function SendReviewCarousel({ invoices, customerById, shipmentsById, isAdmin = false, onClose, onDone }: {
  invoices: InvoiceRecord[]
  /** Owner / ADMIN: may send past a carrier-pay CONTENT flag with a reason (never past a carrier document). */
  isAdmin?: boolean
  customerById: Map<string, CustomerRecord>
  shipmentsById: Map<string, ShipmentRecord>
  onClose: () => void
  onDone: () => void
}) {
  const [batch, setBatch] = useState<InvoiceRecord[]>(invoices)
  const [index, setIndex] = useState(0)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  /** What building each invoice's combined PDF said (null: built fine). */
  const [packetErrors, setPacketErrors] = useState<Record<string, string | null>>({})
  const [sending, setSending] = useState(false)
  const [results, setResults] = useState<Result[] | null>(null)

  useEffect(() => {
    let alive = true
    getTmsSettings().then((s) => { if (alive) setSettings(s) }).catch(() => { /* copy list falls back to the customer's own */ })
    return () => { alive = false }
  }, [])

  const current = batch[Math.min(index, batch.length - 1)]
  const batchIds = useMemo(() => batch.map((inv) => inv.id), [batch])
  const { plans } = useInvoiceAttachmentPlans(batchIds)
  // Per invoice: documents taken out of this e-mail, and an admin's override reason for content flags.
  const [excluded, setExcluded] = useState<Record<string, string[]>>({})
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  /** Carrier-pay flags still standing on one invoice (not removed, not overridden by an admin). */
  const openFlags = useCallback((inv: InvoiceRecord) => {
    const out = new Set(excluded[inv.id] ?? [])
    const flags = (plans.get(inv.id)?.carrierPayFlags ?? []).filter((f) => !f.documentId || !out.has(f.documentId))
    const overridden = isAdmin && (overrides[inv.id] ?? '').trim().length >= 5
    return flags.filter((f) => f.hard || !overridden)
  }, [excluded, overrides, plans, isAdmin])
  const blockersOf = useCallback((inv: InvoiceRecord) => {
    const customer = customerById.get(inv.customerId)
    return sendBlockers({
      factored: isFactoredInvoice(inv, customer),
      to: manualRecipients(customer, settings).to,
      plan: plans.get(inv.id),
      openFlags: openFlags(inv).length,
      packetError: packetErrors[inv.id],
    })
  }, [customerById, settings, plans, openFlags, packetErrors])
  const blocked = batch.filter((inv) => blockersOf(inv).length > 0)
  const sendable = batch.filter((inv) => blockersOf(inv).length === 0)

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
    const company = invoiceCompanyName(shipment?.revDivision, shipment?.revSubdivision)
    return { customer, factored, email, company, po, pro, attachment: invoiceAttachmentName(pro, po), ...manualRecipients(customer, settings) }
  }, [current, customerById, shipmentsById, settings])

  const skip = () => {
    setBatch((rows) => rows.filter((row) => row.id !== current?.id))
    setIndex((i) => Math.max(0, Math.min(i, batch.length - 2)))
  }

  const sendAll = async () => {
    setSending(true)
    const out: Result[] = blocked.map((inv) => ({ invoiceId: inv.id, number: inv.number, ok: false, text: `Left out: ${blockersOf(inv).join('; ')}` }))
    for (const inv of sendable) {
      const customer = customerById.get(inv.customerId)
      try {
        if (isFactoredInvoice(inv, customer)) {
          await sendToFactor({ invoiceId: inv.id })
          out.push({ invoiceId: inv.id, number: inv.number, ok: true, text: 'Queued for OTR' })
        } else {
          const reason = (overrides[inv.id] ?? '').trim()
          const sent = await sendInvoice({
            invoiceId: inv.id,
            ...(excluded[inv.id]?.length ? { excludeDocumentIds: excluded[inv.id] } : {}),
            ...(isAdmin && reason.length >= 5 ? { carrierPayOverrideReason: reason } : {}),
          })
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
      className="tms-dialog-wide send-review-dialog"
      footer={
        <>
          <span className="mr-auto flex flex-wrap items-center gap-2 text-sm" role="status" aria-label="Batch summary">
            <TmsBadge tone="green">{sendable.length} ready</TmsBadge>
            {blocked.length > 0 && (
              <span style={{ color: 'var(--tms-badge-red)' }}>
                <TmsBadge tone="red">{blocked.length} blocked</TmsBadge> {blocked.map((inv) => inv.number).join(', ')} — left out
              </span>
            )}
            {invoices.length - batch.length > 0 && <TmsBadge tone="gray">{invoices.length - batch.length} skipped</TmsBadge>}
          </span>
          <TmsButton variant="ghost" onClick={onClose} disabled={sending}>Cancel</TmsButton>
          <TmsButton variant="primary" aria-label="Send invoices" disabled={sending || sendable.length === 0}
            title={blocked.length > 0 ? `${blocked.map((inv) => `${inv.number}: ${blockersOf(inv).join('; ')}`).join('\n')}\nThese are left out of the send.` : undefined}
            onClick={() => void sendAll()}>
            {sending ? <><Loader2 size={14} className="animate-spin" /> Sending…</> : `Send ${sendable.length} invoice${sendable.length === 1 ? '' : 's'}`}
          </TmsButton>
        </>
      }
    >
      {!current || !page ? <p className="tms-muted">Nothing left in this batch.</p> : (
        <div className="flex flex-col gap-3">
          <div className="send-review-head">
            <span className="send-review-nav">
              <TmsButton size="sm" variant="ghost" aria-label="Previous invoice" disabled={index === 0} onClick={() => go(-1)}><ChevronLeft size={16} /></TmsButton>
              <span aria-label="Page" className="send-review-page">{index + 1} of {batch.length}</span>
              <TmsButton size="sm" variant="ghost" aria-label="Next invoice" disabled={index >= batch.length - 1} onClick={() => go(1)}><ChevronRight size={16} /></TmsButton>
            </span>
            <span className="send-review-id">
              <span className="send-review-number">Invoice {current.number}</span>
              <span className="send-review-meta">
                <span>{current.customerName}</span>
                <span aria-hidden="true">·</span>
                <span className="send-review-amount">{formatCents(current.totalCents)}</span>
                {page.company && <><span aria-hidden="true">·</span><span>{page.company}</span></>}
                {page.po && <><span aria-hidden="true">·</span><span>PO {page.po}</span></>}
                <TmsBadge tone={page.factored ? 'purple' : 'blue'}>{page.factored ? 'OTR' : 'Manual'}</TmsBadge>
              </span>
            </span>
            <span className="send-review-actions">
              <Link className="tms-btn tms-btn-ghost tms-btn-sm" to={`/tms/invoicing/invoices/${current.id}`} target="_blank" aria-label={`Edit invoice ${current.number}`}>
                <ExternalLink size={13} /> Edit invoice
              </Link>
              <TmsButton size="sm" variant="ghost" aria-label={`Skip invoice ${current.number}`} onClick={skip}><X size={13} /> Skip this one</TmsButton>
            </span>
          </div>
          {blockersOf(current).length > 0 && (
            <div role="alert" aria-label="Cannot send" className="send-review-blockers">
              <AlertTriangle size={16} style={{ flex: 'none', marginTop: 1 }} />
              <span><strong>Will not be sent:</strong> {blockersOf(current).join('; ')}. Fix it, or Skip it — the rest still go.</span>
            </div>
          )}
          {page.factored ? (
            <p className="text-sm" aria-label="Goes to OTR"><TmsBadge tone="purple">Goes to OTR</TmsBadge> Factored customer: this invoice is queued for OTR, not e-mailed.</p>
          ) : (
            <div className="send-review-grid">
              <div className="send-review-col">
                <InvoiceEnvelope from={INVOICE_FROM_ADDRESS} to={page.to} cc={page.cc} subject={page.email.subject} />
                <AttachmentsSection>
                  <AttachmentList plan={plans.get(current.id)} fallback={page.attachment} excluded={excluded[current.id] ?? []} />
                  <CarrierPayFlags
                    flags={plans.get(current.id)?.carrierPayFlags ?? []}
                    excluded={excluded[current.id] ?? []}
                    isAdmin={isAdmin}
                    override={overrides[current.id] ?? ''}
                    onRemove={(docId) => setExcluded((prev) => ({ ...prev, [current.id]: [...(prev[current.id] ?? []), docId] }))}
                    onOverride={(text) => setOverrides((prev) => ({ ...prev, [current.id]: text }))}
                  />
                </AttachmentsSection>
                <MessageSection body={page.email.body} />
              </div>
              <div className="send-review-col send-review-pdf">
                <InvoiceEmailSection title="PDF the customer opens" icon={<FileSearch size={14} />} label="PDF preview">
                  <InvoicePacketFrame
                    key={current.id}
                    invoiceId={current.id}
                    pdfKey={current.pdfKey}
                    excludeDocumentIds={excluded[current.id]}
                    height={640}
                    onLoaded={(p) => setPacketErrors((prev) => ({ ...prev, [p.invoiceId]: p.error }))}
                  />
                </InvoiceEmailSection>
              </div>
            </div>
          )}
        </div>
      )}
    </TmsDialog>
  )
}

function sizeText(bytes: number | null): string {
  if (bytes == null) return ''
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function typeLabel(item: InvoiceAttachmentItem): string {
  return item.type === 'INVOICE_PDF' ? 'Invoice' : DOCUMENT_TYPE_LABELS[item.type]
}

/** Every file the e-mail carries, and why a POD or rate con is (not) among them. */
function AttachmentList({ plan, fallback, excluded }: {
  plan: ReturnType<typeof useInvoiceAttachmentPlans>['plans'] extends Map<string, infer R> ? R | undefined : never
  fallback: string
  excluded: readonly string[]
}) {
  if (!plan) return <AttachmentInfo>{fallback} · checking documents…</AttachmentInfo>
  if (plan.error) return <AttachmentInfo tone="warn">{fallback} ({plan.error})</AttachmentInfo>
  const items = (plan.items ?? []).filter((item) => !item.documentId || !excluded.includes(item.documentId))
  return (
    <div className="flex flex-col gap-2">
      <ul className="inv-email-files" aria-label="Attachment list">
        {items.map((item) => (
          <AttachmentRow
            key={item.documentId ?? item.name}
            name={item.name}
            type={typeLabel(item)}
            nested={item.inInvoicePdf}
            note={item.inInvoicePdf ? 'pages inside the invoice PDF' : undefined}
            size={item.sizeBytes != null ? sizeText(item.sizeBytes) : undefined}
          />
        ))}
      </ul>
      <span className="inv-email-badges">
        <TmsBadge tone={plan.pod === 'ATTACHED' ? 'green' : 'red'}>POD {attachmentStateText(plan.pod)}</TmsBadge>
        <TmsBadge tone={plan.rateCon === 'ATTACHED' ? 'green' : plan.rateCon === 'MISSING' ? 'orange' : 'gray'}>RC {attachmentStateText(plan.rateCon)}</TmsBadge>
      </span>
      {plan.pod === 'MISSING' && <AttachmentInfo tone="error">No POD on file — file one before this invoice can go.</AttachmentInfo>}
      {plan.rateCon === 'NOT_INCLUDED' && <AttachmentInfo>Rate confirmation not included: BCAT Logistics invoices never carry a rate confirmation.</AttachmentInfo>}
      {plan.rateCon === 'MISSING' && <AttachmentInfo tone="warn">Ivan Cartage invoice: no customer rate confirmation on file.</AttachmentInfo>}
      {plan.tooBig && <AttachmentInfo tone="error">Over 10 MB — this e-mail will be refused. Remove a document first.</AttachmentInfo>}
    </div>
  )
}

/** Ryne's hard rule, shown before anyone presses Send: a file that shows carrier pay never goes to a customer. */
function CarrierPayFlags({ flags, excluded, isAdmin, override, onRemove, onOverride }: {
  flags: { documentId: string | null; name: string; reason: string; hard: boolean }[]
  excluded: readonly string[]
  isAdmin: boolean
  override: string
  onRemove: (documentId: string) => void
  onOverride: (text: string) => void
}) {
  const open = flags.filter((f) => !f.documentId || !excluded.includes(f.documentId))
  if (open.length === 0) return null
  const contentOnly = open.every((f) => !f.hard)
  return (
    <div role="alert" aria-label="Carrier pay detected" className="mt-2 flex flex-col gap-1 rounded p-2"
      style={{ border: '1px solid var(--tms-badge-red)', color: 'var(--tms-badge-red)' }}>
      {open.map((f) => (
        <div key={`${f.documentId ?? f.name}-${f.reason}`} className="flex flex-wrap items-center gap-2">
          <strong>Carrier pay detected in {f.name}</strong> <span>— {f.reason}. Blocked.</span>
          {f.documentId && (
            <TmsButton size="sm" variant="ghost" aria-label={`Remove ${f.name} from this e-mail`} onClick={() => onRemove(String(f.documentId))}>
              Remove from this e-mail
            </TmsButton>
          )}
        </div>
      ))}
      {contentOnly && isAdmin && (
        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--tms-text)' }}>
          Admin override — send anyway (reason required, recorded):
          <input className="tms-input" aria-label="Carrier pay override reason" value={override} onChange={(e) => onOverride(e.target.value)}
            placeholder="Why this file may go to the customer" />
        </label>
      )}
    </div>
  )
}
