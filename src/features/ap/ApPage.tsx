/**
 * `/ap` — the accounts-payable desk (spec §6.5, §6.6; `TMS_DESIGN` §4.13).
 *
 * Six tabs that follow one carrier's money from delivered to sent: what we are waiting on
 * an invoice for, what is under review, what is approved and owed, what has been settled,
 * every posted row, and the aging behind all of it. Every figure on the page is integer
 * cents frozen on the bill at RECORD_BILL and formatted once by `formatCents`; the gates
 * come from `approvalReadiness` and the buckets from `@/lib/arAging`, through `apViews`.
 *
 * Own-fleet legs are not AP. A driver is paid through their settlement period, so an
 * own-asset row that reaches this board says so and offers no Record button — billing it
 * here would pay for the same freight twice.
 *
 * On dev, SES is denied: a remittance comes back NOT_SENT with the refusal, the copyable
 * body and an hour-long download. The page reports exactly that and never claims a send.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Filter, RefreshCw, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/useAuth'
import { useApWorklist, type ApWorklistRow } from '@/hooks/useApWorklist'
import { useCarrierAp } from '@/hooks/useCarrierAp'
import { useCarriers } from '@/hooks/useCarriers'
import { useOpenBills } from '@/hooks/useOpenBills'
import {
  getTmsSettings, graphqlErrorText, listBillsByMonth, reverseApPayment, unapproveBill, voidBill,
} from '@/lib/apiClient'
import {
  AGING_BUCKETS, AGING_BUCKET_LABEL, apAgingCsv, type AgingPartySummary,
} from '@/lib/arAging'
import { chicagoDateStr } from '@/lib/date'
import { saveBlob } from '@/lib/download'
import { formatCents } from '@/lib/invoiceBuild'
import { cn } from '@/lib/utils'
import { AgingStrip } from '@/features/ar/AgingStrip'
import { AP_STRIP_LABELS } from '@/features/ar/agingStripLabels'
import { ReasonDialog } from '@/features/ar/components/ReasonDialog'
import { agingChipFor, formatDay, lastThreeMonths, monthLabel } from '@/features/ar/arViews'
import {
  AP_PAYMENT_KIND_LABEL, AP_PAYMENT_METHOD_LABEL, AP_PAYEE_KIND_LABEL, AP_TABS, BILL_STATUS_LABEL,
  EMPTY_TO_BE_PAID_FILTERS, applyToBePaidFilters, avgDaysToPayBills, awaitingInvoiceTotals, billCarrierOptions,
  billGates, billsInReview, billsToPay, isOwnFleet, paidBills, payeeLabel, quickPayLabel, selectionBalanceCents,
  selectionCarrierId, type ApTabKey, type ToBePaidFilters,
} from './apViews'
import { ApCreditDialog } from './components/ApCreditDialog'
import { ApproveBillDialog } from './components/ApproveBillDialog'
import { PayCarrierDialog } from './components/PayCarrierDialog'
import { RecordBillDialog } from './components/RecordBillDialog'
import { SendRemittanceDialog } from './components/SendRemittanceDialog'
import { UpdateCarrierChargesDialog } from './components/UpdateCarrierChargesDialog'
import type { ApPaymentRecord, ApSettings, CarrierBillRecord, CarrierRecord } from '@/types/tms'

/** Which dialog is open, and the one thing it is open about. */
type ApDialog =
  | { kind: 'record'; loadCarrierId: string }
  | { kind: 'approve'; bill: CarrierBillRecord }
  | { kind: 'charges'; loadCarrierId: string; shipmentId: string }
  | { kind: 'pay'; carrierId: string; billIds?: string[] }
  | { kind: 'credit'; carrierId: string }
  | { kind: 'remittance'; payment: ApPaymentRecord }
  | { kind: 'void'; bill: CarrierBillRecord }
  | { kind: 'unapprove'; bill: CarrierBillRecord }
  | { kind: 'reverse'; payment: ApPaymentRecord }

const TH = 'px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-2 align-top'
const MONEY = 'px-2 py-2 text-right tabular-nums align-top'

export function ApPage() {
  // One clock for the whole page: the chips, the buckets and the CSV all answer as of the
  // same day, so a bill cannot read "Current" next to a 1–30 column it was counted in.
  const [asOf] = useState(() => chicagoDateStr(new Date()))

  const { isAdmin } = useAuth()
  const [tab, setTab] = useState<ApTabKey>('awaiting')
  const [dialog, setDialog] = useState<ApDialog | null>(null)
  const [busy, setBusy] = useState(false)

  const awaiting = useApWorklist('AWAITING_INVOICE')
  // The review rung's assignments, for the cached facts behind each bill's blocks: the
  // bill alone cannot say whether the rate con was signed or what paperwork is missing.
  const inReview = useApWorklist('IN_REVIEW')
  const open = useOpenBills()
  const { carriers } = useCarriers()

  const [filters, setFilters] = useState<ToBePaidFilters>(EMPTY_TO_BE_PAID_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  const months = useMemo(() => lastThreeMonths(asOf), [asOf])
  const [month, setMonth] = useState(() => months[0])
  const [monthBills, setMonthBills] = useState<CarrierBillRecord[]>([])
  const [monthLoading, setMonthLoading] = useState(true)

  const [apCarrierId, setApCarrierId] = useState<string | null>(null)
  const carrierAp = useCarrierAp(apCarrierId)

  const [settings, setSettings] = useState<Pick<ApSettings, 'apRequireSignedRateCon'> | null>(null)

  // No synchronous setState in the effect (react-hooks/set-state-in-effect): every write
  // happens in the promise chain, and the month picker owns its own spinner.
  const loadMonth = useCallback(() =>
    listBillsByMonth(month)
      .then((rows) => setMonthBills(rows))
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load that month'))
      .finally(() => setMonthLoading(false)),
  [month])
  useEffect(() => { loadMonth() }, [loadMonth])

  // The rate-con rule is a setting; a page that assumed it would show a block somebody
  // has already turned off. A failed read leaves it null and `approvalReadiness` falls
  // back to the house default.
  useEffect(() => {
    let alive = true
    getTmsSettings()
      .then((s) => { if (alive) setSettings(s) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const carriersById = useMemo(() => {
    const map = new Map<string, CarrierRecord>()
    for (const c of carriers) map.set(c.id, c)
    return map
  }, [carriers])

  const reviewRows = useMemo(() => {
    const map = new Map<string, ApWorklistRow>()
    for (const row of inReview.rows) map.set(row.loadCarrierId, row)
    return map
  }, [inReview.rows])

  const reviewBills = useMemo(() => billsInReview(open.bills), [open.bills])
  const approved = useMemo(() => billsToPay(open.bills), [open.bills])
  const payRows = useMemo(() => applyToBePaidFilters(approved, filters, asOf), [approved, filters, asOf])
  const settled = useMemo(() => paidBills(monthBills), [monthBills])
  const awaitingTotals = useMemo(() => awaitingInvoiceTotals(awaiting.rows), [awaiting.rows])

  const refreshAll = () =>
    Promise.all([awaiting.refresh(), inReview.refresh(), open.refresh(), carrierAp.refresh(), loadMonth()])
      .then(() => undefined)

  const closeAndRefresh = () => {
    setDialog(null)
    setSelected([])
    void refreshAll()
  }

  // A filter that hides a ticked bill must untick it: "Pay selected" would otherwise post
  // against a row nobody on this screen can see.
  const applyFilters = (next: ToBePaidFilters) => {
    setFilters(next)
    const visible = applyToBePaidFilters(approved, next, asOf).map((b) => b.id)
    setSelected((prev) => prev.filter((id) => visible.includes(id)))
  }

  const runVoid = (bill: CarrierBillRecord, reason: string) => {
    setBusy(true)
    voidBill({ billId: bill.id, reason })
      .then(() => {
        toast.success(`Bill ${bill.billNumber ?? bill.id} voided`)
        closeAndRefresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not void the bill'))
      .finally(() => setBusy(false))
  }

  const runUnapprove = (bill: CarrierBillRecord, reason: string) => {
    setBusy(true)
    unapproveBill({ billId: bill.id, reason })
      .then(() => {
        toast.success('Bill sent back to review')
        closeAndRefresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not unapprove the bill'))
      .finally(() => setBusy(false))
  }

  const runReverse = (payment: ApPaymentRecord, reason: string) => {
    setBusy(true)
    reverseApPayment({ paymentId: payment.id, reason })
      .then(() => {
        toast.success('Payment reversed')
        closeAndRefresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not reverse the payment'))
      .finally(() => setBusy(false))
  }

  const downloadAgingCsv = () => {
    saveBlob(new Blob([apAgingCsv(open.aging.byParty)], { type: 'text/csv' }), `ap-aging-${asOf}.csv`)
  }

  const counts: Record<ApTabKey, number> = {
    awaiting: awaiting.rows.length,
    review: reviewBills.length,
    'to-pay': approved.length,
    paid: settled.length,
    payments: carrierAp.payments.length,
    aging: open.aging.byParty.length,
  }

  const error = awaiting.error ?? inReview.error ?? open.error ?? carrierAp.error
  const loading = awaiting.loading || inReview.loading || open.loading

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Wallet size={18} />
        <h1 className="text-lg font-semibold">AP</h1>
        <Badge variant="outline">{formatCents(open.aging.totalCents)} open</Badge>
        <Badge variant="outline">{formatCents(open.approvedCents)} approved</Badge>
        {open.aging.lateCents > 0 && (
          <Badge variant="destructive">{formatCents(open.aging.lateCents)} late</Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-9 w-9"
          aria-label="Refresh AP"
          onClick={() => void refreshAll()}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </Button>
      </header>

      <nav role="tablist" aria-label="AP views" className="flex gap-1 overflow-x-auto border-b border-border px-5">
        {AP_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            aria-label={t.label}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              tab === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground',
            )}
          >
            {t.label}
            <Badge variant="outline" className="text-[10px]">{counts[t.key]}</Badge>
          </button>
        ))}
      </nav>

      {error && <p className="px-5 py-3 text-sm text-destructive">{error}</p>}

      <div className="flex-1 overflow-auto px-5 py-3">
        {tab === 'awaiting' && (
          <AwaitingTab
            rows={awaiting.rows}
            busy={busy}
            onRecord={(row) => setDialog({ kind: 'record', loadCarrierId: row.loadCarrierId })}
          />
        )}

        {tab === 'review' && (
          <ReviewTab
            bills={reviewBills}
            rows={reviewRows}
            carriersById={carriersById}
            settings={settings}
            isAdmin={isAdmin}
            busy={busy}
            onApprove={(bill) => setDialog({ kind: 'approve', bill })}
            onCharges={(bill) => setDialog({ kind: 'charges', loadCarrierId: bill.loadCarrierId, shipmentId: bill.shipmentId })}
            onVoid={(bill) => setDialog({ kind: 'void', bill })}
          />
        )}

        {tab === 'to-pay' && (
          <ToBePaidTab
            bills={payRows}
            allBills={approved}
            filters={filters}
            showFilters={showFilters}
            selected={selected}
            asOf={asOf}
            busy={busy}
            onToggleFilters={() => setShowFilters((s) => !s)}
            onFilters={applyFilters}
            onSelect={setSelected}
            onPay={(bill) => setDialog({ kind: 'pay', carrierId: bill.carrierId, billIds: [bill.id] })}
            onPaySelected={(carrierId) => setDialog({ kind: 'pay', carrierId, billIds: selected })}
            onUnapprove={(bill) => setDialog({ kind: 'unapprove', bill })}
          />
        )}

        {tab === 'paid' && (
          <PaidTab
            bills={settled}
            months={months}
            month={month}
            loading={monthLoading}
            onMonth={(ym) => { setMonthLoading(true); setMonth(ym) }}
          />
        )}

        {tab === 'payments' && (
          <PaymentsTab
            carriers={carriers}
            carrierId={apCarrierId}
            payments={carrierAp.payments}
            openCents={carrierAp.openCents}
            unappliedCents={carrierAp.unappliedCents}
            loading={carrierAp.loading}
            busy={busy}
            onCarrier={setApCarrierId}
            onPay={(carrierId) => setDialog({ kind: 'pay', carrierId })}
            onCredit={(carrierId) => setDialog({ kind: 'credit', carrierId })}
            onRemittance={(payment) => setDialog({ kind: 'remittance', payment })}
            onReverse={(payment) => setDialog({ kind: 'reverse', payment })}
          />
        )}

        {tab === 'aging' && (
          <AgingTab
            aging={open.aging}
            awaitingCents={awaitingTotals.cents}
            awaitingCount={awaitingTotals.count}
            avgDaysToPay={avgDaysToPayBills(monthBills)}
            paidMonthLabel={monthLabel(month)}
            onCsv={downloadAgingCsv}
          />
        )}
      </div>

      {dialog?.kind === 'record' && (
        <RecordBillDialog
          open
          loadCarrierId={dialog.loadCarrierId}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'approve' && (
        <ApproveBillDialog
          open
          bill={dialog.bill}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'charges' && (
        <UpdateCarrierChargesDialog
          open
          loadCarrierId={dialog.loadCarrierId}
          shipmentId={dialog.shipmentId}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'pay' && (
        <PayCarrierDialog
          open
          carrierId={dialog.carrierId}
          preselectBillIds={dialog.billIds}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'credit' && (
        <ApCreditDialog
          open
          carrierId={dialog.carrierId}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'remittance' && (
        <SendRemittanceDialog
          open
          payment={dialog.payment}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'void' && (
        <ReasonDialog
          title={`Void bill ${dialog.bill.billNumber ?? dialog.bill.id}`}
          description="Voiding releases the assignment for a fresh bill and leaves this one on the record. It cannot be undone."
          label="Why it is being voided"
          confirmLabel="Void bill"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => runVoid(dialog.bill, reason)}
        />
      )}
      {dialog?.kind === 'unapprove' && (
        <ReasonDialog
          title={`Send bill ${dialog.bill.billNumber ?? dialog.bill.id} back to review`}
          description="The bill drops off the pay run and returns to review. Money already paid against it stays applied."
          label="Why it is going back"
          confirmLabel="Unapprove bill"
          tone="default"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => runUnapprove(dialog.bill, reason)}
        />
      )}
      {dialog?.kind === 'reverse' && (
        <ReasonDialog
          title="Reverse payment"
          description="A reversal posts its own row and restores every balance this payment took. Nothing is deleted."
          label="Why it is being reversed"
          confirmLabel="Reverse payment"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => runReverse(dialog.payment, reason)}
        />
      )}
    </div>
  )
}

/* ── Awaiting invoice ────────────────────────────────────────────────────── */

function AwaitingTab({ rows, busy, onRecord }: {
  rows: ApWorklistRow[]
  busy: boolean
  onRecord: (row: ApWorklistRow) => void
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className={TH} scope="col">Shipment</th>
          <th className={TH} scope="col">Load</th>
          <th className={TH} scope="col">Carrier</th>
          <th className={TH} scope="col">Delivered</th>
          <th className={TH} scope="col">Rate con</th>
          <th className={TH} scope="col">Paperwork</th>
          <th className={cn(TH, 'text-right')} scope="col">Cost</th>
          <th className={TH} scope="col"><span className="sr-only">Record bill</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={8} className="py-8 text-center text-sm text-muted-foreground">No carrier owes us an invoice.</td></tr>
        )}
        {rows.map((row) => {
          const ownFleet = isOwnFleet(row)
          const quickPay = quickPayLabel(row.assignment)
          return (
            <tr key={row.loadCarrierId} className="border-b border-border/60">
              <td className={TD}>
                <Link className="text-primary hover:underline" to={`/shipments/${row.shipmentId}`}>
                  {row.shipmentNumber ?? row.shipmentId}
                </Link>
              </td>
              {/* The assignment carries the load's id, not its number; the shipment link above is the readable handle. */}
              <td className={cn(TD, 'text-xs text-muted-foreground')}>{row.loadId}</td>
              <td className={TD}>
                {ownFleet ? row.assignment.driverName ?? 'Own asset' : row.carrierName || '—'}
                {quickPay && !ownFleet && (
                  <Badge variant="outline" className="ml-1 text-[10px]">{quickPay}</Badge>
                )}
              </td>
              <td className={TD}>{row.deliveredAt ? formatDay(row.deliveredAt) : 'Not delivered'}</td>
              <td className={TD}>
                {ownFleet
                  ? <span className="text-muted-foreground">—</span>
                  : row.rateConSigned
                    ? <span>✓</span>
                    : <span className="text-destructive">✗ not signed</span>}
              </td>
              <td className={TD}>
                {ownFleet
                  ? <span className="text-muted-foreground">—</span>
                  : row.docsReady
                    ? <span>✓</span>
                    : <span className="text-destructive">{row.docsMissing.join(', ') || 'Missing'}</span>}
              </td>
              <td className={MONEY}>{formatCents(row.costCents)}</td>
              <td className={cn(TD, 'whitespace-nowrap text-right')}>
                {ownFleet ? (
                  <span className="text-xs text-muted-foreground">
                    Settled through driver pay —{' '}
                    <Link
                      className="text-primary hover:underline"
                      aria-label={`Driver settlements for ${row.assignment.driverName ?? 'this own-asset leg'}`}
                      to="/driver-pay"
                    >
                      settlement period
                    </Link>
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Record bill for ${row.shipmentNumber ?? row.loadCarrierId}`}
                    disabled={busy}
                    onClick={() => onRecord(row)}
                  >
                    Record bill
                  </Button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* ── In review ───────────────────────────────────────────────────────────── */

function ReviewTab({
  bills, rows, carriersById, settings, isAdmin, busy, onApprove, onCharges, onVoid,
}: {
  bills: CarrierBillRecord[]
  rows: Map<string, ApWorklistRow>
  carriersById: Map<string, CarrierRecord>
  settings: Pick<ApSettings, 'apRequireSignedRateCon'> | null
  isAdmin: boolean
  busy: boolean
  onApprove: (bill: CarrierBillRecord) => void
  onCharges: (bill: CarrierBillRecord) => void
  onVoid: (bill: CarrierBillRecord) => void
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className={TH} scope="col">Bill</th>
          <th className={TH} scope="col">Carrier</th>
          <th className={TH} scope="col">Bill date</th>
          <th className={TH} scope="col">Due</th>
          <th className={cn(TH, 'text-right')} scope="col">Gross</th>
          <th className={cn(TH, 'text-right')} scope="col">Fee</th>
          <th className={cn(TH, 'text-right')} scope="col">Net</th>
          <th className={TH} scope="col">Standing in the way</th>
          <th className={TH} scope="col"><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {bills.length === 0 && (
          <tr><td colSpan={9} className="py-8 text-center text-sm text-muted-foreground">No bill is waiting on review.</td></tr>
        )}
        {bills.map((bill) => {
          const gates = billGates({
            bill,
            row: rows.get(bill.loadCarrierId),
            carrier: carriersById.get(bill.carrierId) ?? null,
            settings,
            isAdmin,
          })
          return (
            <tr key={bill.id} className="border-b border-border/60">
              <td className={TD}>
                <Link className="text-primary hover:underline" to={`/ap/bills/${bill.id}`}>
                  {bill.billNumber ?? bill.id}
                </Link>
              </td>
              <td className={TD}>{bill.carrierName || '—'}</td>
              <td className={TD}>{formatDay(bill.billDate)}</td>
              <td className={TD}>{formatDay(bill.dueAt)}</td>
              <td className={MONEY}>
                {formatCents(bill.grossCents)}
                {bill.varianceCents !== 0 && (
                  <Badge variant="destructive" className="ml-1 text-[10px]">
                    {formatCents(bill.varianceCents)} variance
                  </Badge>
                )}
              </td>
              <td className={MONEY}>{bill.quickPayFeeCents ? formatCents(bill.quickPayFeeCents) : '—'}</td>
              <td className={cn(MONEY, 'font-medium')}>{formatCents(bill.netCents)}</td>
              <td className={TD}>
                {gates.blocks.length === 0 && gates.warnings.length === 0 && (
                  <span className="text-muted-foreground">Nothing — ready to approve</span>
                )}
                <ul className="space-y-0.5 text-xs text-destructive">
                  {gates.blocks.map((block) => <li key={block}>{block}</li>)}
                </ul>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {gates.warnings.map((warning) => <li key={warning.key}>{warning.message}</li>)}
                </ul>
              </td>
              <td className={cn(TD, 'whitespace-nowrap text-right')}>
                <Button size="sm" variant="ghost" aria-label={`Approve bill ${bill.billNumber ?? bill.id}`} disabled={busy} onClick={() => onApprove(bill)}>Approve</Button>
                <Button size="sm" variant="ghost" aria-label={`Update carrier charges for bill ${bill.billNumber ?? bill.id}`} disabled={busy} onClick={() => onCharges(bill)}>Update charges</Button>
                <Button size="sm" variant="ghost" aria-label={`Void bill ${bill.billNumber ?? bill.id}`} disabled={busy} onClick={() => onVoid(bill)}>Void</Button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* ── To be paid ──────────────────────────────────────────────────────────── */

function ToBePaidTab({
  bills, allBills, filters, showFilters, selected, asOf, busy,
  onToggleFilters, onFilters, onSelect, onPay, onPaySelected, onUnapprove,
}: {
  bills: CarrierBillRecord[]
  allBills: CarrierBillRecord[]
  filters: ToBePaidFilters
  showFilters: boolean
  selected: string[]
  asOf: string
  busy: boolean
  onToggleFilters: () => void
  onFilters: (filters: ToBePaidFilters) => void
  onSelect: (ids: string[]) => void
  onPay: (bill: CarrierBillRecord) => void
  onPaySelected: (carrierId: string) => void
  onUnapprove: (bill: CarrierBillRecord) => void
}) {
  const active = (filters.carrierId ? 1 : 0) + (filters.due ? 1 : 0) + (filters.payeeKind ? 1 : 0)
  // One payment is one carrier's: a selection spanning two of them cannot be posted as
  // one row, and the button says so instead of failing in the dialog.
  const payCarrierId = selectionCarrierId(bills, selected)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" aria-label="Filter approved bills" onClick={onToggleFilters}>
          <Filter size={14} className="mr-1" /> Filters
          {active > 0 && <Badge className="ml-1">{active}</Badge>}
        </Button>
        <span className="text-sm text-muted-foreground">
          {bills.length} bills · {selected.length} selected ({formatCents(selectionBalanceCents(bills, selected))})
        </span>
        <Button
          size="sm"
          aria-label="Pay selected bills"
          disabled={busy || selected.length === 0 || !payCarrierId}
          onClick={() => { if (payCarrierId) onPaySelected(payCarrierId) }}
        >
          Pay selected
        </Button>
        {selected.length > 0 && !payCarrierId && (
          <span className="text-xs text-muted-foreground">One payment covers one carrier; narrow the selection.</span>
        )}
      </div>

      {showFilters && (
        <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-muted/20 px-3 py-2 sm:grid-cols-3">
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Carrier</Label>
            <select
              aria-label="Filter carrier"
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={filters.carrierId}
              onChange={(e) => onFilters({ ...filters, carrierId: e.target.value })}
            >
              <option value="">All</option>
              {billCarrierOptions(allBills).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Due</Label>
            <select
              aria-label="Filter due"
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={filters.due}
              onChange={(e) => onFilters({ ...filters, due: e.target.value as ToBePaidFilters['due'] })}
            >
              <option value="">All</option>
              <option value="OVERDUE">Overdue</option>
              <option value="WEEK">Due within 7 days</option>
              <option value="LATER">Later</option>
            </select>
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Payee</Label>
            <select
              aria-label="Filter payee kind"
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={filters.payeeKind}
              onChange={(e) => onFilters({ ...filters, payeeKind: e.target.value as ToBePaidFilters['payeeKind'] })}
            >
              <option value="">All</option>
              <option value="CARRIER">{AP_PAYEE_KIND_LABEL.CARRIER}</option>
              <option value="FACTOR">{AP_PAYEE_KIND_LABEL.FACTOR}</option>
            </select>
          </div>
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH} scope="col"><span className="sr-only">Select</span></th>
            <th className={TH} scope="col">Bill</th>
            <th className={TH} scope="col">Carrier</th>
            <th className={TH} scope="col">Due</th>
            <th className={TH} scope="col">Age</th>
            <th className={cn(TH, 'text-right')} scope="col">Net</th>
            <th className={cn(TH, 'text-right')} scope="col">Paid</th>
            <th className={cn(TH, 'text-right')} scope="col">Balance</th>
            <th className={TH} scope="col">Payee</th>
            <th className={TH} scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {bills.length === 0 && (
            <tr><td colSpan={10} className="py-8 text-center text-sm text-muted-foreground">Nothing is approved and waiting in this view.</td></tr>
          )}
          {bills.map((bill) => {
            const chip = agingChipFor(bill.dueAt, asOf)
            const label = bill.billNumber ?? bill.id
            return (
              <tr key={bill.id} className="border-b border-border/60">
                <td className={TD}>
                  <input
                    type="checkbox"
                    aria-label={`Select bill ${label}`}
                    checked={selected.includes(bill.id)}
                    onChange={() => onSelect(
                      selected.includes(bill.id) ? selected.filter((id) => id !== bill.id) : [...selected, bill.id],
                    )}
                  />
                </td>
                <td className={TD}>
                  <Link className="text-primary hover:underline" to={`/ap/bills/${bill.id}`}>{label}</Link>
                  {bill.status === 'PARTIAL' && (
                    <Badge variant="outline" className="ml-1 text-[10px]">{BILL_STATUS_LABEL.PARTIAL}</Badge>
                  )}
                </td>
                <td className={TD}>{bill.carrierName || '—'}</td>
                <td className={TD}>{formatDay(bill.dueAt)}</td>
                <td className={TD}>
                  <Badge variant={chip.late ? 'destructive' : 'outline'} className="text-[10px]">{chip.label}</Badge>
                </td>
                <td className={MONEY}>{formatCents(bill.netCents)}</td>
                <td className={MONEY}>{formatCents(bill.paidCents)}</td>
                <td className={cn(MONEY, 'font-medium')}>{formatCents(bill.balanceCents)}</td>
                <td className={TD}>{payeeLabel(bill)}</td>
                <td className={cn(TD, 'whitespace-nowrap text-right')}>
                  <Button size="sm" variant="ghost" aria-label={`Pay bill ${label}`} disabled={busy} onClick={() => onPay(bill)}>Pay</Button>
                  <Button size="sm" variant="ghost" aria-label={`Unapprove bill ${label}`} disabled={busy} onClick={() => onUnapprove(bill)}>Unapprove</Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ── Paid ────────────────────────────────────────────────────────────────── */

function PaidTab({ bills, months, month, loading, onMonth }: {
  bills: CarrierBillRecord[]
  months: string[]
  month: string
  loading: boolean
  onMonth: (ym: string) => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Bill month</Label>
        <select
          aria-label="Bill month"
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={month}
          onChange={(e) => onMonth(e.target.value)}
        >
          {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
        </select>
        {loading && <span className="text-sm text-muted-foreground">Loading…</span>}
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH} scope="col">Bill</th>
            <th className={TH} scope="col">Carrier</th>
            <th className={TH} scope="col">Bill date</th>
            <th className={TH} scope="col">Paid</th>
            <th className={TH} scope="col">Payee</th>
            <th className={cn(TH, 'text-right')} scope="col">Net</th>
            <th className={cn(TH, 'text-right')} scope="col">Credits</th>
          </tr>
        </thead>
        <tbody>
          {bills.length === 0 && !loading && (
            <tr><td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">No carrier was paid off a {monthLabel(month)} bill.</td></tr>
          )}
          {bills.map((bill) => (
            <tr key={bill.id} className="border-b border-border/60">
              <td className={TD}>
                <Link className="text-primary hover:underline" to={`/ap/bills/${bill.id}`}>{bill.billNumber ?? bill.id}</Link>
              </td>
              <td className={TD}>{bill.carrierName || '—'}</td>
              <td className={TD}>{formatDay(bill.billDate)}</td>
              <td className={TD}>{formatDay(bill.paidAt)}</td>
              <td className={TD}>{payeeLabel(bill)}</td>
              <td className={MONEY}>{formatCents(bill.netCents)}</td>
              <td className={MONEY}>{bill.creditedCents ? formatCents(bill.creditedCents) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── Payments & credits ──────────────────────────────────────────────────── */

function PaymentsTab({
  carriers, carrierId, payments, openCents, unappliedCents, loading, busy,
  onCarrier, onPay, onCredit, onRemittance, onReverse,
}: {
  carriers: CarrierRecord[]
  carrierId: string | null
  payments: ApPaymentRecord[]
  openCents: number
  unappliedCents: number
  loading: boolean
  busy: boolean
  onCarrier: (id: string | null) => void
  onPay: (carrierId: string) => void
  onCredit: (carrierId: string) => void
  onRemittance: (payment: ApPaymentRecord) => void
  onReverse: (payment: ApPaymentRecord) => void
}) {
  const carrier = carriers.find((c) => c.id === carrierId) ?? null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Carrier</Label>
        <select
          aria-label="Choose carrier"
          className="h-8 min-w-56 rounded-md border border-input bg-background px-2 text-sm"
          value={carrierId ?? ''}
          onChange={(e) => onCarrier(e.target.value || null)}
        >
          <option value="">Choose a carrier…</option>
          {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {carrier && (
          <>
            <Badge variant="outline">{formatCents(openCents)} open</Badge>
            <Badge variant="outline">{formatCents(unappliedCents)} credit held</Badge>
            <Button size="sm" aria-label="Pay carrier" disabled={busy} onClick={() => onPay(carrier.id)}>Pay carrier</Button>
            <Button size="sm" variant="outline" aria-label="New credit" disabled={busy} onClick={() => onCredit(carrier.id)}>New credit</Button>
          </>
        )}
      </div>

      {!carrier && <p className="text-sm text-muted-foreground">Choose a carrier to see their posted rows.</p>}

      {carrier && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className={TH} scope="col">Kind</th>
              <th className={TH} scope="col">Date</th>
              <th className={TH} scope="col">Method</th>
              <th className={TH} scope="col">Reference</th>
              <th className={cn(TH, 'text-right')} scope="col">Amount</th>
              <th className={cn(TH, 'text-right')} scope="col">Applied</th>
              <th className={cn(TH, 'text-right')} scope="col">Unapplied</th>
              <th className={TH} scope="col">Remittance</th>
              <th className={TH} scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 && !loading && (
              <tr><td colSpan={9} className="py-8 text-center text-sm text-muted-foreground">Nothing has been posted for {carrier.name}.</td></tr>
            )}
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-border/60">
                <td className={TD}>{AP_PAYMENT_KIND_LABEL[p.kind]}</td>
                <td className={TD}>{formatDay(p.paidAt)}</td>
                <td className={TD}>{p.method ? AP_PAYMENT_METHOD_LABEL[p.method] : '—'}</td>
                <td className={TD}>{p.reference || '—'}</td>
                <td className={MONEY}>{formatCents(p.amountCents)}</td>
                <td className={MONEY}>{formatCents(p.appliedCents)}</td>
                <td className={MONEY}>{formatCents(p.unappliedCents)}</td>
                <td className={TD}>
                  {p.remittanceSentAt
                    ? `Sent ${formatDay(p.remittanceSentAt)}`
                    : p.markedSentAt
                      ? `Marked sent ${formatDay(p.markedSentAt)}`
                      : <span className="text-muted-foreground">Not sent</span>}
                </td>
                <td className={cn(TD, 'whitespace-nowrap text-right')}>
                  {p.kind === 'PAYMENT' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Send remittance for ${formatCents(p.amountCents)} paid ${formatDay(p.paidAt)}`}
                      disabled={busy}
                      onClick={() => onRemittance(p)}
                    >
                      Send remittance
                    </Button>
                  )}
                  {p.kind !== 'REVERSAL' && !p.reversedByPaymentId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Reverse ${AP_PAYMENT_KIND_LABEL[p.kind].toLowerCase()} of ${formatCents(p.amountCents)}`}
                      disabled={busy}
                      onClick={() => onReverse(p)}
                    >
                      Reverse
                    </Button>
                  )}
                  {p.reversedByPaymentId && <span className="text-xs text-muted-foreground">Reversed</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/* ── Aging ───────────────────────────────────────────────────────────────── */

function AgingTab({ aging, awaitingCents, awaitingCount, avgDaysToPay, paidMonthLabel, onCsv }: {
  aging: AgingPartySummary
  awaitingCents: number
  awaitingCount: number
  avgDaysToPay: number | null
  paidMonthLabel: string
  onCsv: () => void
}) {
  return (
    <div className="space-y-4">
      <AgingStrip
        labels={AP_STRIP_LABELS}
        openCents={aging.totalCents}
        lateCents={aging.lateCents}
        deliveredNotInvoicedCents={awaitingCents}
        deliveredNotInvoicedCount={awaitingCount}
        avgDaysToPay={avgDaysToPay}
        paidMonthLabel={paidMonthLabel}
      />

      <div className="flex justify-end">
        <Button variant="outline" size="sm" aria-label="Download AP aging CSV" onClick={onCsv}>
          <Download size={14} className="mr-1" /> CSV
        </Button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH} scope="col">Carrier</th>
            {AGING_BUCKETS.map((b) => <th key={b} className={cn(TH, 'text-right')} scope="col">{AGING_BUCKET_LABEL[b]}</th>)}
            <th className={cn(TH, 'text-right')} scope="col">Total</th>
            <th className={cn(TH, 'text-right')} scope="col">Late</th>
            <th className={cn(TH, 'text-right')} scope="col">Oldest</th>
          </tr>
        </thead>
        <tbody>
          {aging.byParty.length === 0 && (
            <tr><td colSpan={9} className="py-8 text-center text-sm text-muted-foreground">We owe nothing.</td></tr>
          )}
          {aging.byParty.map((row) => (
            <tr key={row.partyId} className="border-b border-border/60">
              <td className={TD}>{row.partyName || row.partyId}</td>
              {AGING_BUCKETS.map((b) => <td key={b} className={MONEY}>{formatCents(row.byBucket[b])}</td>)}
              <td className={cn(MONEY, 'font-medium')}>{formatCents(row.totalCents)}</td>
              <td className={MONEY}>{row.lateCount || '—'}</td>
              <td className={MONEY}>{row.oldestDays ? `${row.oldestDays}d` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
