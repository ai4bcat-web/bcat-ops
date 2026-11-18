/**
 * `/finance/cash-planner` — the Cash planner (Ryne 2026-11-18). He types what is in each bank account and what he owes
 * outside the payables; it lists what to pay this week and what can wait, from the live payables. The rules are in
 * `src/lib/cashPlanner.ts` and written out at the foot of the page. Nothing here pays a bill or sends a remittance:
 * "Select these bills" only puts approved bills in the Selected tab, where Pay selected still has to be pressed.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsCard, TmsField, TmsInput, TmsPage } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { useOpenBills } from '@/hooks/useOpenBills'
import { useVendorPayables } from '@/hooks/useVendorPayables'
import { getFactorRemitEmails, graphqlErrorText, listCarrierPaymentInfo, selectBillsForPayment, type CarrierPaymentInfo } from '@/lib/apiClient'
import { chicagoDateStr } from '@/lib/date'
import { applyFactorRemit, factorNameIndex, summarizeFactors } from '@/lib/factorRemit'
import { formatCents } from '@/lib/invoiceBuild'
import { multiCarrierLoadIds, payeeNameFor, setFactorNamesForLabels, withLegSuffix } from '@/features/ap/apViews'
import { useLegIndex } from '@/features/ap/useLegIndex'
import {
  buildCashPlan, cents, DEFAULT_PLANNER_INPUTS, PLANNER_FIELD_KEYS, readAmount, readInputs,
  type PlanBillRow, type PlannerBill, type PlannerFields, type PlannerInputs,
} from '@/lib/cashPlanner'
import '@/features/ar/components/agingReport.css'

const STORE_KEY = 'bcat.cashPlanner.v1'

const toFields = (i: PlannerInputs): PlannerFields =>
  Object.fromEntries(PLANNER_FIELD_KEYS.map((k) => [k, i[k] == null || i[k] === 0 ? (k === 'bcatBuffer' || k === 'ivanBuffer' ? String(i[k]) : '') : String(i[k])])) as PlannerFields

/** The last numbers typed on this browser, for this person. localStorage can be blocked, so it is never relied on. */
function loadFields(who: string): PlannerFields {
  try {
    const raw = window.localStorage.getItem(`${STORE_KEY}:${who}`)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PlannerFields>
      const base = toFields(DEFAULT_PLANNER_INPUTS)
      for (const k of PLANNER_FIELD_KEYS) if (typeof parsed[k] === 'string') base[k] = parsed[k] as string
      return base
    }
  } catch { /* fall through to the defaults */ }
  return toFields(DEFAULT_PLANNER_INPUTS)
}

function saveFields(who: string, f: PlannerFields): void {
  try { window.localStorage.setItem(`${STORE_KEY}:${who}`, JSON.stringify(f)) } catch { /* private window: nothing to keep */ }
}

const money = (c: number) => formatCents(c)

const actionTone = { pay: 'green', partial: 'orange', 'wait-cash': 'red', approve: 'orange', later: 'gray' } as const
const actionLabel = { pay: 'Pay', partial: 'Part pay', 'wait-cash': 'Waits', approve: 'Approve first', later: 'Can wait' } as const

function BillTable({ rows, label }: { rows: PlanBillRow[]; label: string }) {
  if (rows.length === 0) return null
  return (
    <div className="tms-aging-table-wrap" style={{ display: 'block' }}>
      <table className="tms-aging-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Bill</th>
            <th scope="col">Pay to</th>
            <th scope="col">Due</th>
            <th scope="col">Why</th>
            <th scope="col" className="tms-dg-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.bill.id}>
              <td>PRO {r.bill.pro}</td>
              <td>{r.bill.payee}</td>
              <td>{r.bill.dueAt || '—'}</td>
              <td><TmsBadge tone={actionTone[r.action]}>{actionLabel[r.action]}</TmsBadge> <span className="tms-muted text-xs">{r.reason}</span></td>
              <td className="tms-dg-right tabular-nums">{money(r.bill.balanceCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const sumRows = (rs: readonly PlanBillRow[]) => rs.reduce((n, r) => n + r.bill.balanceCents, 0)

export function CashPlannerPage() {
  const { user } = useAuth()
  const who = user?.email?.toLowerCase() || 'me'
  const [fields, setFields] = useState<PlannerFields>(() => loadFields(who))
  const [confirmSelect, setConfirmSelect] = useState(false)
  const [busy, setBusy] = useState(false)
  const [asOf] = useState(() => chicagoDateStr(new Date()))
  const open = useOpenBills()
  const vendor = useVendorPayables()
  // Bumped when the factor names load, so the Pay to labels below are drawn again with the table's spelling.
  const [, setNamesVersion] = useState(0)
  // The payment methods behind the bills, so a factored carrier's Pay to reads the factor and not the carrier.
  const [infos, setInfos] = useState<CarrierPaymentInfo[]>([])

  // Name each factor as the Factoring companies table does, the same as the Payable page.
  useEffect(() => {
    let alive = true
    Promise.all([listCarrierPaymentInfo(), getFactorRemitEmails()])
      .then(([rows, emails]) => {
        if (!alive) return
        setFactorNamesForLabels(factorNameIndex(summarizeFactors(rows, emails)))
        setInfos(applyFactorRemit(rows, emails))
        setNamesVersion((n) => n + 1)
      })
      .catch(() => { /* the bills still list, under the name on each bill */ })
    return () => { alive = false }
  }, [])

  const inputs = useMemo(() => readInputs(fields), [fields])
  // Drawn each time rather than memoised: the labels read the factor names, which load after the bills. 100-odd rows.
  // A load that pays several carriers lists each bill as 14598-1, 14598-2.
  const billedLegIds = useMemo(() => new Set(open.bills.map((b) => b.loadCarrierId)), [open.bills])
  const legLoadIds = useMemo(() => multiCarrierLoadIds([], open.bills), [open.bills])
  const legs = useLegIndex(legLoadIds, billedLegIds)
  const bills: PlannerBill[] = withLegSuffix(open.bills, legs).map((b) => ({
    id: b.id,
    pro: (b.shipmentNumber || b.loadNumber) ? `${b.shipmentNumber || b.loadNumber}${b.legSuffix ?? ''}` : b.billNumber || b.id.slice(0, 8),
    carrier: b.carrierName || 'Carrier',
    payee: payeeNameFor(b, infos),
    dueAt: (b.dueAt || '').slice(0, 10),
    balanceCents: b.balanceCents,
    status: b.status as PlannerBill['status'],
    datesPending: b.datesPending === true,
  }))
  const plan = buildCashPlan(inputs, bills, vendor.items, asOf)

  const set = (k: keyof PlannerInputs, value: string) => {
    setFields((f) => {
      const next = { ...f, [k]: value }
      saveFields(who, next)
      return next
    })
    setConfirmSelect(false)
  }

  const { bcat, ivan, vendors } = plan
  const loading = open.loading || vendor.loading
  const selectable = bcat.pay.filter((r) => r.bill.status === 'TO_BE_PAID' || r.bill.status === 'PARTIAL')
  const hasCash = inputs.bcatCash > 0 || inputs.ivanCash > 0

  const runSelect = () => {
    const ids = selectable.map((r) => r.bill.id)
    setBusy(true)
    selectBillsForPayment({ billIds: ids })
      .then((r) => {
        if (r.selected.length) toast.success(`${r.selected.length} bill${r.selected.length === 1 ? '' : 's'} selected for payment. Nothing has been paid.`)
        if (r.skipped.length) toast.error(`${r.skipped.length} not selected: ${[...new Set(r.skipped.map((x) => x.reason))].join('; ')}`)
        setConfirmSelect(false)
        void open.refresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not select the bills'))
      .finally(() => setBusy(false))
  }

  const box = (k: keyof PlannerInputs, label: string, hint?: string, placeholder = '$0') => (
    <TmsField label={label} hint={hint}>
      <TmsInput inputMode="decimal" value={fields[k]} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} />
    </TmsField>
  )

  return (
    <TmsPage title="Cash planner" actions={<Link className="tms-btn tms-btn-secondary tms-btn-sm" to="/tms/invoicing/payable?tab=cash">Cash requirements</Link>}>
      <p className="tms-muted text-sm" style={{ margin: '0 0 12px', maxWidth: 760 }}>
        Tell it what is in each bank account and what you owe outside the payables. It lists what to pay this week, oldest first,
        and what can wait. It pays nothing. This is a set of fixed rules, shown at the bottom, and not financial advice.
      </p>

      <TmsCard title="What you have and owe">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {box('bcatCash', 'BCAT bank balance')}
          {box('ivanCash', 'Ivan bank balance')}
          {box('bcatBuffer', 'BCAT: keep at least', 'Never spent')}
          {box('ivanBuffer', 'Ivan: keep at least', 'Never spent, except on driver settlements')}
          {box('driverSettlements', 'Driver settlements owed', 'Paid from Ivan')}
          {box('cardBalance', 'Credit card balance', 'Paid from Ivan')}
          {box('cardApr', 'Card APR (%)', 'Optional', '—')}
          {box('otherObligations', 'Anything else due this week', 'Paid from Ivan')}
          {box('transfer', 'Move from Ivan to BCAT', plan.suggestedTransferCents > 0 ? `Ivan could move another ${money(plan.suggestedTransferCents)}` : 'Optional')}
        </div>
        {plan.suggestedTransferCents > 0 && (
          <div style={{ marginTop: 8 }}>
            <TmsButton size="sm" onClick={() => set('transfer', String(readAmount(fields.transfer) + plan.suggestedTransferCents / 100))}>
              Move {money(plan.suggestedTransferCents)} more to BCAT
            </TmsButton>
            <span className="tms-muted text-xs" style={{ marginLeft: 8 }}>Only changes this plan. You move the money yourself.</span>
          </div>
        )}
        <p className="tms-muted text-xs" style={{ margin: '8px 0 0' }}>Saved on this browser for you only.</p>
      </TmsCard>

      {open.error && <TmsAlert tone="red">{open.error}</TmsAlert>}
      {vendor.error && <TmsAlert tone="red">{vendor.error}</TmsAlert>}
      {loading && <p className="tms-muted text-sm">Loading the payables…</p>}
      {!loading && !hasCash && <TmsAlert tone="blue">Enter the two bank balances to see the plan.</TmsAlert>}

      {!loading && hasCash && (
        <>
          <dl aria-label="Plan summary" data-testid="cash-plan-summary" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 32px', margin: '16px 0 12px' }}>
            <div><dt className="tms-muted text-xs">BCAT owes by {bcat.payFriday}</dt><dd className="text-lg"><strong>{money(bcat.dueByFridayCents)}</strong></dd></div>
            <div><dt className="tms-muted text-xs">BCAT pays now</dt><dd className="text-lg"><strong>{money(bcat.payCents)}</strong> · {bcat.pay.length} bills</dd></div>
            <div><dt className="tms-muted text-xs">Still unpaid, due by Friday</dt><dd className="text-lg">{money(bcat.unpaidCents)} · {bcat.unpaid.length} bills</dd></div>
            <div><dt className="tms-muted text-xs">Ivan pays</dt><dd className="text-lg"><strong>{money(ivan.paidCents)}</strong></dd></div>
            <div><dt className="tms-muted text-xs">Ivan cash left</dt><dd className="text-lg">{money(ivan.remainingCents)}{ivan.belowBuffer ? ' · under the buffer' : ''}</dd></div>
          </dl>

          <TmsCard
            title={`BCAT: carrier bills, pay Friday ${bcat.payFriday}`}
            actions={selectable.length > 0 ? (
              confirmSelect ? (
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <span className="text-sm">Select {selectable.length} bill{selectable.length === 1 ? '' : 's'} ({money(sumRows(selectable))})? Nothing is paid.</span>
                  <TmsButton size="sm" variant="primary" disabled={busy} onClick={runSelect}>Yes, select them</TmsButton>
                  <TmsButton size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmSelect(false)}>Cancel</TmsButton>
                </span>
              ) : (
                <TmsButton size="sm" onClick={() => setConfirmSelect(true)} data-testid="select-plan-bills">Select these bills</TmsButton>
              )
            ) : undefined}
          >
            <p className="text-sm" style={{ margin: '0 0 8px' }}>
              Can spend {money(bcat.availableCents)} ({money(cents(inputs.bcatCash))}
              {inputs.transfer > 0 ? ` + ${money(cents(inputs.transfer))} from Ivan` : ''} − {money(cents(inputs.bcatBuffer))} kept).
              Paying {money(bcat.payCents)} leaves {money(bcat.spareCents)} spare.
            </p>
            {bcat.pay.length === 0 && <p className="tms-muted text-sm">Nothing fits within the cash above the buffer.</p>}
            <BillTable rows={bcat.pay} label="Bills to pay this week" />
            {bcat.unpaid.length > 0 && (
              <>
                <h4 style={{ margin: '14px 0 6px' }}>Due by Friday, but the cash runs out ({money(bcat.unpaidCents)})</h4>
                <BillTable rows={bcat.unpaid} label="Bills that wait for cash" />
              </>
            )}
            {bcat.approve.length > 0 && (
              <>
                <h4 style={{ margin: '14px 0 6px' }}>Due by Friday, still in review ({money(sumRows(bcat.approve))})</h4>
                <BillTable rows={bcat.approve} label="Bills to approve first" />
              </>
            )}
            <p className="tms-muted text-sm" style={{ margin: '12px 0 0' }}>
              Can wait: {bcat.later.length} approved or in-review bill{bcat.later.length === 1 ? '' : 's'} due after Friday ({money(sumRows(bcat.later))})
              and {bcat.notScheduled.length} waiting on an invoice date ({money(bcat.notScheduled.reduce((n, b) => n + b.balanceCents, 0))}).
            </p>
          </TmsCard>

          <TmsCard title="Ivan: settlements, vendors and the card">
            <p className="text-sm" style={{ margin: '0 0 8px' }}>
              Cash {money(cents(inputs.ivanCash))}{inputs.transfer > 0 ? `, ${money(cents(inputs.transfer))} moved to BCAT` : ''}, {money(cents(inputs.ivanBuffer))} kept.
              After everything below, {money(ivan.remainingCents)} is left, {money(ivan.spareAboveBufferCents)} above the buffer.
            </p>
            {ivan.lines.length === 0 ? <p className="tms-muted text-sm">Nothing to pay from Ivan yet.</p> : (
              <div className="tms-aging-table-wrap" style={{ display: 'block' }}>
                <table className="tms-aging-table" aria-label="Ivan payments">
                  <thead>
                    <tr><th scope="col">What</th><th scope="col">Due / note</th><th scope="col">Why</th><th scope="col" className="tms-dg-right">Amount</th></tr>
                  </thead>
                  <tbody>
                    {ivan.lines.map((l, i) => (
                      <tr key={`${l.key}-${i}`}>
                        <td>{l.label}</td>
                        <td>{l.detail}</td>
                        <td><TmsBadge tone={actionTone[l.action]}>{actionLabel[l.action]}</TmsBadge> <span className="tms-muted text-xs">{l.reason}</span></td>
                        <td className="tms-dg-right tabular-nums">{money(l.cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(vendors.unpriced.length > 0 || vendors.duplicates.length > 0) && (
              <p className="tms-muted text-sm" style={{ margin: '12px 0 0' }}>
                {vendors.unpriced.length > 0 && <>{vendors.unpriced.length} vendor bill{vendors.unpriced.length === 1 ? ' has' : 's have'} no amount yet, so they are not in the plan. </>}
                {vendors.duplicates.length > 0 && <>{vendors.duplicates.length} look{vendors.duplicates.length === 1 ? 's' : ''} like a repeat of another vendor bill and {vendors.duplicates.length === 1 ? 'is' : 'are'} counted once. </>}
                <Link to="/tms/vendors">Open Vendor AP</Link>
              </p>
            )}
          </TmsCard>
        </>
      )}

      <TmsCard title="The rules">
        <ul className="text-sm" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>Every carrier bill comes out of BCAT. Vendor bills, driver settlements, the card and anything else you list come out of Ivan. Vendor bills are Ivan's because they are truck leasing, repairs and parts.</li>
          <li>This week means up to the next pay Friday (today, if it is Friday). A bill is in it when it is past due or due on or before that Friday.</li>
          <li>Only an approved bill (To be paid, Partly paid) can be paid. A bill still in review takes none of the cash and is listed as approve first.</li>
          <li>BCAT spends its cash, plus anything moved over from Ivan, less the amount you keep. Bills are taken oldest due date first and paid whole. If one does not fit, a smaller later one may still fit.</li>
          <li>Ivan pays driver settlements first and always, even if that dips under its buffer. Then vendor bills (oldest first), anything else you listed, and the card, each only while cash stays at or above the buffer. The card takes whatever is left, up to its balance.</li>
          <li>What Ivan has above its buffer after that is what it could move to BCAT. You decide whether to move it.</li>
          <li>Money coming in is not counted. Customer payments this week would let BCAT pay more. Ivan's day-to-day costs are covered only by its buffer.</li>
        </ul>
      </TmsCard>
    </TmsPage>
  )
}

export default CashPlannerPage
