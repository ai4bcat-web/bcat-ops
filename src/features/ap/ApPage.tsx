/**
 * The payable half of `/tms/invoicing` (spec §6.5, §6.6; `TMS_DESIGN` §4.13).
 *
 * Six views that follow one carrier's money out of the door: the legs nobody has
 * invoiced us for, the bills in review, the pay run, what was settled, every posted row,
 * and the aging behind all of it. Every figure is integer cents frozen on the bill when
 * it was recorded; the deciding lives in `apViews.ts` and `@/lib/carrierBill`.
 *
 * It renders as one MVMNT list page: the Receivable/Payable view tabs come from
 * `InvoicingPage`, the AP ladder is the status quick-tab strip, and each view swaps the
 * columns under it.
 *
 * An own-fleet leg never appears as a carrier bill: the driver is paid through
 * settlements, and the Awaiting view says so instead of offering a Record button.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge, TmsButton, TmsCard, TmsField, TmsSelect, TmsListPage,
  type ColumnDef, type TmsListPageProps, type TmsTabGroup,
} from '@/features/tms/kit'
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

const RIGHT = 'block text-right tabular-nums'

/** The lists do not page: the footer counts what the view holds. */
function wholeList(total: number) {
  return { from: total === 0 ? 0 : 1, to: total, total, pageSize: total }
}

/**
 * One view's half of the list page. Columns, rows and `rowKey` are built together by the
 * view that owns them, so the row type is erased here and the page renders them all.
 */
type ListView = Omit<TmsListPageProps<never>, 'title' | 'viewTabs' | 'quickTabs' | 'onRefresh'>

function view<T>(config: Omit<TmsListPageProps<T>, 'title' | 'viewTabs' | 'quickTabs' | 'onRefresh'>): ListView {
  return config as unknown as ListView
}

export function ApPage({ viewTabs }: { viewTabs?: TmsTabGroup } = {}) {
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

  const chrome = {
    title: 'Invoicing',
    viewTabs,
    quickTabs: {
      tabs: AP_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] })),
      active: tab,
      onSelect: (key: string) => setTab(key as ApTabKey),
    },
    onRefresh: () => void refreshAll(),
  }

  const errorBanner = error
    ? <p style={{ color: 'var(--tms-badge-red)' }} className="text-sm">{error}</p>
    : null

  const carrier = carriers.find((c) => c.id === apCarrierId) ?? null

  // One `TmsListPage` for all six views: switching view swaps the columns and the rows
  // under the same chrome, so the tab strip itself is never torn down and remounted.
  const current =
    tab === 'awaiting' ? awaitingView({
      banner: errorBanner,
      rows: awaiting.rows,
      busy,
      onRecord: (row) => setDialog({ kind: 'record', loadCarrierId: row.loadCarrierId }),
    })
    : tab === 'review' ? reviewView({
      banner: errorBanner,
      bills: reviewBills,
      rows: reviewRows,
      carriersById,
      settings,
      isAdmin,
      busy,
      onApprove: (bill) => setDialog({ kind: 'approve', bill }),
      onCharges: (bill) => setDialog({ kind: 'charges', loadCarrierId: bill.loadCarrierId, shipmentId: bill.shipmentId }),
      onVoid: (bill) => setDialog({ kind: 'void', bill }),
    })
    : tab === 'to-pay' ? toBePaidView({
      errorBanner,
      bills: payRows,
      allBills: approved,
      filters,
      showFilters,
      selected,
      asOf,
      busy,
      onToggleFilters: () => setShowFilters((s) => !s),
      onFilters: applyFilters,
      onSelect: setSelected,
      onPay: (bill) => setDialog({ kind: 'pay', carrierId: bill.carrierId, billIds: [bill.id] }),
      onPaySelected: (carrierId) => setDialog({ kind: 'pay', carrierId, billIds: selected }),
      onUnapprove: (bill) => setDialog({ kind: 'unapprove', bill }),
    })
    : tab === 'paid' ? paidView({
      banner: errorBanner,
      bills: settled,
      months,
      month,
      loading: monthLoading,
      onMonth: (ym: string) => { setMonthLoading(true); setMonth(ym) },
    })
    : tab === 'payments' ? paymentsView({
      banner: errorBanner,
      carriers,
      carrier,
      payments: carrierAp.payments,
      openCents: carrierAp.openCents,
      unappliedCents: carrierAp.unappliedCents,
      busy,
      onCarrier: setApCarrierId,
      onPay: (carrierId) => setDialog({ kind: 'pay', carrierId }),
      onCredit: (carrierId) => setDialog({ kind: 'credit', carrierId }),
      onRemittance: (payment) => setDialog({ kind: 'remittance', payment }),
      onReverse: (payment) => setDialog({ kind: 'reverse', payment }),
    })
    : agingView({
      errorBanner,
      aging: open.aging,
      awaitingCents: awaitingTotals.cents,
      awaitingCount: awaitingTotals.count,
      avgDaysToPay: avgDaysToPayBills(monthBills),
      paidMonthLabel: monthLabel(month),
      onCsv: downloadAgingCsv,
    })

  return (
    <>
      <TmsListPage<never> {...chrome} {...current} />

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
    </>
  )
}

/* ── Awaiting invoice ────────────────────────────────────────────────────── */

function awaitingView({ banner, rows, busy, onRecord }: {
  banner: ReactNode
  rows: ApWorklistRow[]
  busy: boolean
  onRecord: (row: ApWorklistRow) => void
}): ListView {
  const columns: ColumnDef<ApWorklistRow>[] = [
    {
      key: 'shipment',
      header: 'SHIPMENT',
      render: (row) => <Link to={`/tms/shipments/${row.shipmentId}`}>{row.shipmentNumber ?? row.shipmentId}</Link>,
    },
    // The assignment carries the load's id, not its number; the shipment link is the readable handle.
    { key: 'load', header: 'LOAD', render: (row) => <span className="text-xs tms-muted">{row.loadId}</span> },
    {
      key: 'carrier',
      header: 'CARRIER',
      render: (row) => {
        const ownFleet = isOwnFleet(row)
        const quickPay = quickPayLabel(row.assignment)
        return (
          <>
            {ownFleet ? row.assignment.driverName ?? 'Own asset' : row.carrierName || '—'}
            {quickPay && !ownFleet && <> <TmsBadge tone="gray">{quickPay}</TmsBadge></>}
          </>
        )
      },
    },
    {
      key: 'delivered',
      header: 'DELIVERED',
      render: (row) => (row.deliveredAt ? formatDay(row.deliveredAt) : 'Not delivered'),
    },
    {
      key: 'rateCon',
      header: 'RATE CON',
      render: (row) => (
        isOwnFleet(row)
          ? <span className="tms-muted">—</span>
          : row.rateConSigned
            ? <span>✓</span>
            : <span style={{ color: 'var(--tms-badge-red)' }}>✗ not signed</span>
      ),
    },
    {
      key: 'paperwork',
      header: 'PAPERWORK',
      render: (row) => (
        isOwnFleet(row)
          ? <span className="tms-muted">—</span>
          : row.docsReady
            ? <span>✓</span>
            : <span style={{ color: 'var(--tms-badge-red)' }}>{row.docsMissing.join(', ') || 'Missing'}</span>
      ),
    },
    { key: 'cost', header: 'COST', render: (row) => <span className={RIGHT}>{formatCents(row.costCents)}</span> },
    {
      key: 'record',
      header: '',
      render: (row) => (
        isOwnFleet(row) ? (
          <span className="text-xs tms-muted">
            Settled through driver pay —{' '}
            <Link
              aria-label={`Driver settlements for ${row.assignment.driverName ?? 'this own-asset leg'}`}
              to="/driver-pay"
            >
              settlement period
            </Link>
          </span>
        ) : (
          <TmsButton
            size="sm"
            aria-label={`Record bill for ${row.shipmentNumber ?? row.loadCarrierId}`}
            disabled={busy}
            onClick={() => onRecord(row)}
          >
            Record bill
          </TmsButton>
        )
      ),
    },
  ]

  return view<ApWorklistRow>({
    banner,
    columns,
    rows,
    rowKey: (row) => row.loadCarrierId,
    page: wholeList(rows.length),
    emptyText: 'No carrier owes us an invoice.',
  })
}

/* ── In review ───────────────────────────────────────────────────────────── */

function reviewView({
  banner, bills, rows, carriersById, settings, isAdmin, busy, onApprove, onCharges, onVoid,
}: {
  banner: ReactNode
  bills: CarrierBillRecord[]
  rows: Map<string, ApWorklistRow>
  carriersById: Map<string, CarrierRecord>
  settings: Pick<ApSettings, 'apRequireSignedRateCon'> | null
  isAdmin: boolean
  busy: boolean
  onApprove: (bill: CarrierBillRecord) => void
  onCharges: (bill: CarrierBillRecord) => void
  onVoid: (bill: CarrierBillRecord) => void
}): ListView {
  const columns: ColumnDef<CarrierBillRecord>[] = [
    {
      key: 'bill',
      header: 'BILL',
      render: (bill) => (
        <Link to={`/tms/invoicing/payable/bills/${bill.id}`}>{bill.billNumber ?? bill.id}</Link>
      ),
    },
    { key: 'carrier', header: 'CARRIER', render: (bill) => bill.carrierName || '—' },
    { key: 'billDate', header: 'BILL DATE', render: (bill) => formatDay(bill.billDate) },
    { key: 'due', header: 'DUE', render: (bill) => formatDay(bill.dueAt) },
    {
      key: 'gross',
      header: 'GROSS',
      render: (bill) => (
        <span className={RIGHT}>
          {formatCents(bill.grossCents)}
          {bill.varianceCents !== 0 && (
            <> <TmsBadge tone="red">{formatCents(bill.varianceCents)} variance</TmsBadge></>
          )}
        </span>
      ),
    },
    {
      key: 'fee',
      header: 'FEE',
      render: (bill) => <span className={RIGHT}>{bill.quickPayFeeCents ? formatCents(bill.quickPayFeeCents) : '—'}</span>,
    },
    {
      key: 'net',
      header: 'NET',
      render: (bill) => <span className={`${RIGHT} font-medium`}>{formatCents(bill.netCents)}</span>,
    },
    {
      key: 'gates',
      header: 'STANDING IN THE WAY',
      render: (bill) => {
        const gates = billGates({
          bill,
          row: rows.get(bill.loadCarrierId),
          carrier: carriersById.get(bill.carrierId) ?? null,
          settings,
          isAdmin,
        })
        return (
          <>
            {gates.blocks.length === 0 && gates.warnings.length === 0 && (
              <span className="tms-muted">Nothing — ready to approve</span>
            )}
            <ul className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>
              {gates.blocks.map((block) => <li key={block}>{block}</li>)}
            </ul>
            <ul className="text-xs tms-muted">
              {gates.warnings.map((warning) => <li key={warning.key}>{warning.message}</li>)}
            </ul>
          </>
        )
      },
    },
    {
      key: 'actions',
      header: '',
      render: (bill) => (
        <span className="flex justify-end gap-1 whitespace-nowrap">
          <TmsButton variant="ghost" size="sm" aria-label={`Approve bill ${bill.billNumber ?? bill.id}`} disabled={busy} onClick={() => onApprove(bill)}>Approve</TmsButton>
          <TmsButton variant="ghost" size="sm" aria-label={`Update carrier charges for bill ${bill.billNumber ?? bill.id}`} disabled={busy} onClick={() => onCharges(bill)}>Update charges</TmsButton>
          <TmsButton variant="ghost" size="sm" aria-label={`Void bill ${bill.billNumber ?? bill.id}`} disabled={busy} onClick={() => onVoid(bill)}>Void</TmsButton>
        </span>
      ),
    },
  ]

  return view<CarrierBillRecord>({
    banner,
    columns,
    rows: bills,
    rowKey: (bill) => bill.id,
    page: wholeList(bills.length),
    emptyText: 'No bill is waiting on review.',
  })
}

/* ── To be paid ──────────────────────────────────────────────────────────── */

function toBePaidView({
  errorBanner, bills, allBills, filters, showFilters, selected, asOf, busy,
  onToggleFilters, onFilters, onSelect, onPay, onPaySelected, onUnapprove,
}: {
  errorBanner: ReactNode
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
}): ListView {
  // One payment is one carrier's: a selection spanning two of them cannot be posted as
  // one row, and the button says so instead of failing in the dialog.
  const payCarrierId = selectionCarrierId(bills, selected)
  const carrierName = billCarrierOptions(allBills).find((c) => c.id === filters.carrierId)?.name ?? null
  const dueLabel: Record<string, string> = { OVERDUE: 'Overdue', WEEK: 'Due within 7 days', LATER: 'Later' }

  const columns: ColumnDef<CarrierBillRecord>[] = [
    {
      key: 'select',
      header: '',
      width: 36,
      render: (bill) => (
        <input
          type="checkbox"
          aria-label={`Select bill ${bill.billNumber ?? bill.id}`}
          checked={selected.includes(bill.id)}
          onChange={() => onSelect(
            selected.includes(bill.id) ? selected.filter((id) => id !== bill.id) : [...selected, bill.id],
          )}
        />
      ),
    },
    {
      key: 'bill',
      header: 'BILL',
      render: (bill) => (
        <>
          <Link to={`/tms/invoicing/payable/bills/${bill.id}`}>{bill.billNumber ?? bill.id}</Link>
          {bill.status === 'PARTIAL' && <> <TmsBadge tone="gray">{BILL_STATUS_LABEL.PARTIAL}</TmsBadge></>}
        </>
      ),
    },
    { key: 'carrier', header: 'CARRIER', render: (bill) => bill.carrierName || '—' },
    { key: 'due', header: 'DUE', render: (bill) => formatDay(bill.dueAt) },
    {
      key: 'age',
      header: 'AGE',
      render: (bill) => {
        const chip = agingChipFor(bill.dueAt, asOf)
        return <TmsBadge tone={chip.late ? 'red' : 'gray'}>{chip.label}</TmsBadge>
      },
    },
    { key: 'net', header: 'NET', render: (bill) => <span className={RIGHT}>{formatCents(bill.netCents)}</span> },
    { key: 'paid', header: 'PAID', render: (bill) => <span className={RIGHT}>{formatCents(bill.paidCents)}</span> },
    {
      key: 'balance',
      header: 'BALANCE',
      render: (bill) => <span className={`${RIGHT} font-medium`}>{formatCents(bill.balanceCents)}</span>,
    },
    { key: 'payee', header: 'PAYEE', render: (bill) => payeeLabel(bill) },
    {
      key: 'actions',
      header: '',
      render: (bill) => (
        <span className="flex justify-end gap-1 whitespace-nowrap">
          <TmsButton variant="ghost" size="sm" aria-label={`Pay bill ${bill.billNumber ?? bill.id}`} disabled={busy} onClick={() => onPay(bill)}>Pay</TmsButton>
          <TmsButton variant="ghost" size="sm" aria-label={`Unapprove bill ${bill.billNumber ?? bill.id}`} disabled={busy} onClick={() => onUnapprove(bill)}>Unapprove</TmsButton>
        </span>
      ),
    },
  ]

  return view<CarrierBillRecord>({
    actions: (
        <>
          <span className="text-sm tms-muted">
            {selected.length} selected ({formatCents(selectionBalanceCents(bills, selected))})
          </span>
          {selected.length > 0 && !payCarrierId && (
            <span className="text-xs tms-muted">One payment covers one carrier; narrow the selection.</span>
          )}
          <TmsButton
            variant="primary"
            aria-label="Pay selected bills"
            disabled={busy || selected.length === 0 || !payCarrierId}
            onClick={() => { if (payCarrierId) onPaySelected(payCarrierId) }}
          >
            Pay selected
          </TmsButton>
      </>
    ),
    filterChips: [
        { key: 'carrier', label: 'Carrier is', value: carrierName, onClick: onToggleFilters },
        { key: 'due', label: 'Due is', value: filters.due ? dueLabel[filters.due] : null, onClick: onToggleFilters },
        {
          key: 'payee',
          label: 'Payee is',
          value: filters.payeeKind ? AP_PAYEE_KIND_LABEL[filters.payeeKind] : null,
          onClick: onToggleFilters,
        },
    ],
    onAddFilter: onToggleFilters,
    banner: (
        <>
          {errorBanner}
          {showFilters && (
            <TmsCard title="Filters">
              <div className="tms-grid tms-grid-3">
                <TmsField label="Carrier">
                  <TmsSelect
                    aria-label="Filter carrier"
                    value={filters.carrierId}
                    onChange={(e) => onFilters({ ...filters, carrierId: e.target.value })}
                  >
                    <option value="">All</option>
                    {billCarrierOptions(allBills).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </TmsSelect>
                </TmsField>
                <TmsField label="Due">
                  <TmsSelect
                    aria-label="Filter due"
                    value={filters.due}
                    onChange={(e) => onFilters({ ...filters, due: e.target.value as ToBePaidFilters['due'] })}
                  >
                    <option value="">All</option>
                    <option value="OVERDUE">Overdue</option>
                    <option value="WEEK">Due within 7 days</option>
                    <option value="LATER">Later</option>
                  </TmsSelect>
                </TmsField>
                <TmsField label="Payee">
                  <TmsSelect
                    aria-label="Filter payee kind"
                    value={filters.payeeKind}
                    onChange={(e) => onFilters({ ...filters, payeeKind: e.target.value as ToBePaidFilters['payeeKind'] })}
                  >
                    <option value="">All</option>
                    <option value="CARRIER">{AP_PAYEE_KIND_LABEL.CARRIER}</option>
                    <option value="FACTOR">{AP_PAYEE_KIND_LABEL.FACTOR}</option>
                  </TmsSelect>
                </TmsField>
              </div>
            </TmsCard>
          )}
        </>
    ),
    columns,
    rows: bills,
    rowKey: (bill) => bill.id,
    page: wholeList(bills.length),
    emptyText: 'Nothing is approved and waiting in this view.',
    onClearFilters: () => onFilters(EMPTY_TO_BE_PAID_FILTERS),
  })
}

/* ── Paid ────────────────────────────────────────────────────────────────── */

function paidView({ banner, bills, months, month, loading, onMonth }: {
  banner: ReactNode
  bills: CarrierBillRecord[]
  months: string[]
  month: string
  loading: boolean
  onMonth: (ym: string) => void
}): ListView {
  const columns: ColumnDef<CarrierBillRecord>[] = [
    {
      key: 'bill',
      header: 'BILL',
      render: (bill) => <Link to={`/tms/invoicing/payable/bills/${bill.id}`}>{bill.billNumber ?? bill.id}</Link>,
    },
    { key: 'carrier', header: 'CARRIER', render: (bill) => bill.carrierName || '—' },
    { key: 'billDate', header: 'BILL DATE', render: (bill) => formatDay(bill.billDate) },
    { key: 'paid', header: 'PAID', render: (bill) => formatDay(bill.paidAt) },
    { key: 'payee', header: 'PAYEE', render: (bill) => payeeLabel(bill) },
    { key: 'net', header: 'NET', render: (bill) => <span className={RIGHT}>{formatCents(bill.netCents)}</span> },
    {
      key: 'credits',
      header: 'CREDITS',
      render: (bill) => <span className={RIGHT}>{bill.creditedCents ? formatCents(bill.creditedCents) : '—'}</span>,
    },
  ]

  return view<CarrierBillRecord>({
    actions: (
      <>
        <TmsSelect aria-label="Bill month" value={month} onChange={(e) => onMonth(e.target.value)}>
          {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
        </TmsSelect>
        {loading && <span className="text-sm tms-muted">Loading…</span>}
      </>
    ),
    banner,
    columns,
    rows: bills,
    rowKey: (bill) => bill.id,
    page: wholeList(bills.length),
    emptyText: `No carrier was paid off a ${monthLabel(month)} bill.`,
  })
}

/* ── Payments & credits ──────────────────────────────────────────────────── */

function paymentsView({
  banner, carriers, carrier, payments, openCents, unappliedCents, busy,
  onCarrier, onPay, onCredit, onRemittance, onReverse,
}: {
  banner: ReactNode
  carriers: CarrierRecord[]
  carrier: CarrierRecord | null
  payments: ApPaymentRecord[]
  openCents: number
  unappliedCents: number
  busy: boolean
  onCarrier: (id: string | null) => void
  onPay: (carrierId: string) => void
  onCredit: (carrierId: string) => void
  onRemittance: (payment: ApPaymentRecord) => void
  onReverse: (payment: ApPaymentRecord) => void
}): ListView {
  const columns: ColumnDef<ApPaymentRecord>[] = [
    { key: 'kind', header: 'KIND', render: (p) => AP_PAYMENT_KIND_LABEL[p.kind] },
    { key: 'date', header: 'DATE', render: (p) => formatDay(p.paidAt) },
    { key: 'method', header: 'METHOD', render: (p) => (p.method ? AP_PAYMENT_METHOD_LABEL[p.method] : '—') },
    { key: 'reference', header: 'REFERENCE', render: (p) => p.reference || '—' },
    { key: 'amount', header: 'AMOUNT', render: (p) => <span className={RIGHT}>{formatCents(p.amountCents)}</span> },
    { key: 'applied', header: 'APPLIED', render: (p) => <span className={RIGHT}>{formatCents(p.appliedCents)}</span> },
    { key: 'unapplied', header: 'UNAPPLIED', render: (p) => <span className={RIGHT}>{formatCents(p.unappliedCents)}</span> },
    {
      key: 'remittance',
      header: 'REMITTANCE',
      render: (p) => (
        p.remittanceSentAt
          ? `Sent ${formatDay(p.remittanceSentAt)}`
          : p.markedSentAt
            ? `Marked sent ${formatDay(p.markedSentAt)}`
            : <span className="tms-muted">Not sent</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (p) => (
        <span className="flex justify-end gap-1 whitespace-nowrap">
          {p.kind === 'PAYMENT' && (
            <TmsButton
              variant="ghost"
              size="sm"
              aria-label={`Send remittance for ${formatCents(p.amountCents)} paid ${formatDay(p.paidAt)}`}
              disabled={busy}
              onClick={() => onRemittance(p)}
            >
              Send remittance
            </TmsButton>
          )}
          {p.kind !== 'REVERSAL' && !p.reversedByPaymentId && (
            <TmsButton
              variant="ghost"
              size="sm"
              aria-label={`Reverse ${AP_PAYMENT_KIND_LABEL[p.kind].toLowerCase()} of ${formatCents(p.amountCents)}`}
              disabled={busy}
              onClick={() => onReverse(p)}
            >
              Reverse
            </TmsButton>
          )}
          {p.reversedByPaymentId && <span className="text-xs tms-muted">Reversed</span>}
        </span>
      ),
    },
  ]

  return view<ApPaymentRecord>({
    actions: (
      <>
        <TmsSelect
          aria-label="Choose carrier"
          value={carrier?.id ?? ''}
          onChange={(e) => onCarrier(e.target.value || null)}
        >
          <option value="">Choose a carrier…</option>
          {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </TmsSelect>
        {carrier && (
          <>
            <TmsBadge tone="gray">{formatCents(openCents)} open</TmsBadge>
            <TmsBadge tone="gray">{formatCents(unappliedCents)} credit held</TmsBadge>
            <TmsButton variant="primary" aria-label="Pay carrier" disabled={busy} onClick={() => onPay(carrier.id)}>Pay carrier</TmsButton>
            <TmsButton aria-label="New credit" disabled={busy} onClick={() => onCredit(carrier.id)}>New credit</TmsButton>
          </>
        )}
      </>
    ),
    banner,
    columns,
    rows: carrier ? payments : [],
    rowKey: (p) => p.id,
    page: wholeList(carrier ? payments.length : 0),
    emptyText: carrier ? `Nothing has been posted for ${carrier.name}.` : 'Choose a carrier to see their posted rows.',
  })
}

/* ── Aging ───────────────────────────────────────────────────────────────── */

function agingView({ errorBanner, aging, awaitingCents, awaitingCount, avgDaysToPay, paidMonthLabel, onCsv }: {
  errorBanner: ReactNode
  aging: AgingPartySummary
  awaitingCents: number
  awaitingCount: number
  avgDaysToPay: number | null
  paidMonthLabel: string
  onCsv: () => void
}): ListView {
  type Row = AgingPartySummary['byParty'][number]
  const columns: ColumnDef<Row>[] = [
    { key: 'carrier', header: 'CARRIER', render: (row) => row.partyName || row.partyId },
    ...AGING_BUCKETS.map((b) => ({
      key: b,
      header: AGING_BUCKET_LABEL[b].toUpperCase(),
      render: (row: Row) => <span className={RIGHT}>{formatCents(row.byBucket[b])}</span>,
    })),
    {
      key: 'total',
      header: 'TOTAL',
      render: (row) => <span className={`${RIGHT} font-medium`}>{formatCents(row.totalCents)}</span>,
    },
    { key: 'late', header: 'LATE', render: (row) => <span className={RIGHT}>{row.lateCount || '—'}</span> },
    { key: 'oldest', header: 'OLDEST', render: (row) => <span className={RIGHT}>{row.oldestDays ? `${row.oldestDays}d` : '—'}</span> },
  ]

  return view<Row>({
    actions: (
      <TmsButton aria-label="Download AP aging CSV" onClick={onCsv}>
        <Download size={14} /> CSV
      </TmsButton>
    ),
    banner: (
      <>
        {errorBanner}
        <AgingStrip
          labels={AP_STRIP_LABELS}
          openCents={aging.totalCents}
          lateCents={aging.lateCents}
          deliveredNotInvoicedCents={awaitingCents}
          deliveredNotInvoicedCount={awaitingCount}
          avgDaysToPay={avgDaysToPay}
          paidMonthLabel={paidMonthLabel}
        />
      </>
    ),
    columns,
    rows: aging.byParty,
    rowKey: (row) => row.partyId,
    page: wholeList(aging.byParty.length),
    emptyText: 'We owe nothing.',
  })
}
