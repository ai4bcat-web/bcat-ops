/**
 * `/tms/invoicing/payable/bills/:id` — one carrier bill, everything that has happened to
 * it, and the three actions that can still happen.
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
import { TmsBadge, TmsButton, TmsCard, TmsPage, TmsTabs } from '@/features/tms/kit'
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
import type { TmsTone } from '@/features/tms/kit'

type DetailDialog = { kind: 'approve' } | { kind: 'unapprove' } | { kind: 'void' }

const STATUS_TONE: Record<CarrierBillStatus, TmsTone> = {
  IN_REVIEW: 'purple',
  TO_BE_PAID: 'blue',
  PARTIAL: 'orange',
  PAID: 'green',
  VOID: 'red',
}

/** The ladder a bill climbs. VOID is not a rung — it is leaving the ladder. */
const RUNGS: CarrierBillStatus[] = ['IN_REVIEW', 'TO_BE_PAID', 'PARTIAL', 'PAID']

/**
 * Why a warning was raised, for the trail that records it was acknowledged. The keys are
 * the three `approvalReadiness` raises; anything else falls back to the raw key.
 */
const WARNING_LABEL: Record<string, string> = {
  [APPROVAL_WARNING_KEYS.rateConUnsigned]: 'no signed rate confirmation',
  [APPROVAL_WARNING_KEYS.carrierDoNotUse]: 'the carrier is marked do not use',
  [APPROVAL_WARNING_KEYS.recordedEarly]: 'the load had not delivered',
}

const TABS = [
  { key: 'summary', label: 'Summary' },
  { key: 'payee', label: 'Paid to' },
  { key: 'approval', label: 'Approval' },
  { key: 'payments', label: 'Payments' },
]

const RED = { color: 'var(--tms-badge-red)' }

export function BillDetail() {
  const { id } = useParams<{ id: string }>()
  const { bill, bundle, payments, loading, error, refresh } = useCarrierBill(id ?? null)

  const [tab, setTab] = useState('summary')
  const [dialog, setDialog] = useState<DetailDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [asOf] = useState(() => chicagoDateStr(new Date()))

  if (!id) return <p className="tms-muted">No bill selected.</p>
  if (!bill) {
    return (
      <p>
        {loading ? <span className="tms-muted">Loading bill…</span> : null}
        {!loading && <span style={RED}>{error ?? 'Bill not found.'}</span>}
      </p>
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
    <TmsPage
      title={
        <span className="flex items-center gap-2">
          <Link
            className="tms-icon-btn tms-icon-btn-plain"
            to="/tms/invoicing/payable"
            aria-label="Back to Payable"
          >
            <ChevronLeft size={16} />
          </Link>
          {label}
          <TmsBadge tone={STATUS_TONE[view.status]}>{BILL_STATUS_LABEL[view.status]}</TmsBadge>
          {view.aging.open && <TmsBadge tone={chip.late ? 'red' : 'gray'}>{chip.label}</TmsBadge>}
        </span>
      }
      actions={
        <>
          <TmsButton
            variant="primary"
            aria-label="Approve bill"
            disabled={busy || view.status !== 'IN_REVIEW'}
            onClick={() => setDialog({ kind: 'approve' })}
          >
            Approve
          </TmsButton>
          <TmsButton
            aria-label="Unapprove bill"
            disabled={busy || view.status !== 'TO_BE_PAID'}
            onClick={() => setDialog({ kind: 'unapprove' })}
          >
            Unapprove
          </TmsButton>
          <TmsButton
            variant="destructive"
            aria-label="Void bill"
            // The server refuses a void once any money has touched the bill —
            // cash or credit alike; that payment is reversed first.
            disabled={busy || view.status === 'VOID' || settledCents > 0}
            onClick={() => setDialog({ kind: 'void' })}
          >
            Void
          </TmsButton>
        </>
      }
    >
      <TmsCard>
        {view.status !== 'VOID' && (
          <ol className="mb-3 flex flex-wrap items-center gap-1 text-xs" aria-label="Bill status">
            {RUNGS.map((rung) => {
              const reached = RUNGS.indexOf(rung) <= RUNGS.indexOf(view.status)
              const current = rung === view.status
              return (
                <li
                  key={rung}
                  aria-current={current ? 'step' : undefined}
                  className="rounded-full px-2 py-0.5"
                  style={{
                    border: `1px ${reached ? 'solid' : 'dashed'} ${current ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
                    color: current ? 'var(--tms-text)' : 'var(--tms-muted)',
                    fontWeight: current ? 600 : 400,
                  }}
                >
                  {BILL_STATUS_LABEL[rung]}
                </li>
              )
            })}
          </ol>
        )}

        <dl className="tms-grid tms-grid-4">
          <Field label="Carrier" value={view.carrier.name || bill.carrierId} />
          <Field
            label="Shipment"
            value={<Link to={`/tms/shipments/${view.shipmentId}`}>{view.shipmentNumber ?? view.shipmentId}</Link>}
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
      </TmsCard>

      <TmsTabs tabs={TABS} active={tab} onSelect={setTab} />

      {tab === 'summary' && (
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
                {view.lines.length === 0 && (
                  <tr><td colSpan={5} className="tms-muted">This bill has no lines.</td></tr>
                )}
                {view.lines.map((line) => (
                  <tr key={line.chargeId}>
                    <td>{line.code}</td>
                    <td>{line.label ?? line.code}</td>
                    <td className="text-right tabular-nums">{formatCents(line.rateCents)}</td>
                    <td className="text-right tabular-nums">{line.count}</td>
                    <td className="text-right tabular-nums">{formatCents(line.amountCents)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={4}>Gross</td>
                  <td className="text-right tabular-nums" aria-label="Gross">{formatCents(view.totals.grossCents)}</td>
                </tr>
                {view.totals.quickPayFeeCents > 0 && (
                  <tr>
                    <td colSpan={4}>Quick-pay fee</td>
                    <td className="text-right tabular-nums" aria-label="Quick-pay fee">−{formatCents(view.totals.quickPayFeeCents)}</td>
                  </tr>
                )}
                <tr>
                  <td colSpan={4} className="font-semibold">Net — what we pay</td>
                  <td className="text-right font-semibold tabular-nums" aria-label="Net">{formatCents(view.totals.netCents)}</td>
                </tr>
                <tr>
                  <td colSpan={4}>Their invoice says</td>
                  <td className="text-right tabular-nums" aria-label="Billed">{formatCents(view.totals.billedCents)}</td>
                </tr>
                {view.totals.varianceCents !== 0 && (
                  <tr>
                    <td colSpan={4} style={RED}>Variance</td>
                    <td className="text-right tabular-nums" style={RED} aria-label="Variance">
                      {formatCents(view.totals.varianceCents)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {view.note && <p className="p-3 text-xs tms-muted">{view.note}</p>}
        </TmsCard>
      )}

      {tab === 'payee' && (
        <div className="tms-grid tms-grid-2">
          <TmsCard title="Paid to">
            <dl className="tms-grid tms-grid-2">
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
              <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-orange)' }}>
                This bill has no payment method on it. Set one on the carrier before approving.
              </p>
            )}
          </TmsCard>

          <TmsCard title="Their invoice">
            {!view.documentId && <p className="tms-muted">No carrier invoice is linked to this bill.</p>}
            {view.documentId && !document && (
              <p className="tms-muted">
                A document is linked ({view.documentId}) but is not on the shipment any more.
              </p>
            )}
            {document && (
              <p className="flex items-center gap-2">
                <span className="tms-muted">{document.type}</span>
                <span>{document.name}</span>
                <span className="text-xs tms-muted">{Math.round(document.sizeBytes / 1024)} KB</span>
              </p>
            )}
          </TmsCard>
        </div>
      )}

      {tab === 'approval' && (
        <TmsCard title="Approval">
          {!view.approvedAt && view.status !== 'VOID' && (
            <p className="tms-muted">
              Not approved yet. Approving moves it to To be paid and puts it in the pay run.
            </p>
          )}
          {view.approvedAt && (
            <p>Approved {formatDateTime(view.approvedAt)} by {view.approvedBy ?? 'unknown'}.</p>
          )}
          {acknowledged.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-xs tms-muted">
              {acknowledged.map((key) => (
                <li key={key} className="flex items-start gap-2">
                  <ShieldAlert size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-orange)' }} />
                  Acknowledged: {WARNING_LABEL[key] ?? key}
                </li>
              ))}
            </ul>
          )}
          {bill.docsOverrideAt && (
            <p
              className="mt-2 p-2 text-xs"
              style={{ border: '1px solid var(--tms-badge-orange)', borderRadius: 'var(--tms-radius)' }}
            >
              Paperwork gate overridden {formatDateTime(bill.docsOverrideAt)} by {bill.docsOverrideBy ?? 'unknown'}
              {bill.docsOverrideNote ? ` — ${bill.docsOverrideNote}` : ' with no note'}.
            </p>
          )}
        </TmsCard>
      )}

      {tab === 'payments' && (
        <TmsCard title="Payments applied" flush={applied.length > 0}>
          {applied.length === 0 && <p className="tms-muted">Nothing has gone against this bill.</p>}
          {applied.length > 0 && (
            <div className="tms-table-wrap">
              <table className="tms-table">
                <thead>
                  <tr>
                    <th scope="col">KIND</th>
                    <th scope="col">PAID</th>
                    <th scope="col">REFERENCE</th>
                    <th scope="col">APPLIED HERE</th>
                  </tr>
                </thead>
                <tbody>
                  {applied.map((row) => (
                    <tr key={row.payment.id}>
                      <td>{AP_PAYMENT_KIND_LABEL[row.payment.kind]}</td>
                      <td>{formatDay(row.payment.paidAt.slice(0, 10))}</td>
                      <td>{row.payment.reference || '—'}</td>
                      <td className="text-right tabular-nums">{formatCents(row.amountCents)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3}>Credited</td>
                    <td className="text-right tabular-nums">{formatCents(view.totals.creditedCents)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="font-semibold">Still owed</td>
                    <td className="text-right font-semibold tabular-nums">{formatCents(view.totals.balanceCents)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </TmsCard>
      )}

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
