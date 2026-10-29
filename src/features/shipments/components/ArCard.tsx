/**
 * The AR corner of a shipment: where this order sits on the billing ladder, and the one
 * action that moves it from here.
 *
 * Three rules shape it.
 *
 * 1. **The ladder is a ladder.** DOCS_NEEDED → UNBILLED → UNPAID → PAID is a sequence a
 *    person walks, and only two of its steps are ever taken by hand: Ready to invoice
 *    and Generate. The money rungs are written by `GENERATE_INVOICE` and `RECORD_PAYMENT`
 *    and are shown, never offered. LEGACY and INVOICE_NOT_NEEDED are not on that walk at
 *    all — an Aljex-era bill and a deliberate non-bill — so they render as a flat chip
 *    rather than as a ladder stuck at a rung nobody will advance.
 * 2. **Nothing here claims an e-mail went out.** The card reports what the invoice row
 *    records — `sentAt` from a real SES accept, `markedSentAt` from a human saying they
 *    sent it another way — and says "not e-mailed yet" otherwise. On dev SES is denied,
 *    so that is the normal answer and the dialog hands over the body and the PDF instead.
 * 3. **Void is the only edit.** An issued invoice is a snapshot; a mistake is voided with
 *    a reason and re-issued, which is why the AR dropdown in the Actions menu locks once
 *    `invoiceId` is set.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Ban, Banknote, FileText, Mail, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { TmsBadge, TmsButton, TmsCard } from '@/features/tms/kit'
import { ReleaseGateList } from './ReleaseGateCard'
import { releaseGateMessages } from './releaseGateView'
import { getInvoice, readyToInvoice, saveOrderForm, voidInvoice, getInvoicePdfUrl } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { AGING_BUCKET_LABEL, agingBucket, daysLate, type AgingBucket } from '@/lib/arAging'
import { formatDateTime } from '@/lib/date'
import { cn } from '@/lib/utils'
import { GenerateInvoiceDialog } from '@/features/ar/components/GenerateInvoiceDialog'
import { EmailInvoiceDialog } from '@/features/ar/components/EmailInvoiceDialog'
import { ReceivePaymentDialog } from '@/features/ar/components/ReceivePaymentDialog'
import { SendToFactorDialog } from '@/features/ar/components/SendToFactorDialog'
import { ReasonDialog } from '@/features/ar/components/ReasonDialog'
import type { ArStatus, InvoiceRecord, ShipmentBundle } from '@/types/tms'

/** The walk, in order. Everything else about `arStatus` is a state, not a step. */
const RUNGS = [
  { key: 'DOCS_NEEDED', label: 'Docs needed' },
  { key: 'UNBILLED', label: 'Unbilled' },
  { key: 'UNPAID', label: 'Unpaid' },
  { key: 'PAID', label: 'Paid' },
] as const satisfies readonly { key: ArStatus; label: string }[]

/** Not on the ladder: one predates the system, one says there will never be a bill. */
const FLAT_LABEL: Record<'LEGACY' | 'INVOICE_NOT_NEEDED', string> = {
  LEGACY: 'Legacy — billed before this system',
  INVOICE_NOT_NEEDED: 'No invoice needed',
}

/** Late money gets a loud chip; everything inside terms is quiet. */
const BUCKET_TONE: Record<AgingBucket, 'gray' | 'orange' | 'red'> = {
  CURRENT: 'gray',
  D1_30: 'orange',
  D31_60: 'orange',
  D61_90: 'red',
  D91_PLUS: 'red',
}

type ArDialog = { kind: 'generate' } | { kind: 'email' } | { kind: 'payment' } | { kind: 'factor' } | { kind: 'void' } | null

export interface ArCardProps {
  bundle: ShipmentBundle
  /** Re-read the shipment: every write here moves the order's AR fields. */
  onReload: () => Promise<void>
}

export function ArCard({ bundle, onReload }: ArCardProps) {
  const shipment = bundle.shipment
  const order = bundle.orders[0] ?? null
  const invoiceId = order?.invoiceId ?? null

  const [invoice, setInvoice] = useState<InvoiceRecord | null>(null)
  const [dialog, setDialog] = useState<ArDialog>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    Promise.resolve(invoiceId ? getInvoice(invoiceId) : null)
      .then((row) => { if (live) setInvoice(row) })
      .catch(() => { /* the card falls back to the order's cached numbers */ })
    return () => { live = false }
  }, [invoiceId])

  /** Every write moves the order, so the shipment and the invoice are both re-read. */
  const refresh = useCallback(async () => {
    await onReload()
    if (!invoiceId) return
    const row = await getInvoice(invoiceId).catch(() => null)
    setInvoice(row)
  }, [onReload, invoiceId])

  if (!order) return null

  const arStatus: ArStatus = order.arStatus ?? 'DOCS_NEEDED'
  const flat = arStatus === 'LEGACY' || arStatus === 'INVOICE_NOT_NEEDED' ? arStatus : null

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
      toast.success(label)
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Unbilled is the release gate, not a status somebody types. The Lambda re-runs the
   * whole rule — delivered, paperwork, references, carrier cost, open exceptions — and
   * refuses with `Not ready for accounting: …` listing what is still missing, which is
   * the message worth reading, so it is surfaced as written. There is no override.
   */
  const onReady = () => run('Ready to invoice', () => readyToInvoice({
    orderId: order.id,
    expectedUpdatedAt: order.updatedAt,
  }))

  const onInvoiceEarly = (next: boolean) => run(
    next ? 'This shipment can be billed before delivery' : 'This shipment bills after delivery',
    () => saveOrderForm({
      shipmentId: shipment.id,
      expectedUpdatedAt: shipment.updatedAt,
      order: { invoiceEarly: next },
    }),
  )

  const openPdf = async () => {
    const key = invoice?.pdfKey
    if (!key) return
    try {
      window.open(await getInvoicePdfUrl(key), '_blank', 'noopener')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the invoice PDF')
    }
  }

  const number = invoice?.number ?? order.invoiceNumber ?? null
  const balanceCents = invoice?.balanceCents ?? order.arBalanceCents ?? null
  const voided = invoice?.status === 'VOID'
  const bucket = invoice && !voided && invoice.balanceCents > 0
    ? agingBucket(invoice.dueAt, new Date().toISOString())
    : null
  const gateMessages = error ? releaseGateMessages(error) : null

  return (
    <TmsCard
      title="Accounts receivable"
      actions={flat ? (
        <TmsBadge tone="gray" data-testid="ar-flat">{FLAT_LABEL[flat]}</TmsBadge>
      ) : (
        <ol className="flex flex-wrap items-center gap-1" data-testid="ar-ladder">
          {RUNGS.map((rung) => {
            const lit = rung.key === arStatus
            return (
              <li
                key={rung.key}
                data-testid={`ar-rung-${rung.key}`}
                aria-current={lit ? 'step' : undefined}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px]',
                  lit
                    ? 'border-[color:var(--tms-primary)] font-medium text-[color:var(--tms-text)]'
                    : 'border-[color:var(--tms-border)] text-[color:var(--tms-muted)]',
                )}
              >
                {rung.label}
              </li>
            )
          })}
        </ol>
      )}
    >
      <div className="space-y-3" data-testid="ar-card">
      {!invoiceId && !flat && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              aria-label="Invoice early"
              checked={order.invoiceEarly === true}
              disabled={busy}
              onCheckedChange={(v) => { void onInvoiceEarly(v === true) }}
            />
            Invoice early
          </label>
          <span className="tms-muted text-xs">Bills on pickup instead of waiting for delivery.</span>
        </div>
      )}

      {number && (
        <dl className="tms-grid tms-grid-4 text-sm">
          <div>
            <dt className="tms-field-label">Invoice</dt>
            <dd>
              <Link to={`/tms/invoicing/invoices/${invoiceId}`} className="underline underline-offset-2">{number}</Link>
              {voided && <TmsBadge tone="red">void</TmsBadge>}
            </dd>
          </div>
          <div>
            <dt className="tms-field-label">Total</dt>
            <dd>{invoice ? formatCents(invoice.totalCents) : '—'}</dd>
          </div>
          <div>
            <dt className="tms-field-label">Balance</dt>
            <dd>{balanceCents != null ? formatCents(balanceCents) : '—'}</dd>
          </div>
          <div>
            <dt className="tms-field-label">Due</dt>
            <dd className="flex flex-wrap items-center gap-1">
              {invoice?.dueAt ?? '—'}
              {bucket && (
                <TmsBadge tone={BUCKET_TONE[bucket]}>
                  {bucket === 'CURRENT'
                    ? AGING_BUCKET_LABEL[bucket]
                    : `${AGING_BUCKET_LABEL[bucket]} days late`}
                </TmsBadge>
              )}
            </dd>
          </div>
        </dl>
      )}

      {invoice && <EmailStatus invoice={invoice} />}

      <div className="flex flex-wrap gap-2">
        {arStatus === 'DOCS_NEEDED' && (
          <TmsButton variant="primary" size="sm" disabled={busy} onClick={() => { void onReady() }}>
            Ready to invoice
          </TmsButton>
        )}
        {arStatus === 'UNBILLED' && !invoiceId && (
          <TmsButton variant="primary" size="sm" disabled={busy} onClick={() => setDialog({ kind: 'generate' })}>
            Generate invoice
          </TmsButton>
        )}
        {invoiceId && !voided && (
          <>
            <TmsButton size="sm" disabled={!invoice?.pdfKey} onClick={() => { void openPdf() }}>
              <FileText size={13} className="mr-1" />PDF
            </TmsButton>
            <TmsButton size="sm" onClick={() => setDialog({ kind: 'email' })}>
              <Mail size={13} className="mr-1" />E-mail
            </TmsButton>
            {(invoice?.balanceCents ?? 0) > 0 && (
              <TmsButton size="sm" onClick={() => setDialog({ kind: 'payment' })}>
                <Banknote size={13} className="mr-1" />Receive payment
              </TmsButton>
            )}
            {order.factoringItemId || invoice?.factoringItemId ? (
              <TmsBadge tone="purple" data-testid="ar-factor-status">
                On the factoring queue — submit to OTR there
              </TmsBadge>
            ) : (
              <TmsButton size="sm" onClick={() => setDialog({ kind: 'factor' })}>
                <Send size={13} className="mr-1" />Send to Factor
              </TmsButton>
            )}
            <TmsButton variant="destructive" size="sm" onClick={() => setDialog({ kind: 'void' })}>
              <Ban size={13} className="mr-1" />Void
            </TmsButton>
          </>
        )}
      </div>

      {/*
        * Ready to invoice is refused with the whole release-gate list. Printing it as a
        * checklist — the same one the Invoicing tab draws — is what makes it actionable;
        * any other failure is shown as written.
        */}
      {error && (gateMessages
        ? <ReleaseGateList messages={gateMessages} testId="ar-release-gate-missing" />
        : <p className="tms-field-error">{error}</p>
      )}

      {dialog?.kind === 'generate' && (
        <GenerateInvoiceDialog
          orderId={order.id}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); void refresh() }}
        />
      )}
      {dialog?.kind === 'email' && invoiceId && (
        <EmailInvoiceDialog
          invoiceId={invoiceId}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); void refresh() }}
        />
      )}
      {/*
        * The payment is applied to the invoice's customer, not to whatever the order
        * carries now: an order may have no Customer record linked at all, and only an
        * invoice — which cannot be generated without one — proves there is money owed.
        */}
      {dialog?.kind === 'payment' && invoice && (
        <ReceivePaymentDialog
          customerId={invoice.customerId}
          customerName={invoice.customerName ?? shipment.customerName ?? undefined}
          invoiceId={invoiceId ?? undefined}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); void refresh() }}
        />
      )}
      {dialog?.kind === 'factor' && invoiceId && (
        <SendToFactorDialog
          invoiceId={invoiceId}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); void refresh() }}
        />
      )}
      {dialog?.kind === 'void' && invoiceId && (
        <ReasonDialog
          title={`Void invoice ${number ?? invoiceId}`}
          description="The shipment goes back to Unbilled and its charges unfreeze. The number is never reused."
          label="Reason"
          confirmLabel="Void invoice"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => {
            void run('Invoice voided', () => voidInvoice({ invoiceId, reason })).then(() => setDialog(null))
          }}
        />
      )}
      </div>
    </TmsCard>
  )
}

/**
 * What the invoice row says about delivery, and nothing more. `sentAt` is set only when
 * SES accepted the message; on a stack where SES is denied the honest answer is that
 * nothing went out, and the e-mail dialog is where the body and the PDF are handed over.
 */
function EmailStatus({ invoice }: { invoice: InvoiceRecord }) {
  const late = invoice.status === 'ISSUED' || invoice.status === 'PARTIAL'
    ? daysLate(invoice.dueAt, new Date().toISOString())
    : 0
  return (
    <p className="text-xs tms-muted" data-testid="ar-email-status">
      {invoice.sentAt
        ? `E-mailed ${formatDateTime(invoice.sentAt)}${invoice.sentTo ? ` to ${invoice.sentTo}` : ''}${(invoice.sentCount ?? 0) > 1 ? ` · ${invoice.sentCount} times` : ''}`
        : invoice.markedSentAt
          ? `Marked as sent ${formatDateTime(invoice.markedSentAt)}${invoice.markedSentBy ? ` by ${invoice.markedSentBy}` : ''}`
          : 'Not e-mailed yet.'}
      {late > 0 ? ` · ${late} day${late === 1 ? '' : 's'} past due` : ''}
    </p>
  )
}
