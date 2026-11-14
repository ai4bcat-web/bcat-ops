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
  const facts2: [string, ReactNode][] = [
    ['PRO', <Link key="pro" to={shipmentEditorPath(bill.shipmentId)}>{pro}</Link>],
    ['PO #', fact?.po ?? '—'],
    ['Delivered', fact?.deliveredAt ? formatDay(fact.deliveredAt) : '—'],
    ['Carrier', bill.carrierName ?? '—'],
    ['Pay to', payToLabel(bill)],
    ['Remit e-mail', remitEmailOf(bill, infos) || '—'],
    ['Carrier invoice #', bill.billNumber ?? '—'],
    ['Invoice date', pending ? <TmsBadge key="inv" tone="orange">Needs invoice date</TmsBadge> : formatDay(bill.billDate)],
    ['Due', pending ? `${formatDay(estimatedDueAt(bill, facts))} (estimated)` : formatDay(bill.dueAt)],
    ['Terms', termsLabel(bill)],
  ]

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
      <section className="tms-card" aria-label="Load and payee">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {facts2.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="tms-muted">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          <dt className="tms-muted">Payment info</dt>
          <dd>
            <button type="button" className="tms-link" onClick={() => onPaymentInfo(bill)}>
              {info?.bankName || (info?.recipientType === 'FACTOR' ? 'Factor details' : 'View')}
              {info?.accountLast4 ? ` ••${info.accountLast4}` : ''}
            </button>
          </dd>
        </dl>
        {pending && (
          <div className="mt-3">
            <TmsButton variant="primary" size="sm" disabled={busy} onClick={() => onSetDates(bill)}>Add invoice date</TmsButton>
            <span className="ml-2 text-xs tms-muted">Once the carrier's invoice date is in, the bill moves to Aging.</span>
          </div>
        )}
      </section>

      <section className="tms-card mt-3" aria-label="Carrier pay">
        <h3 className="tms-card-title">Carrier pay</h3>
        <dl className="grid grid-cols-[1fr_max-content] gap-y-1 text-sm tabular-nums">
          <dt>Carrier pay</dt><dd className="text-right">{formatCents(bill.grossCents)}</dd>
          <dt>Quick pay fee</dt><dd className="text-right">{bill.quickPayFeeCents ? `− ${formatCents(bill.quickPayFeeCents)}` : '—'}</dd>
          <dt className="font-medium">We pay</dt><dd className="text-right font-medium">{formatCents(bill.netCents)}</dd>
          {bill.balanceCents !== bill.netCents && (<><dt className="tms-muted">Still owed</dt><dd className="text-right tms-muted">{formatCents(bill.balanceCents)}</dd></>)}
        </dl>
        {bill.varianceCents !== 0 && (
          <p className="mt-1 text-xs" style={{ color: 'var(--tms-badge-red)' }}>
            The carrier's invoice says {formatCents(bill.billedCents)}, {formatCents(Math.abs(bill.varianceCents))} {bill.varianceCents > 0 ? 'more' : 'less'} than the carrier pay.
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <TmsButton size="sm" disabled={busy || payLock != null} onClick={() => onAdjustPay(bill)}>Adjust carrier pay</TmsButton>
          <span className="text-xs tms-muted">{payLock ?? 'Also changes the shipment\'s carrier charges.'}</span>
        </div>
      </section>

      <section className="tms-card mt-3" aria-label="Quick pay">
        <h3 className="tms-card-title">Quick pay</h3>
        <div role="radiogroup" aria-label="Payment terms" className="flex flex-wrap gap-2">
          {[{ days: null as number | null, label: 'Standard terms', sub: 'No fee' }, ...AP_QUICK_PAY_OPTIONS.map((o) => ({
            days: o.days as number | null,
            label: `${o.days} days`,
            sub: `${o.feeBps / 100}% fee · ${formatCents(Math.round((bill.grossCents * o.feeBps) / 10000))}`,
          }))].map((opt) => (
            <button
              key={String(opt.days)}
              type="button"
              role="radio"
              aria-checked={current === opt.days}
              disabled={busy || quickLock != null}
              onClick={() => chooseQuickPay(opt.days)}
              className={`tms-btn tms-btn-sm ${current === opt.days ? 'tms-btn-primary' : 'tms-btn-secondary'}`}
            >
              {opt.label} <span className="ml-1 text-xs opacity-80">{opt.sub}</span>
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs tms-muted">
          {quickLock ?? 'The fee comes off what we pay the carrier, and the due date becomes the invoice date plus the quick-pay days.'}
        </p>
      </section>
    </TmsDrawer>
  )
}
