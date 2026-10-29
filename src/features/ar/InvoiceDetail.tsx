/**
 * `/ar/invoices/:id` — one issued bill, everything that has happened to it, and the four
 * things anybody does next: e-mail it, bank it, factor it, or void it.
 *
 * The page is deliberately literal about the e-mail history. SES is denied outside
 * production, so on dev every send comes back NOT_SENT with the refusal attached; the
 * row says "Not sent" and offers the body to copy, rather than a green tick for a mail
 * that never left. A bill the customer never received, shown as sent, is money that goes
 * uncollected for a month.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, Copy, Download, ExternalLink, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import type { ArPaymentMethod, InvoiceStatus } from '@/types/tms'

type DetailDialog =
  | { kind: 'email' }
  | { kind: 'payment'; method?: ArPaymentMethod }
  | { kind: 'factor' }
  | { kind: 'writeOff' }
  | { kind: 'void' }
  | { kind: 'markSent' }

const STATUS_TONE: Record<InvoiceStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ISSUED: 'outline',
  PARTIAL: 'secondary',
  PAID: 'default',
  VOID: 'destructive',
}

const CARD = 'rounded-md border border-border bg-card p-4'
const TH = 'px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-1.5 align-top'
const MONEY = 'px-2 py-1.5 text-right tabular-nums align-top'

export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>()
  const { invoice, bundle, notices, payments, loading, error, refresh } = useInvoice(id ?? null)
  const { items: factoringItems } = useFactoringItems()
  // Groups, not `useAuth()`: this page is also mounted in tests and drawers that sit
  // outside the provider, and the commission card's two buttons are not worth throwing
  // the whole invoice away for. The server decides either way.
  const groups = useAuthUser()?.groups ?? []

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

  if (!id) return <p className="p-6 text-sm text-muted-foreground">No invoice selected.</p>
  if (!invoice) {
    return (
      <div className="p-6 text-sm">
        {loading ? <span className="text-muted-foreground">Loading invoice…</span> : null}
        {!loading && <span className="text-destructive">{error ?? 'Invoice not found.'}</span>}
      </div>
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
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/ar" aria-label="Back to AR"><ChevronLeft size={14} className="mr-1" /> AR</Link>
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-auto px-6 py-4">
        <header className={CARD}>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">{invoice.number}</h1>
            <Badge variant={STATUS_TONE[invoice.status]}>{invoice.status}</Badge>
            <Badge variant={chip.late ? 'destructive' : 'outline'} className="text-[10px]">{chip.label}</Badge>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" aria-label="E-mail invoice" disabled={busy} onClick={() => setDialog({ kind: 'email' })}>
                E-mail
              </Button>
              <Button size="sm" variant="outline" aria-label="Receive payment" disabled={busy} onClick={() => setDialog({ kind: 'payment' })}>
                Receive payment
              </Button>
              <Button size="sm" variant="outline" aria-label="Send to factor" disabled={busy} onClick={() => setDialog({ kind: 'factor' })}>
                Send to Factor
              </Button>
              <Button size="sm" variant="outline" aria-label="Write off balance" disabled={busy} onClick={() => setDialog({ kind: 'writeOff' })}>
                Write off
              </Button>
              <Button size="sm" variant="destructive" aria-label="Void invoice" disabled={busy} onClick={() => setDialog({ kind: 'void' })}>
                Void
              </Button>
            </div>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <Field label="Customer" value={invoice.customerName ?? invoice.customerId} />
            <Field label="Bill-to" value={invoice.billTo?.name ?? invoice.customerName ?? '—'} />
            <Field
              label="Shipment"
              value={
                <Link className="text-primary hover:underline" to={`/shipments/${invoice.shipmentId}`}>
                  {invoice.shipmentNumber ?? invoice.shipmentId}
                </Link>
              }
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
        </header>

        <section className={CARD}>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold">PDF</h2>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" aria-label="Re-render invoice PDF" disabled={busy} onClick={runRender}>
                <RefreshCw size={14} className="mr-1" /> Re-render
              </Button>
              {pdfUrl && (
                <Button size="sm" variant="outline" aria-label="Download invoice PDF" onClick={downloadPdf}>
                  <Download size={14} className="mr-1" /> Download
                </Button>
              )}
            </div>
          </div>
          {!pdfKey && (
            <p className="text-sm text-muted-foreground">
              No PDF stored yet. Re-render writes one from the invoice snapshot — nothing on the bill changes.
            </p>
          )}
          {pdfKey && !pdfUrl && <p className="text-sm text-muted-foreground">Opening the stored PDF…</p>}
          {pdfKey && pdfUrl && (
            <iframe title={`Invoice ${invoice.number} PDF`} src={pdfUrl} className="h-[560px] w-full rounded border border-border" />
          )}
        </section>

        <section className={CARD}>
          <h2 className="mb-2 text-sm font-semibold">Lines</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={TH} scope="col">Code</th>
                <th className={TH} scope="col">Description</th>
                <th className={`${TH} text-right`} scope="col">Rate</th>
                <th className={`${TH} text-right`} scope="col">Count</th>
                <th className={`${TH} text-right`} scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={5} className="py-4 text-center text-sm text-muted-foreground">This invoice has no lines.</td></tr>
              )}
              {lines.map((line) => (
                <tr key={line.chargeId} className="border-b border-border/60">
                  <td className={TD}>{line.code}</td>
                  <td className={TD}>{line.label ?? line.code}</td>
                  <td className={MONEY}>{formatCents(line.rateCents)}</td>
                  <td className={MONEY}>{line.count}</td>
                  <td className={MONEY}>{formatCents(line.amountCents)}</td>
                </tr>
              ))}
              <tr>
                <td className={TD} colSpan={4}>Subtotal</td>
                <td className={MONEY}>{formatCents(invoice.subtotalCents)}</td>
              </tr>
              <tr>
                <td className={`${TD} font-semibold`} colSpan={4}>Total</td>
                <td className={`${MONEY} font-semibold`}>{formatCents(invoice.totalCents)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className={CARD}>
            <h2 className="mb-2 text-sm font-semibold">References</h2>
            {references.length === 0 && <p className="text-sm text-muted-foreground">None on the bill.</p>}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {references.map((r) => (
                <Field key={`${r.code}:${r.value}`} label={r.label ?? r.code} value={r.value} />
              ))}
            </dl>
          </section>

          <section className={CARD}>
            <h2 className="mb-2 text-sm font-semibold">Attachments</h2>
            {attachments.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing was attached to this invoice.</p>
            )}
            <ul className="space-y-1 text-sm">
              {attachments.map((doc) => (
                <li key={doc.id} className="flex items-center gap-2">
                  <span className="text-muted-foreground">{doc.type}</span>
                  <span>{doc.name}</span>
                  <span className="text-xs text-muted-foreground">{Math.round(doc.sizeBytes / 1024)} KB</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className={CARD}>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold">E-mail history</h2>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" aria-label="Resend invoice" disabled={busy} onClick={() => setDialog({ kind: 'email' })}>
                Resend
              </Button>
              <Button size="sm" variant="outline" aria-label="Mark as sent" disabled={busy} onClick={() => setDialog({ kind: 'markSent' })}>
                Mark as sent
              </Button>
            </div>
          </div>

          {notices.length === 0 && (
            <p className="text-sm text-muted-foreground">This invoice has never been e-mailed from here.</p>
          )}
          <ul className="space-y-2">
            {notices.map((notice) => {
              const detail = noticeStatusDetail(notice)
              return (
                <li key={notice.id} className="rounded border border-border/60 p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={notice.status === 'SENT' ? 'default' : 'destructive'} className="text-[10px]">
                      {NOTICE_STATUS_LABEL[notice.status]}
                    </Badge>
                    <span>{recipientList(notice.to) || 'no recipients'}</span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(notice.at)}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      aria-label={`Copy e-mail body sent ${notice.at}`}
                      onClick={() => copyBody(notice.body)}
                    >
                      <Copy size={13} className="mr-1" /> Copy body
                    </Button>
                  </div>
                  {notice.cc && <p className="text-xs text-muted-foreground">cc {recipientList(notice.cc)}</p>}
                  <p className="mt-1 text-xs">{notice.subject}</p>
                  {detail && <p className="mt-1 text-xs text-destructive">{detail}</p>}
                </li>
              )
            })}
          </ul>
          {invoice.markedSentAt && (
            <p className="mt-2 text-xs text-muted-foreground">
              Marked sent by hand on {formatDateTime(invoice.markedSentAt)} by {invoice.markedSentBy ?? 'unknown'}.
            </p>
          )}
        </section>

        <section className={CARD}>
          <h2 className="mb-2 text-sm font-semibold">Payments applied</h2>
          {payments.length === 0 && <p className="text-sm text-muted-foreground">Nothing has been put against this invoice.</p>}
          {payments.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH} scope="col">Kind</th>
                  <th className={TH} scope="col">Date</th>
                  <th className={TH} scope="col">Reference</th>
                  <th className={`${TH} text-right`} scope="col">Applied here</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b border-border/60">
                    <td className={TD}>{p.kind}</td>
                    <td className={TD}>{formatDay(p.receivedAt)}</td>
                    <td className={TD}>{p.reference || '—'}</td>
                    <td className={MONEY}>{formatCents(appliedToInvoice(p, invoice.id))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <InvoiceCommissionCard
          invoiceId={invoice.id}
          orderId={invoice.orderId}
          isAdmin={groups.includes('ADMIN')}
          isManager={groups.includes('role-MANAGER')}
        />

        <section className={CARD}>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold">Factoring</h2>
            <Button asChild size="sm" variant="ghost" className="ml-auto">
              <Link to="/factoring" aria-label="Open the factoring queue">
                Factoring queue <ExternalLink size={13} className="ml-1" />
              </Link>
            </Button>
          </div>
          {!factoringItem && (
            <p className="text-sm text-muted-foreground">
              {invoice.factoringItemId
                ? 'A queue row exists but has not loaded yet.'
                : 'Not in the factoring queue. "Send to Factor" writes the row; submitting it to OTR stays a step on the queue page.'}
            </p>
          )}
          {factoringItem && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <Field label="PRO" value={factoringItem.proNumber} />
              <Field label="Queue status" value={factoringItem.status} />
              <Field label="OTR status" value={otrStatusLabel(factoringItem.otrStatus) ?? 'Not submitted'} />
              <Field label="Submitted" value={factoringItem.otrSubmittedAt ? formatDay(factoringItem.otrSubmittedAt) : '—'} />
            </dl>
          )}
          <div className="mt-2">
            <Button
              size="sm"
              variant="outline"
              aria-label="Record factor payment"
              disabled={busy}
              onClick={() => setDialog({ kind: 'payment', method: 'FACTOR' })}
            >
              Record factor payment
            </Button>
          </div>
        </section>
      </div>

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
          description="Voiding reopens the order for a fresh invoice and leaves this one on the record. It cannot be undone."
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
    </div>
  )
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

