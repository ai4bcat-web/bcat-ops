/**
 * One payable, opened from a Payables row: the load it pays for, what we owe and to whom, and the
 * three things the desk changes here — the carrier pay (which also changes the shipment's carrier
 * charges), quick pay, and the carrier's invoice date.
 *
 * Every write goes through the existing actions: UPDATE_CARRIER_CHARGES (re-snapshots a bill still in
 * review), SET_BILL_QUICK_PAY and SET_BILL_DATES. What the server refuses, the drawer says before the
 * click: a bill on a pay run, with money applied, or (for the carrier pay) already approved.
 */
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDrawer } from '@/features/tms/kit'
import { graphqlErrorText, setBillQuickPay, type CarrierPaymentInfo } from '@/lib/apiClient'
import { billMoneyLockReason } from '@/lib/carrierBill'
import { AP_QUICK_PAY_OPTIONS } from '@/lib/quickPay'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDay } from '@/features/ar/arViews'
import type { CarrierBillRecord } from '@/types/tms'
import { BILL_STATUS_LABEL, payToLabel, paymentInfoFor, remitEmailOf } from '../apViews'
import { estimatedDueAt, proOf, termsLabel, type BillFactsIndex } from '../apQueue'
import { shipmentEditorPath } from '@/lib/shipmentLinks'

export function BillDrawer({ bill, facts, infos, onClose, onChanged, onAdjustPay, onSetDates, onPaymentInfo }: {
  bill: CarrierBillRecord
  facts: BillFactsIndex
  infos: readonly CarrierPaymentInfo[]
  onClose: () => void
  /** A write landed; the page re-reads the bills. */
  onChanged: () => void
  onAdjustPay: (bill: CarrierBillRecord) => void
  onSetDates: (bill: CarrierBillRecord) => void
  onPaymentInfo: (bill: CarrierBillRecord) => void
}) {
  const [busy, setBusy] = useState(false)
  const fact = facts.get(bill.shipmentId)
  const pending = bill.datesPending === true
  const payLock = billMoneyLockReason(bill, { allowApproved: false })
  const quickLock = billMoneyLockReason(bill, { allowApproved: true })
    ?? (bill.payeeKind === 'FACTOR' ? 'Paid through a factor; quick pay does not apply' : null)
  const current = bill.quickPay === true ? bill.quickPayDays ?? null : null
  const info = paymentInfoFor(bill, infos)

  const chooseQuickPay = (days: number | null) => {
    if (days === current) return
    setBusy(true)
    setBillQuickPay({ billId: bill.id, quickPayDays: days as 2 | 10 | null })
      .then(() => {
        toast.success(days ? `Quick pay: ${days} days` : 'Back on standard terms')
        onChanged()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not change quick pay'))
      .finally(() => setBusy(false))
  }

  const pro = proOf(bill, facts)
  const remit = remitEmailOf(bill, infos)
  const row = (label: string, value: ReactNode) => (
    <div key={label} className="grid grid-cols-[8.5rem_1fr] items-baseline gap-x-4 py-1.5 text-sm">
      <dt className="tms-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{value}</dd>
    </div>
  )
  const section = 'rounded-lg border border-[var(--tms-border)] px-4 py-3'
  const heading = 'mb-1 text-xs font-semibold uppercase tracking-wide tms-muted'
  const quickOptions = [{ days: null as number | null, label: 'Standard terms', sub: 'No fee' }, ...AP_QUICK_PAY_OPTIONS.map((o) => ({
    days: o.days as number | null,
    label: `${o.days} days`,
    sub: `${o.feeBps / 100}% fee · ${formatCents(Math.round((bill.grossCents * o.feeBps) / 10000))}`,
  }))]

  return (
    <TmsDrawer
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`${bill.carrierName ?? 'Carrier'} — PRO ${pro}`}
      description={`Bill ${bill.billNumber ?? bill.id}`}
      headerExtra={<TmsBadge tone={bill.status === 'IN_REVIEW' ? 'orange' : bill.status === 'PAID' ? 'green' : 'blue'}>{bill.selectedForPayment ? 'Selected' : BILL_STATUS_LABEL[bill.status]}</TmsBadge>}
      footer={(
        <>
          <Link className="tms-btn tms-btn-ghost tms-btn-sm" to={`/tms/invoicing/payable/bills/${bill.id}`}>Open full bill</Link>
          <TmsButton variant="ghost" onClick={onClose}>Close</TmsButton>
        </>
      )}
    >
      <div className="flex flex-col gap-4 pb-2">
        <section className={section} aria-label="Summary">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-xs tms-muted">We pay</div>
              <div className="text-2xl font-semibold tabular-nums">{formatCents(bill.netCents)}</div>
            </div>
            <div className="text-right text-sm">
              <div className="text-xs tms-muted">{pending ? 'Estimated due' : 'Due'}</div>
              <div className="tabular-nums">{pending ? formatDay(estimatedDueAt(bill, facts)) : formatDay(bill.dueAt)}</div>
            </div>
          </div>
          {pending && (
            <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--tms-border)] pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <TmsBadge tone="orange">Needs invoice date</TmsBadge>
                <TmsButton variant="primary" size="sm" disabled={busy} onClick={() => onSetDates(bill)}>Add invoice date</TmsButton>
              </div>
              <p className="m-0 text-xs tms-muted">Once the carrier's invoice date is in, the bill moves to Aging.</p>
            </div>
          )}
        </section>

        <section className={section} aria-label="Load and payee">
          <h3 className={heading}>Bill details</h3>
          <dl className="m-0">
            {row('PRO', <Link to={shipmentEditorPath(bill.shipmentId)}>{pro}</Link>)}
            {fact?.po ? row('PO #', fact.po) : null}
            {fact?.deliveredAt ? row('Delivered', formatDay(fact.deliveredAt)) : null}
            {row('Carrier invoice #', bill.billNumber ?? '—')}
            {!pending ? row('Invoice date', formatDay(bill.billDate)) : null}
            {row('Terms', termsLabel(bill))}
          </dl>
        </section>

        <section className={section} aria-label="Payment">
          <h3 className={heading}>Payment</h3>
          <dl className="m-0">
            {row('Carrier', bill.carrierName ?? '—')}
            {row('Pay to', payToLabel(bill))}
            {remit ? row('Remit e-mail', remit) : null}
            {row('Payment info', (
              <button type="button" className="tms-link" onClick={() => onPaymentInfo(bill)}>
                {info?.bankName || (info?.recipientType === 'FACTOR' ? 'Factor details' : 'View')}
                {info?.accountLast4 ? ` ••${info.accountLast4}` : ''}
              </button>
            ))}
          </dl>
        </section>

        <section className={section} aria-label="Carrier pay">
          <h3 className={heading}>Carrier pay</h3>
          <dl className="m-0 grid grid-cols-[1fr_max-content] gap-y-1.5 text-sm tabular-nums">
            <dt className="tms-muted">Carrier pay</dt><dd className="m-0 text-right">{formatCents(bill.grossCents)}</dd>
            <dt className="tms-muted">Quick pay fee</dt><dd className="m-0 text-right">{bill.quickPayFeeCents ? `− ${formatCents(bill.quickPayFeeCents)}` : '—'}</dd>
            <dt className="border-t border-[var(--tms-border)] pt-1.5 font-medium">We pay</dt>
            <dd className="m-0 border-t border-[var(--tms-border)] pt-1.5 text-right font-medium">{formatCents(bill.netCents)}</dd>
            {bill.balanceCents !== bill.netCents && (<><dt className="tms-muted">Still owed</dt><dd className="m-0 text-right tms-muted">{formatCents(bill.balanceCents)}</dd></>)}
          </dl>
          {bill.varianceCents !== 0 && (
            <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>
              The carrier's invoice says {formatCents(bill.billedCents)}, {formatCents(Math.abs(bill.varianceCents))} {bill.varianceCents > 0 ? 'more' : 'less'} than the carrier pay.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <TmsButton size="sm" disabled={busy || payLock != null} onClick={() => onAdjustPay(bill)}>Adjust carrier pay</TmsButton>
            <span className="text-xs tms-muted">{payLock ?? 'Also changes the shipment\'s carrier charges.'}</span>
          </div>
        </section>

        <section className={section} aria-label="Quick pay">
          <h3 className={heading}>Quick pay</h3>
          <div role="radiogroup" aria-label="Payment terms" className="grid grid-cols-3 gap-2 max-[420px]:grid-cols-1">
            {quickOptions.map((opt) => (
              <button
                key={String(opt.days)}
                type="button"
                role="radio"
                aria-checked={current === opt.days}
                disabled={busy || quickLock != null}
                onClick={() => chooseQuickPay(opt.days)}
                className={`tms-btn tms-btn-sm flex h-auto flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left ${current === opt.days ? 'tms-btn-primary' : 'tms-btn-secondary'}`}
              >
                <span className="font-medium">{opt.label}</span>
                <span className="text-xs opacity-80">{opt.sub}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs tms-muted">
            {quickLock ?? 'The fee comes off the carrier pay; the due date is the invoice date plus the quick-pay days.'}
          </p>
        </section>
      </div>
    </TmsDrawer>
  )
}
