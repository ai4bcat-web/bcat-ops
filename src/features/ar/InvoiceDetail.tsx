/**
 * `/tms/invoicing/invoices/:id` — one issued bill, everything that has happened to it,
 * and the actions that can still happen.
 *
 * An invoice is a snapshot: the lines, the terms and the bill-to were frozen when it was
 * generated, and nothing on this page edits them. A mistake is voided and raised again,
 * which is why Void asks for a reason and leaves the voided invoice on the record.
 *
 * On dev, SES is denied: an invoice e-mail comes back NOT_SENT with the refusal and a
 * signed download. The E-mail tab reports exactly that and never claims a send that did
 * not happen.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, Copy, Download, ExternalLink, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsPage, TmsTabs, statusTone } from '@/features/tms/kit'
import { useAuthUser } from '@/hooks/useAuth'
import { useFactoringItems } from '@/hooks/useFactoringItems'
import { useInvoice } from '@/hooks/useInvoice'
import {
  getInvoicePdfUrl, graphqlErrorText, markInvoiceSent, renderInvoicePdf, voidInvoice,
} from '@/lib/apiClient'
import { chicagoDateStr, formatDateTime } from '@/lib/date'
import { downloadFromUrl } from '@/lib/download'
import { formatCents } from '@/lib/invoiceBuild'
import { otrStatusLabel } from '@/lib/otrInvoiceStatus'
import { InvoiceCommissionCard } from '@/features/commissions/CommissionsPage'
import {
  NOTICE_STATUS_LABEL, agingChipFor, appliedToInvoice, formatDay, noticeStatusDetail, recipientList,
} from './arViews'
import { EmailInvoiceDialog } from './components/EmailInvoiceDialog'
import { ReasonDialog } from './components/ReasonDialog'
import { ReceivePaymentDialog } from './components/ReceivePaymentDialog'
import { SendToFactorDialog } from './components/SendToFactorDialog'
import { WriteOffDialog } from './components/WriteOffDialog'
import type { ArPaymentMethod } from '@/types/tms'

type DetailDialog =
  | { kind: 'email' }
  | { kind: 'payment'; method?: ArPaymentMethod }
  | { kind: 'factor' }
  | { kind: 'writeOff' }
  | { kind: 'void' }
  | { kind: 'markSent' }

const TABS = [
  { key: 'summary', label: 'Summary' },
  { key: 'pdf', label: 'PDF' },
  { key: 'email', label: 'E-mail' },
  { key: 'payments', label: 'Payments' },
  { key: 'factoring', label: 'Factoring' },
]

const RED = { color: 'var(--tms-badge-red)' }

export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>()
  const { invoice, bundle, notices, payments, loading, error, refresh } = useInvoice(id ?? null)
  const { items: factoringItems } = useFactoringItems()
  // Groups, not `useAuth()`: this page is also mounted in tests and drawers that sit
  // outside the provider, and the commission card's two buttons are not worth throwing
  // the whole invoice away for. The server decides either way.
  const groups = useAuthUser()?.groups ?? []

  const [tab, setTab] = useState('summary')
  const [dialog, setDialog] = useState<DetailDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [asOf] = useState(() => chicagoDateStr(new Date()))

  const pdfKey = invoice?.pdfKey ?? null

  // Presigned URLs expire; this re-reads one whenever the stored key changes (a
  // re-render bumps `pdfVersion` and writes a new key). No synchronous setState in the
  // effect — the write happens in the promise chain.
  const loadPdf = useCallback(() => {
    if (!pdfKey) return Promise.resolve()
    return getInvoicePdfUrl(pdfKey)
      .then((url) => setPdfUrl(url))
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not open the invoice PDF'))
  }, [pdfKey])
  useEffect(() => { loadPdf() }, [loadPdf])

  if (!id) return <p className="tms-muted">No invoice selected.</p>
  if (!invoice) {
    return (
      <p>
        {loading ? <span className="tms-muted">Loading invoice…</span> : null}
        {!loading && <span style={RED}>{error ?? 'Invoice not found.'}</span>}
      </p>
    )
  }

  const chip = agingChipFor(invoice.dueAt, asOf)
  const factoringItem = invoice.factoringItemId
    ? factoringItems.find((f) => f.id === invoice.factoringItemId) ?? null
    : null
  const attachments = (bundle?.documents ?? []).filter((d) => (invoice.attachDocumentIds ?? []).includes(d.id))
  const lines = invoice.lines ?? []
  const references = invoice.references ?? []

  const runRender = () => {
    setBusy(true)
    renderInvoicePdf({ invoiceId: invoice.id })
      .then(() => {
        toast.success('PDF re-rendered')
        return refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not render the PDF'))
      .finally(() => setBusy(false))
  }

  const runVoid = (reason: string) => {
    setBusy(true)
    voidInvoice({ invoiceId: invoice.id, reason })
      .then(() => {
        toast.success(`Invoice ${invoice.number} voided`)
        setDialog(null)
        return refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not void the invoice'))
      .finally(() => setBusy(false))
  }

  const runMarkSent = (note: string) => {
    setBusy(true)
    markInvoiceSent({ invoiceId: invoice.id, note })
      .then(() => {
        toast.success('Recorded as sent by hand')
        setDialog(null)
        return refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not record the send'))
      .finally(() => setBusy(false))
  }

  const copyBody = (body: string) => {
    navigator.clipboard.writeText(body)
      .then(() => toast.success('E-mail body copied'))
      .catch(() => toast.error('Could not copy the body'))
  }

  const downloadPdf = () => {
    if (!pdfUrl) return
    downloadFromUrl(pdfUrl, `${invoice.number}.pdf`)
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not download the PDF'))
  }

  const closeAndRefresh = () => {
    setDialog(null)
    void refresh()
  }

  return (
    <TmsPage
      title={
        <span className="flex items-center gap-2">
          <Link className="tms-icon-btn tms-icon-btn-plain" to="/tms/invoicing" aria-label="Back to Invoicing">
            <ChevronLeft size={16} />
          </Link>
          {invoice.number}
          <TmsBadge tone={statusTone(invoice.status)}>{invoice.status}</TmsBadge>
          <TmsBadge tone={chip.late ? 'red' : 'gray'}>{chip.label}</TmsBadge>
        </span>
      }
      actions={
        <>
          <TmsButton variant="primary" aria-label="E-mail invoice" disabled={busy} onClick={() => setDialog({ kind: 'email' })}>
            E-mail
          </TmsButton>
          <TmsButton aria-label="Receive payment" disabled={busy} onClick={() => setDialog({ kind: 'payment' })}>
            Receive payment
          </TmsButton>
          <TmsButton aria-label="Send to factor" disabled={busy} onClick={() => setDialog({ kind: 'factor' })}>
            Send to Factor
          </TmsButton>
          <TmsButton aria-label="Write off balance" disabled={busy} onClick={() => setDialog({ kind: 'writeOff' })}>
            Write off
          </TmsButton>
          <TmsButton variant="destructive" aria-label="Void invoice" disabled={busy} onClick={() => setDialog({ kind: 'void' })}>
            Void
          </TmsButton>
        </>
      }
    >
      <TmsCard>
        <dl className="tms-grid tms-grid-4">
          <Field label="Customer" value={invoice.customerName ?? invoice.customerId} />
          <Field label="Bill-to" value={invoice.billTo?.name ?? invoice.customerName ?? '—'} />
          <Field
            label="Shipment"
            value={<Link to={`/tms/shipments/${invoice.shipmentId}`}>{invoice.shipmentNumber ?? invoice.shipmentId}</Link>}
          />
          <Field label="Terms" value={`Net ${invoice.termsDays}`} />
          <Field label="Issued" value={formatDay(invoice.invoiceDate)} />
          <Field label="Due" value={formatDay(invoice.dueAt)} />
          <Field label="Total" value={formatCents(invoice.totalCents)} />
          <Field label="Paid" value={formatCents(invoice.paidCents)} />
          <Field label="Written off" value={formatCents(invoice.writtenOffCents)} />
          <Field label="Balance" value={<span className="font-semibold">{formatCents(invoice.balanceCents)}</span>} />
          {invoice.status === 'VOID' && <Field label="Voided" value={invoice.voidReason ?? 'No reason recorded'} />}
        </dl>
      </TmsCard>

      <TmsTabs tabs={TABS} active={tab} onSelect={setTab} />

      {tab === 'summary' && (
        <>
          <TmsCard title="Lines" flush>
            <div className="tms-table-wrap">
              <table className="tms-table">
                <thead>
                  <tr>
                    <th scope="col">CODE</th>
                    <th scope="col">DESCRIPTION</th>
                    <th scope="col">RATE</th>
                    <th scope="col">COUNT</th>
                    <th scope="col">AMOUNT</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr><td colSpan={5} className="tms-muted">This invoice has no lines.</td></tr>
                  )}
                  {lines.map((line) => (
                    <tr key={line.chargeId}>
                      <td>{line.code}</td>
                      <td>{line.label ?? line.code}</td>
                      <td className="text-right tabular-nums">{formatCents(line.rateCents)}</td>
                      <td className="text-right tabular-nums">{line.count}</td>
                      <td className="text-right tabular-nums">{formatCents(line.amountCents)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={4}>Subtotal</td>
                    <td className="text-right tabular-nums">{formatCents(invoice.subtotalCents)}</td>
                  </tr>
                  <tr>
                    <td colSpan={4} className="font-semibold">Total</td>
                    <td className="text-right font-semibold tabular-nums">{formatCents(invoice.totalCents)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </TmsCard>

          <div className="tms-grid tms-grid-2">
            <TmsCard title="References">
              {references.length === 0 && <p className="tms-muted">None on the bill.</p>}
              <dl className="tms-grid tms-grid-2">
                {references.map((r) => (
                  <Field key={`${r.code}:${r.value}`} label={r.label ?? r.code} value={r.value} />
                ))}
              </dl>
            </TmsCard>

            <TmsCard title="Attachments">
              {attachments.length === 0 && <p className="tms-muted">Nothing was attached to this invoice.</p>}
              <ul className="flex flex-col gap-1">
                {attachments.map((doc) => (
                  <li key={doc.id} className="flex items-center gap-2">
                    <span className="tms-muted">{doc.type}</span>
                    <span>{doc.name}</span>
                    <span className="text-xs tms-muted">{Math.round(doc.sizeBytes / 1024)} KB</span>
                  </li>
                ))}
              </ul>
            </TmsCard>
          </div>
        </>
      )}

      {tab === 'pdf' && (
        <TmsCard
          title="PDF"
          actions={
            <>
              <TmsButton size="sm" aria-label="Re-render invoice PDF" disabled={busy} onClick={runRender}>
                <RefreshCw size={14} /> Re-render
              </TmsButton>
              {pdfUrl && (
                <TmsButton size="sm" aria-label="Download invoice PDF" onClick={downloadPdf}>
                  <Download size={14} /> Download
                </TmsButton>
              )}
            </>
          }
        >
          {!pdfKey && (
            <p className="tms-muted">
              No PDF stored yet. Re-render writes one from the invoice snapshot — nothing on the bill changes.
            </p>
          )}
          {pdfKey && !pdfUrl && <p className="tms-muted">Opening the stored PDF…</p>}
          {pdfKey && pdfUrl && (
            <iframe
              title={`Invoice ${invoice.number} PDF`}
              src={pdfUrl}
              className="h-[560px] w-full"
              style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
            />
          )}
        </TmsCard>
      )}

      {tab === 'email' && (
        <TmsCard
          title="E-mail history"
          actions={
            <>
              <TmsButton size="sm" aria-label="Resend invoice" disabled={busy} onClick={() => setDialog({ kind: 'email' })}>
                Resend
              </TmsButton>
              <TmsButton size="sm" aria-label="Mark as sent" disabled={busy} onClick={() => setDialog({ kind: 'markSent' })}>
                Mark as sent
              </TmsButton>
            </>
          }
        >
          {notices.length === 0 && <p className="tms-muted">This invoice has never been e-mailed from here.</p>}
          <ul className="flex flex-col gap-2">
            {notices.map((notice) => {
              const detail = noticeStatusDetail(notice)
              return (
                <li
                  key={notice.id}
                  className="p-2"
                  style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <TmsBadge tone={notice.status === 'SENT' ? 'green' : 'red'}>
                      {NOTICE_STATUS_LABEL[notice.status]}
                    </TmsBadge>
                    <span>{recipientList(notice.to) || 'no recipients'}</span>
                    <span className="text-xs tms-muted">{formatDateTime(notice.at)}</span>
                    <TmsButton
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      aria-label={`Copy e-mail body sent ${notice.at}`}
                      onClick={() => copyBody(notice.body)}
                    >
                      <Copy size={13} /> Copy body
                    </TmsButton>
                  </div>
                  {notice.cc && <p className="text-xs tms-muted">cc {recipientList(notice.cc)}</p>}
                  <p className="mt-1 text-xs">{notice.subject}</p>
                  {detail && <p className="mt-1 text-xs" style={RED}>{detail}</p>}
                </li>
              )
            })}
          </ul>
          {invoice.markedSentAt && (
            <p className="mt-2 text-xs tms-muted">
              Marked sent by hand on {formatDateTime(invoice.markedSentAt)} by {invoice.markedSentBy ?? 'unknown'}.
            </p>
          )}
        </TmsCard>
      )}

      {tab === 'payments' && (
        <>
          <TmsCard title="Payments applied" flush={payments.length > 0}>
            {payments.length === 0 && <p className="tms-muted">Nothing has been put against this invoice.</p>}
            {payments.length > 0 && (
              <div className="tms-table-wrap">
                <table className="tms-table">
                  <thead>
                    <tr>
                      <th scope="col">KIND</th>
                      <th scope="col">DATE</th>
                      <th scope="col">REFERENCE</th>
                      <th scope="col">APPLIED HERE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td>{p.kind}</td>
                        <td>{formatDay(p.receivedAt)}</td>
                        <td>{p.reference || '—'}</td>
                        <td className="text-right tabular-nums">{formatCents(appliedToInvoice(p, invoice.id))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TmsCard>

          <InvoiceCommissionCard
            invoiceId={invoice.id}
            orderId={invoice.orderId}
            isAdmin={groups.includes('ADMIN')}
            isManager={groups.includes('role-MANAGER')}
          />
        </>
      )}

      {tab === 'factoring' && (
        <TmsCard
          title="Factoring"
          actions={
            <Link className="tms-btn tms-btn-ghost tms-btn-sm" to="/tms/factors" aria-label="Open the factoring queue">
              Factoring queue <ExternalLink size={13} />
            </Link>
          }
        >
          {!factoringItem && (
            <p className="tms-muted">
              {invoice.factoringItemId
                ? 'A queue row exists but has not loaded yet.'
                : 'Not in the factoring queue. "Send to Factor" writes the row; submitting it to OTR stays a step on the queue page.'}
            </p>
          )}
          {factoringItem && (
            <dl className="tms-grid tms-grid-4">
              <Field label="PRO" value={factoringItem.proNumber} />
              <Field label="Queue status" value={factoringItem.status} />
              <Field label="OTR status" value={otrStatusLabel(factoringItem.otrStatus) ?? 'Not submitted'} />
              <Field label="Submitted" value={factoringItem.otrSubmittedAt ? formatDay(factoringItem.otrSubmittedAt) : '—'} />
            </dl>
          )}
          <div className="mt-2">
            <TmsButton
              aria-label="Record factor payment"
              disabled={busy}
              onClick={() => setDialog({ kind: 'payment', method: 'FACTOR' })}
            >
              Record factor payment
            </TmsButton>
          </div>
        </TmsCard>
      )}

      {dialog?.kind === 'email' && (
        <EmailInvoiceDialog invoiceId={invoice.id} busy={busy} onClose={() => setDialog(null)} onDone={closeAndRefresh} />
      )}
      {dialog?.kind === 'payment' && (
        <ReceivePaymentDialog
          customerId={invoice.customerId}
          customerName={invoice.customerName ?? ''}
          invoiceId={invoice.id}
          method={dialog.method}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'factor' && (
        <SendToFactorDialog invoiceId={invoice.id} busy={busy} onClose={() => setDialog(null)} onDone={closeAndRefresh} />
      )}
      {dialog?.kind === 'writeOff' && (
        <WriteOffDialog invoice={invoice} busy={busy} onClose={() => setDialog(null)} onDone={closeAndRefresh} />
      )}
      {dialog?.kind === 'void' && (
        <ReasonDialog
          title={`Void invoice ${invoice.number}`}
          description="Voiding reopens the shipment for a fresh invoice and leaves this one on the record. It cannot be undone."
          label="Why it is being voided"
          confirmLabel="Void invoice"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={runVoid}
        />
      )}
      {dialog?.kind === 'markSent' && (
        <ReasonDialog
          title="Mark as sent"
          description="Records that this invoice reached the customer another way. It does not send anything."
          label="How it was sent"
          confirmLabel="Mark as sent"
          tone="default"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={runMarkSent}
        />
      )}
    </TmsPage>
  )
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider tms-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
