/**
 * `/ap/bills/:id` — one carrier bill, everything that has happened to it, and the three
 * actions that can still happen.
 *
 * A bill is a snapshot: the lines, the quick-pay fee, the terms and the remit-to were
 * frozen when it was recorded, and nothing on this page edits them. A mistake is voided
 * and recorded again, which is why Void asks for a reason and Unapprove drops the bill
 * back to review rather than deleting an approval that already happened.
 *
 * Every figure comes from `billData`, which reads the snapshot first and the directory
 * only as a fallback, so a carrier renamed or a method retired six months from now
 * cannot change what a bill we already paid says it paid.
 *
 * The approval trail is shown in full — who approved, which warnings they acknowledged,
 * any paperwork override and its note — because that is the record somebody audits
 * later, and a warning waved through silently might as well never have been raised.
 */
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useCarrierBill } from '@/hooks/useCarrierBill'
import { graphqlErrorText, unapproveBill, voidBill } from '@/lib/apiClient'
import { APPROVAL_WARNING_KEYS, billData } from '@/lib/carrierBill'
import { chicagoDateStr, formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import { agingChipFor, formatDay } from '@/features/ar/arViews'
import { ReasonDialog } from '@/features/ar/components/ReasonDialog'
import { AP_PAYEE_KIND_LABEL, AP_PAYMENT_KIND_LABEL, BILL_STATUS_LABEL, paymentsForBill } from './apViews'
import { ApproveBillDialog } from './components/ApproveBillDialog'
import type { CarrierBillStatus } from '@/types/tms'

type DetailDialog = { kind: 'approve' } | { kind: 'unapprove' } | { kind: 'void' }

const STATUS_TONE: Record<CarrierBillStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  IN_REVIEW: 'secondary',
  TO_BE_PAID: 'default',
  PARTIAL: 'default',
  PAID: 'outline',
  VOID: 'destructive',
}

/** The ladder a bill climbs. VOID is not a rung — it is leaving the ladder. */
const RUNGS: CarrierBillStatus[] = ['IN_REVIEW', 'TO_BE_PAID', 'PARTIAL', 'PAID']

/** Why a warning was raised, for the trail that records it was acknowledged. */
const WARNING_LABEL: Record<string, string> = {
  [APPROVAL_WARNING_KEYS.rateConUnsigned]: 'The rate confirmation was not signed',
  [APPROVAL_WARNING_KEYS.carrierDoNotUse]: 'The carrier was marked DO NOT USE',
  [APPROVAL_WARNING_KEYS.recordedEarly]: 'The bill was recorded before the load delivered',
}

const CARD = 'rounded-md border border-border bg-card p-4'
const TH = 'px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-1.5 align-top'
const MONEY = 'px-2 py-1.5 text-right tabular-nums align-top'

export function BillDetail() {
  const { id } = useParams<{ id: string }>()
  const { bill, bundle, payments, loading, error, refresh } = useCarrierBill(id ?? null)

  const [dialog, setDialog] = useState<DetailDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [asOf] = useState(() => chicagoDateStr(new Date()))

  if (!id) return <p className="p-6 text-sm text-muted-foreground">No bill selected.</p>
  if (!bill) {
    return (
      <div className="p-6 text-sm">
        {loading ? <span className="text-muted-foreground">Loading bill…</span> : null}
        {!loading && <span className="text-destructive">{error ?? 'Bill not found.'}</span>}
      </div>
    )
  }

  const view = billData({
    bill,
    bundle: { shipment: bundle?.shipment, loads: bundle?.loads },
    asOf,
  })
  const chip = agingChipFor(view.dueAt, asOf)
  const document = (bundle?.documents ?? []).find((doc) => doc.id === view.documentId) ?? null
  const applied = paymentsForBill(payments, bill.id)
  const acknowledged = bill.approvalWarnings ?? []
  const label = view.billNumber ?? view.id
  // Everything that has already settled part of this bill, however it got there.
  const settledCents = view.totals.paidCents + view.totals.creditedCents

  const runUnapprove = (reason: string) => {
    setBusy(true)
    unapproveBill({ billId: bill.id, reason })
      .then(() => {
        toast.success('Back in review')
        setDialog(null)
        return refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not take the bill back'))
      .finally(() => setBusy(false))
  }

  const runVoid = (reason: string) => {
    setBusy(true)
    voidBill({ billId: bill.id, reason })
      .then(() => {
        toast.success(`Bill ${label} voided`)
        setDialog(null)
        return refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not void the bill'))
      .finally(() => setBusy(false))
  }

  const closeAndRefresh = () => {
    setDialog(null)
    void refresh()
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/ap" aria-label="Back to AP"><ChevronLeft size={14} className="mr-1" /> AP</Link>
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-auto px-6 py-4">
        <header className={CARD}>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">{label}</h1>
            <Badge variant={STATUS_TONE[view.status]}>{BILL_STATUS_LABEL[view.status]}</Badge>
            {view.aging.open && (
              <Badge variant={chip.late ? 'destructive' : 'outline'} className="text-[10px]">{chip.label}</Badge>
            )}
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                size="sm"
                aria-label="Approve bill"
                disabled={busy || view.status !== 'IN_REVIEW'}
                onClick={() => setDialog({ kind: 'approve' })}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-label="Unapprove bill"
                disabled={busy || view.status !== 'TO_BE_PAID'}
                onClick={() => setDialog({ kind: 'unapprove' })}
              >
                Unapprove
              </Button>
              <Button
                size="sm"
                variant="destructive"
                aria-label="Void bill"
                // The server refuses a void once any money has touched the bill —
                // cash or credit alike; that payment is reversed first.
                disabled={busy || view.status === 'VOID' || settledCents > 0}
                onClick={() => setDialog({ kind: 'void' })}
              >
                Void
              </Button>
            </div>
          </div>

          {view.status !== 'VOID' && (
            <ol className="mt-3 flex flex-wrap items-center gap-1 text-xs" aria-label="Bill status">
              {RUNGS.map((rung) => {
                const reached = RUNGS.indexOf(rung) <= RUNGS.indexOf(view.status)
                return (
                  <li
                    key={rung}
                    aria-current={rung === view.status ? 'step' : undefined}
                    className={`rounded-full border px-2 py-0.5 ${
                      rung === view.status
                        ? 'border-primary bg-primary/10 font-medium'
                        : reached ? 'border-border text-muted-foreground' : 'border-dashed border-border text-muted-foreground/60'
                    }`}
                  >
                    {BILL_STATUS_LABEL[rung]}
                  </li>
                )
              })}
            </ol>
          )}

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <Field label="Carrier" value={view.carrier.name || bill.carrierId} />
            <Field
              label="Shipment"
              value={
                <Link className="text-primary hover:underline" to={`/shipments/${view.shipmentId}`}>
                  {view.shipmentNumber ?? view.shipmentId}
                </Link>
              }
            />
            <Field label="Load" value={view.loadNumber ?? '—'} />
            <Field label="Terms" value={view.quickPay ? `Quick pay, net ${view.termsDays}` : `Net ${view.termsDays}`} />
            <Field label="Bill date" value={formatDay(view.billDate)} />
            <Field label="Due" value={formatDay(view.dueAt)} />
            <Field label="Recorded" value={`${formatDateTime(view.recordedAt)} by ${view.recordedBy}`} />
            <Field label="Balance" value={<span className="font-semibold">{formatCents(view.totals.balanceCents)}</span>} />
            {view.recordedEarly && <Field label="Recorded early" value="Before the load delivered" />}
            {view.status === 'VOID' && <Field label="Voided" value={view.voidReason ?? 'No reason recorded'} />}
          </dl>
        </header>

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
              {view.lines.length === 0 && (
                <tr><td colSpan={5} className="py-4 text-center text-sm text-muted-foreground">This bill has no lines.</td></tr>
              )}
              {view.lines.map((line) => (
                <tr key={line.chargeId} className="border-b border-border/60">
                  <td className={TD}>{line.code}</td>
                  <td className={TD}>{line.label ?? line.code}</td>
                  <td className={MONEY}>{formatCents(line.rateCents)}</td>
                  <td className={MONEY}>{line.count}</td>
                  <td className={MONEY}>{formatCents(line.amountCents)}</td>
                </tr>
              ))}
              <tr>
                <td className={TD} colSpan={4}>Gross</td>
                <td className={MONEY} aria-label="Gross">{formatCents(view.totals.grossCents)}</td>
              </tr>
              {view.totals.quickPayFeeCents > 0 && (
                <tr>
                  <td className={TD} colSpan={4}>Quick-pay fee</td>
                  <td className={MONEY} aria-label="Quick-pay fee">−{formatCents(view.totals.quickPayFeeCents)}</td>
                </tr>
              )}
              <tr>
                <td className={`${TD} font-semibold`} colSpan={4}>Net — what we pay</td>
                <td className={`${MONEY} font-semibold`} aria-label="Net">{formatCents(view.totals.netCents)}</td>
              </tr>
              <tr>
                <td className={TD} colSpan={4}>Their invoice says</td>
                <td className={MONEY} aria-label="Billed">{formatCents(view.totals.billedCents)}</td>
              </tr>
              {view.totals.varianceCents !== 0 && (
                <tr>
                  <td className={`${TD} text-destructive`} colSpan={4}>Variance</td>
                  <td className={`${MONEY} text-destructive`} aria-label="Variance">
                    {formatCents(view.totals.varianceCents)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {view.note && <p className="mt-2 text-xs text-muted-foreground">{view.note}</p>}
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className={CARD}>
            <h2 className="mb-2 text-sm font-semibold">Paid to</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field label="Payee" value={`${view.payee.name} (${AP_PAYEE_KIND_LABEL[view.payee.kind]})`} />
              {view.payee.factorName && <Field label="Factor" value={view.payee.factorName} />}
              <Field label="Method" value={view.payee.method ?? 'Not set'} />
              <Field label="Account" value={view.payee.accountLast4 ? `•••• ${view.payee.accountLast4}` : '—'} />
              <Field label="Remit e-mail" value={view.payee.payeeEmail ?? '—'} />
              {view.payee.address?.city && (
                <Field
                  label="Remit to"
                  value={[view.payee.address.street, view.payee.address.city, view.payee.address.state]
                    .filter(Boolean).join(', ')}
                />
              )}
            </dl>
            {!view.payee.method && (
              <p className="mt-2 text-xs text-amber-600">
                This bill has no payment method on it. Set one on the carrier before approving.
              </p>
            )}
          </section>

          <section className={CARD}>
            <h2 className="mb-2 text-sm font-semibold">Their invoice</h2>
            {!view.documentId && (
              <p className="text-sm text-muted-foreground">
                No carrier invoice is linked to this bill.
              </p>
            )}
            {view.documentId && !document && (
              <p className="text-sm text-muted-foreground">
                A document is linked ({view.documentId}) but is not on the shipment any more.
              </p>
            )}
            {document && (
              <p className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{document.type}</span>
                <span>{document.name}</span>
                <span className="text-xs text-muted-foreground">{Math.round(document.sizeBytes / 1024)} KB</span>
              </p>
            )}
          </section>
        </div>

        <section className={CARD}>
          <h2 className="mb-2 text-sm font-semibold">Approval</h2>
          {!view.approvedAt && view.status !== 'VOID' && (
            <p className="text-sm text-muted-foreground">
              Not approved yet. Approving moves it to To be paid and puts it in the pay run.
            </p>
          )}
          {view.approvedAt && (
            <p className="text-sm">
              Approved {formatDateTime(view.approvedAt)} by {view.approvedBy ?? 'unknown'}.
            </p>
          )}
          {acknowledged.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {acknowledged.map((key) => (
                <li key={key} className="flex items-start gap-2">
                  <ShieldAlert size={13} className="mt-0.5 shrink-0 text-amber-600" />
                  Acknowledged: {WARNING_LABEL[key] ?? key}
                </li>
              ))}
            </ul>
          )}
          {bill.docsOverrideAt && (
            <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
              Paperwork gate overridden {formatDateTime(bill.docsOverrideAt)} by {bill.docsOverrideBy ?? 'unknown'}
              {bill.docsOverrideNote ? ` — ${bill.docsOverrideNote}` : ' with no note'}.
            </p>
          )}
        </section>

        <section className={CARD}>
          <h2 className="mb-2 text-sm font-semibold">Payments applied</h2>
          {applied.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing has gone against this bill.</p>
          )}
          {applied.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH} scope="col">Kind</th>
                  <th className={TH} scope="col">Paid</th>
                  <th className={TH} scope="col">Reference</th>
                  <th className={`${TH} text-right`} scope="col">Applied here</th>
                </tr>
              </thead>
              <tbody>
                {applied.map((row) => (
                  <tr key={row.payment.id} className="border-b border-border/60">
                    <td className={TD}>{AP_PAYMENT_KIND_LABEL[row.payment.kind]}</td>
                    <td className={TD}>{formatDay(row.payment.paidAt.slice(0, 10))}</td>
                    <td className={TD}>{row.payment.reference || '—'}</td>
                    <td className={MONEY}>{formatCents(row.amountCents)}</td>
                  </tr>
                ))}
                <tr>
                  <td className={TD} colSpan={3}>Credited</td>
                  <td className={MONEY}>{formatCents(view.totals.creditedCents)}</td>
                </tr>
                <tr>
                  <td className={`${TD} font-semibold`} colSpan={3}>Still owed</td>
                  <td className={`${MONEY} font-semibold`}>{formatCents(view.totals.balanceCents)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </section>
      </div>

      {dialog?.kind === 'approve' && (
        <ApproveBillDialog
          bill={bill}
          open
          onOpenChange={(next) => { if (!next) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'unapprove' && (
        <ReasonDialog
          title={`Take bill ${label} back to review`}
          description="The bill leaves the pay run and goes back to In review. The approval stays on the record."
          label="Why it is going back"
          confirmLabel="Take back"
          tone="default"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={runUnapprove}
        />
      )}
      {dialog?.kind === 'void' && (
        <ReasonDialog
          title={`Void bill ${label}`}
          description="Voiding releases the assignment for a fresh bill and leaves this one on the record. It cannot be undone."
          label="Why it is being voided"
          confirmLabel="Void bill"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={runVoid}
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
