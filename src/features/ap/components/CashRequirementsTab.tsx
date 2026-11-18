/**
 * The Cash requirements tab: money due to pay on each of the next five Fridays. Header numbers, a bar per Friday,
 * and one table whose lines expand to the bills behind them. The rule is in `cashFridays.ts` and written out under
 * the table, so nobody has to guess how a bill landed on a Friday.
 */
import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { TmsBadge } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import { formatDay } from '@/features/ar/arViews'
import type { CarrierBillRecord } from '@/types/tms'
import { cashRequirements, dayInZone, type CashLine } from '../cashFridays'
import { BILL_STATUS_LABEL } from '../apViews'
import { proOf, type BillFactsIndex } from '../apQueue'
import { paymentInfoFor, payeeLabel, remitEmailOf } from '../apViews'
import { RemitToCell } from './RemitToCell'
import type { CarrierPaymentInfo } from '@/lib/apiClient'
import '@/features/ar/components/agingReport.css'

const money = (cents: number) => (cents ? formatCents(cents) : '—')

/** How the bill will be paid: through the factor, or by the method the carrier has on file (ACH, check…). */
function payMethod(bill: CarrierBillRecord, infos: readonly CarrierPaymentInfo[]): string {
  if (bill.payeeKind === 'FACTOR') return 'Factor'
  const method = paymentInfoFor(bill, infos)?.method
  return method ? String(method) : '—'
}

export function CashRequirementsTab({ bills, facts, infos, asOf, busy, onMoveToSelected, onAddRemit }: {
  bills: readonly CarrierBillRecord[]
  facts: BillFactsIndex
  infos: readonly CarrierPaymentInfo[]
  /** Today as YYYY-MM-DD in the company zone (the page's own clock), or any moment, which is read in that zone. */
  asOf: string
  busy: boolean
  onMoveToSelected: (bill: CarrierBillRecord) => void
  onAddRemit: (bill: CarrierBillRecord) => void
}) {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : dayInZone(asOf)
  const cash = useMemo(() => cashRequirements(bills, today), [bills, today])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (key: string) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const peak = Math.max(1, cash.pastDue.totalCents, ...cash.weeks.map((w) => w.totalCents))
  const lines: CashLine<CarrierBillRecord>[] = [cash.pastDue, ...cash.weeks, cash.later, cash.notScheduled]

  return (
    <div className="tms-aging" data-testid="cash-requirements">
      <dl aria-label="Cash requirements summary" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 32px', margin: '0 0 12px' }}>
        <div><dt className="tms-muted text-xs">Next 5 Fridays (with past due)</dt><dd className="text-lg"><strong>{formatCents(cash.scheduledCents)}</strong></dd></div>
        <div><dt className="tms-muted text-xs">Largest week</dt><dd className="text-lg">{cash.largestWeek ? `${formatDay(cash.largestWeek.friday)} · ${formatCents(cash.largestWeek.totalCents)}` : '—'}</dd></div>
        <div><dt className="tms-muted text-xs">Past due</dt><dd className="text-lg">{formatCents(cash.pastDue.totalCents)}</dd></div>
        <div><dt className="tms-muted text-xs">Open AP in total</dt><dd className="text-lg">{formatCents(cash.openCents)}</dd></div>
      </dl>
      <p className="text-sm" style={{ margin: '0 0 12px' }}>
        <Link to="/finance/cash-planner">Plan this week's payments against your bank balances</Link>
      </p>

      <ul aria-label="Due by Friday" style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'grid', gap: 6 }}>
        {[cash.pastDue, ...cash.weeks].map((l) => (
          <li key={l.key} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 110px', alignItems: 'center', gap: 8 }}>
            <span className="text-sm">{l.key === 'past-due' ? 'Past due' : formatDay(l.friday)}</span>
            <span style={{ background: 'var(--tms-border)', borderRadius: 4, height: 14, overflow: 'hidden', display: 'flex' }} aria-hidden="true">
              <span style={{ width: `${(l.approvedCents / peak) * 100}%`, background: 'var(--tms-badge-green)' }} />
              <span style={{ width: `${(l.unapprovedCents / peak) * 100}%`, background: 'var(--tms-badge-orange)' }} />
            </span>
            <span className="tms-dg-right text-sm tabular-nums">{formatCents(l.totalCents)}</span>
          </li>
        ))}
        <li className="tms-muted text-xs">Green is approved (To be paid), orange is still in review.</li>
      </ul>

      <div className="tms-aging-table-wrap" style={{ display: 'block' }}>
        <table className="tms-aging-table" aria-label="Cash requirements by Friday">
          <thead>
            <tr>
              <th scope="col" className="tms-aging-twisty-col"><span className="sr-only">Expand</span></th>
              <th scope="col">Pay on</th>
              <th scope="col" className="tms-dg-right">Bills</th>
              <th scope="col" className="tms-dg-right">Approved (to be paid)</th>
              <th scope="col" className="tms-dg-right">In review</th>
              <th scope="col" className="tms-dg-right">Total to pay</th>
              <th scope="col" className="tms-dg-right">Running total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const isOpen = open.has(l.key)
              const scheduled = l.key !== 'later' && l.key !== 'not-scheduled'
              return (
                <Fragment key={l.key}>
                  <tr className={`tms-aging-cust${isOpen ? ' tms-open' : ''}`} data-testid={`cash-line-${l.key}`}>
                    <td className="tms-aging-twisty-col">
                      {l.count > 0 && (
                        <button type="button" className="tms-aging-twisty" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${l.label}`} onClick={() => toggle(l.key)}>
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      )}
                    </td>
                    <td>{l.friday && l.key !== 'past-due' ? `Friday ${formatDay(l.friday)}` : l.label}</td>
                    <td className="tms-dg-right">{l.count}</td>
                    <td className="tms-dg-right">{money(l.approvedCents)}</td>
                    <td className="tms-dg-right">{money(l.unapprovedCents)}</td>
                    <td className="tms-dg-right"><strong>{formatCents(l.totalCents)}</strong></td>
                    <td className="tms-dg-right">{scheduled ? formatCents(l.runningCents) : '—'}</td>
                  </tr>
                  {isOpen && (
                    <tr className="tms-aging-detail-row">
                      <td colSpan={7}>
                        <table className="tms-aging-inv" aria-label={`Bills for ${l.label}`}>
                          <thead>
                            <tr>
                              <th scope="col">PRO</th><th scope="col">Carrier</th><th scope="col">Pay to</th><th scope="col">Remit to</th><th scope="col">Due</th>
                              <th scope="col" className="tms-dg-right">Amount to pay</th><th scope="col">Status</th><th scope="col">Method</th><th scope="col"><span className="sr-only">Action</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {l.bills.map((b) => (
                              <tr key={b.id} data-testid="cash-bill-row">
                                <td><Link className="tms-link" to={shipmentEditorPath(b.shipmentId)}>{proOf(b, facts)}</Link></td>
                                <td>{b.carrierName ?? '—'}</td>
                                <td>{payeeLabel(b)}</td>
                                <td><RemitToCell email={remitEmailOf(b, infos)} label={payeeLabel(b)} onAdd={() => onAddRemit(b)} /></td>
                                <td>{b.datesPending === true ? '—' : formatDay(b.dueAt)}</td>
                                <td className="tms-dg-right"><strong>{formatCents(b.balanceCents)}</strong>{b.quickPay === true ? <> <TmsBadge tone="blue">Quick pay</TmsBadge></> : null}</td>
                                <td>{BILL_STATUS_LABEL[b.status]}</td>
                                <td>{payMethod(b, infos)}</td>
                                <td>
                                  {l.key !== 'not-scheduled' && b.selectedForPayment !== true && (
                                    <button type="button" className="tms-link whitespace-nowrap" disabled={busy} onClick={() => onMoveToSelected(b)}>Move to Selected</button>
                                  )}
                                  {b.selectedForPayment === true && <TmsBadge tone="blue">Selected</TmsBadge>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="tms-aging-total">
              <td colSpan={2}>Total open AP</td>
              <td className="tms-dg-right">{lines.reduce((n, l) => n + l.count, 0)}</td>
              <td className="tms-dg-right">{money(lines.reduce((n, l) => n + l.approvedCents, 0))}</td>
              <td className="tms-dg-right">{money(lines.reduce((n, l) => n + l.unapprovedCents, 0))}</td>
              <td className="tms-dg-right"><strong>{formatCents(cash.openCents)}</strong></td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="tms-muted text-xs" style={{ marginTop: 8 }}>
        How this is counted: a bill is paid on the Friday on or after its due date, and the next five Fridays start with today when today is a Friday
        (Chicago time). A bill whose due date has already passed is on the Past due line and is paid on the first Friday. A bill due after the fifth Friday is under Later. A bill with no
        invoice date yet (Expected) has no due date and is under Not scheduled. Quick pay bills use their quick-pay due date and discounted amount, part-paid
        bills use what is left, and paid and void bills are left out. The lines add up to the open AP total.
      </p>
    </div>
  )
}
