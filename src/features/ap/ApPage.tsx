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
  TmsBadge, TmsButton, TmsCard, TmsField, TmsSelect, type TmsTabGroup,
} from '@/features/tms/kit'
import { ApChrome, ApDenseList, type ApColumn, type ApListConfig } from './ApDenseList'
import { useAuth } from '@/hooks/useAuth'
import { useApWorklist, type ApWorklistRow } from '@/hooks/useApWorklist'
import { useCarrierAp } from '@/hooks/useCarrierAp'
import { useCarriers } from '@/hooks/useCarriers'
import { useOpenBills } from '@/hooks/useOpenBills'
import { exportOutstandingPayables } from '@/lib/opsExports'
import {
  getShipmentDocumentUrl, getTmsSettings, graphqlErrorText, listBillsByMonth, reverseApPayment, unapproveBill, voidBill,
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
  selectionCarrierId, sharedProLabel, sharedProIndex, type ApTabKey, type SharedProIndex, type ToBePaidFilters,
} from './apViews'
import { ApCreditDialog } from './components/ApCreditDialog'
import { VerifyPaymentBadge } from './components/VerifyPaymentBadge'
import { isVerifyPaymentBill } from '@/lib/verifyPayment'
import { ApproveBillDialog } from './components/ApproveBillDialog'
import { PayCarrierDialog } from './components/PayCarrierDialog'
import { RecordBillDialog, type RecordBillPrefill } from './components/RecordBillDialog'
import { SendRemittanceDialog } from './components/SendRemittanceDialog'
import { UpdateCarrierChargesDialog } from './components/UpdateCarrierChargesDialog'
import type { ApInboxItemRecord } from '@/lib/apInbox/types'
import type { ApPaymentRecord, ApSettings, CarrierBillRecord, CarrierRecord } from '@/types/tms'
import { ApInboxDigest } from './inbox/ApInboxDigest'
import { CreateBillDialog } from './inbox/CreateBillDialog'
import { DismissItemDialog } from './inbox/DismissItemDialog'
import { LinkBillDialog } from './inbox/LinkBillDialog'
import { apInboxMarkCreated, apInboxRevert } from './inbox/apInboxClient'
import { INBOX_CHIPS, HISTORY_DAYS, type InboxChip } from './inbox/inboxModel'
import { InboxChips } from './inbox/InboxParts'
import { inboxView } from './inbox/inboxView'
import { useApInboxItems, useApInboxStatus } from './inbox/useApInbox'

/** The "Shared PRO · 2 carriers" badge, or nothing when the load has one carrier. */
function sharedProChip(shared: SharedProIndex, loadId: string): ReactNode {
  const label = sharedProLabel(shared, loadId)
  return label ? <> <TmsBadge tone="gray">{label}</TmsBadge></> : null
}

/** Which dialog is open, and the one thing it is open about. */
type ApDialog =
  | { kind: 'record'; loadCarrierId: string; prefill?: RecordBillPrefill; inboxItem?: ApInboxItemRecord }
  | { kind: 'inbox-link'; item: ApInboxItemRecord }
  | { kind: 'inbox-create'; item: ApInboxItemRecord }
  | { kind: 'inbox-dismiss'; item: ApInboxItemRecord }
  | { kind: 'approve'; bill: CarrierBillRecord }
  | { kind: 'charges'; loadCarrierId: string; shipmentId: string }
  | { kind: 'pay'; carrierId: string; billIds?: string[] }
  | { kind: 'credit'; carrierId: string }
  | { kind: 'remittance'; payment: ApPaymentRecord }
  | { kind: 'void'; bill: CarrierBillRecord }
  | { kind: 'unapprove'; bill: CarrierBillRecord }
  | { kind: 'reverse'; payment: ApPaymentRecord }

const RIGHT = 'block text-right tabular-nums'

/**
 * One view's half of the list page. Columns, rows and `rowKey` are built together by the
 * view that owns them, so the row type is erased here and the page renders them all.
 */
type ListView = ApListConfig<never>

function view<T>(config: ApListConfig<T>): ListView {
  return config as unknown as ListView
}

export function ApPage({ viewTabs }: { viewTabs?: TmsTabGroup } = {}) {
  // One clock for the whole page: the chips, the buckets and the CSV all answer as of the
  // same day, so a bill cannot read "Current" next to a 1–30 column it was counted in.
  const [asOf] = useState(() => chicagoDateStr(new Date()))

  const { isAdmin, user } = useAuth()
  const [tab, setTab] = useState<ApTabKey>('awaiting')
  const inboxStatus = useApInboxStatus()
  const [chip, setChip] = useState<InboxChip>('NEEDS_REVIEW')
  const [historySince] = useState(() => new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString())
  const inboxItems = useApInboxItems(
    INBOX_CHIPS.find((c) => c.key === chip)?.statuses ?? ['NEEDS_REVIEW'],
    chip === 'NEEDS_REVIEW' ? undefined : historySince,
  )
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
  const [verifyOnlyPaid, setVerifyOnlyPaid] = useState(false)
  const settledShown = useMemo(() => (verifyOnlyPaid ? settled.filter(isVerifyPaymentBill) : settled), [settled, verifyOnlyPaid])
  const awaitingTotals = useMemo(() => awaitingInvoiceTotals(awaiting.rows), [awaiting.rows])
  // One bill per carrier per load: a load with several carriers shows up as several rows on
  // one PRO, and each row says so.
  const shared = useMemo(
    () => sharedProIndex([...awaiting.rows, ...inReview.rows], [...open.bills, ...monthBills]),
    [awaiting.rows, inReview.rows, open.bills, monthBills],
  )

  const refreshAll = () =>
    Promise.all([
      awaiting.refresh(), inReview.refresh(), open.refresh(), carrierAp.refresh(), loadMonth(),
      inboxItems.refresh(), inboxStatus.refresh(),
    ]).then(() => undefined)

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
    inbox: inboxStatus.status?.openCount ?? 0,
  }

  const reviewNow = () => {
    void inboxStatus.syncNow().then((failure) => {
      if (failure) toast.error(failure)
      void inboxItems.refresh()
      void open.refresh()
    })
  }

  const openInboxFile = (file: { key: string }) => {
    getShipmentDocumentUrl(file.key)
      .then((url) => window.open(url, '_blank', 'noopener'))
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not open the file'))
  }

  const undoInboxItem = (item: ApInboxItemRecord) => {
    setBusy(true)
    apInboxRevert(item.id)
      .then(() => { toast.success('Bill restored to its earlier values'); void refreshAll() })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not undo'))
      .finally(() => setBusy(false))
  }

  // The Record-bill dialog finished for a queued e-mail: close the item with the new bill's id.
  const inboxRecorded = (item: ApInboxItemRecord | undefined, billId?: string) => {
    if (item && billId) {
      apInboxMarkCreated(item.id, billId)
        .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'The bill was recorded but the e-mail could not be closed'))
        .finally(() => void refreshAll())
    }
    toast.message('Accept the filed invoice under Documents review to clear the paperwork gate')
    closeAndRefresh()
  }

  const error = awaiting.error ?? inReview.error ?? open.error ?? carrierAp.error
  const inboxBanner = (
    <>
      <InboxChips active={chip} onSelect={setChip} />
      {inboxItems.error && <p style={{ color: 'var(--tms-badge-red)' }} className="text-sm">{inboxItems.error}</p>}
    </>
  )

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
      shared,
      busy,
      onRecord: (row) => setDialog({ kind: 'record', loadCarrierId: row.loadCarrierId }),
    })
    : tab === 'review' ? reviewView({
      banner: errorBanner,
      bills: reviewBills,
      rows: reviewRows,
      shared,
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
      shared,
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
      bills: settledShown,
      verifyOnly: verifyOnlyPaid,
      verifyCount: settled.filter(isVerifyPaymentBill).length,
      onVerifyOnly: setVerifyOnlyPaid,
      shared,
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
    : tab === 'inbox' ? view<ApInboxItemRecord>(inboxView({
      banner: inboxBanner,
      rows: inboxItems.items,
      loading: inboxItems.loading,
      busy,
      onLink: (item) => setDialog({ kind: 'inbox-link', item }),
      onCreate: (item) => setDialog({ kind: 'inbox-create', item }),
      onDismiss: (item) => setDialog({ kind: 'inbox-dismiss', item }),
      onUndo: undoInboxItem,
      onOpenFile: openInboxFile,
    }))
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
      <ApInboxDigest
        status={inboxStatus.status}
        syncing={inboxStatus.syncing}
        progress={inboxStatus.progress}
        isAdmin={isAdmin}
        onReviewNow={reviewNow}
        onOpenQueue={() => { setChip('NEEDS_REVIEW'); setTab('inbox') }}
      />
      <div className="tms-page">
        <ApChrome
          title={chrome.title}
          viewTabs={chrome.viewTabs}
          quickTabs={chrome.quickTabs}
          actions={(
            <button type="button" className="tms-btn tms-btn-secondary tms-btn-sm" data-testid="export-outstanding-payables" title="Every open bill with every field"
              onClick={() => { exportOutstandingPayables().then((n) => toast.success(`Exported ${n} outstanding payables`)).catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not export')) }}>
              <Download size={14} aria-hidden="true" /> Export outstanding
            </button>
          )}
        />
        {/* Keyed by grid so each view keeps its own saved columns, filters and sort. */}
        <ApDenseList<never> key={current.gridId} config={current} email={user?.email} onRefresh={chrome.onRefresh} />
      </div>

      {dialog?.kind === 'record' && (
        <RecordBillDialog
          open
          loadCarrierId={dialog.loadCarrierId}
          prefill={dialog.prefill}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={(billId) => (dialog.inboxItem ? inboxRecorded(dialog.inboxItem, billId) : closeAndRefresh())}
        />
      )}
      {dialog?.kind === 'inbox-link' && (
        <LinkBillDialog
          item={dialog.item}
          bills={open.bills}
          assignments={awaiting.rows}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'inbox-create' && (
        <CreateBillDialog
          item={dialog.item}
          assignments={awaiting.rows}
          onOpenChange={(o) => { if (!o) setDialog(null) }}
          onRecord={(loadCarrierId) => setDialog({
            kind: 'record',
            loadCarrierId,
            inboxItem: dialog.item,
            prefill: {
              billNumber: dialog.item.extraction.invoiceNumber,
              billDate: dialog.item.extraction.invoiceDate,
              dueAt: dialog.item.extraction.dueDate,
              billedCents: dialog.item.extraction.amountCents,
            },
          })}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'inbox-dismiss' && (
        <DismissItemDialog
          item={dialog.item}
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

/* ── Column helpers ──────────────────────────────────────────────────────── */

/** A money column: integer cents drawn right-aligned, sorted and range-filtered by the cents themselves. */
function moneyCol<T>(
  key: string,
  header: string,
  centsOf: (row: T) => number,
  render?: (row: T) => ReactNode,
  empty?: (row: T) => boolean,
): ApColumn<T> {
  return {
    key,
    header,
    align: 'right',
    text: (row) => (empty?.(row) ? '—' : formatCents(centsOf(row))),
    sortValue: centsOf,
    filter: 'number',
    numberOf: (row) => centsOf(row) / 100,
    numberUnit: '$',
    render: render ?? ((row) => <span className={RIGHT}>{empty?.(row) ? '—' : formatCents(centsOf(row))}</span>),
  }
}

/** A date column: shown as "Oct 3, 2026", sorted by the ISO value, filtered by calendar day. */
function dayCol<T>(key: string, header: string, valueOf: (row: T) => string | null | undefined): ApColumn<T> {
  return {
    key,
    header,
    text: (row) => formatDay(valueOf(row)),
    sortValue: (row) => valueOf(row) ?? '',
    filter: 'date',
    dateOf: (row) => valueOf(row) ?? null,
    render: (row) => formatDay(valueOf(row)),
  }
}

/** A text column whose header filter offers the distinct values. */
function facetCol<T>(
  key: string,
  header: string,
  textOf: (row: T) => string,
  render?: (row: T) => ReactNode,
  extra: Partial<ApColumn<T>> = {},
): ApColumn<T> {
  return {
    key,
    header,
    text: textOf,
    filter: 'multi',
    render: render ?? textOf,
    ...extra,
  }
}

const sumCents = <T,>(rows: T[], pick: (row: T) => number) => rows.reduce((sum, row) => sum + pick(row), 0)

const ACTIONS = { filter: false, sortable: false, fixed: true } as const

/* ── Awaiting invoice ────────────────────────────────────────────────────── */

function awaitingView({ banner, rows, shared, busy, onRecord }: {
  banner: ReactNode
  rows: ApWorklistRow[]
  shared: SharedProIndex
  busy: boolean
  onRecord: (row: ApWorklistRow) => void
}): ListView {
  const carrierText = (row: ApWorklistRow) => (isOwnFleet(row) ? row.assignment.driverName ?? 'Own asset' : row.carrierName || '—')
  const columns: ApColumn<ApWorklistRow>[] = [
    {
      key: 'shipment',
      header: 'SHIPMENT',
      text: (row) => row.shipmentNumber ?? row.shipmentId,
      render: (row) => <Link to={`/tms/shipments/${row.shipmentId}`}>{row.shipmentNumber ?? row.shipmentId}</Link>,
    },
    // The assignment carries the load's id, not its number; the shipment link is the readable handle.
    { key: 'load', header: 'LOAD', text: (row) => row.loadId, render: (row) => <span className="text-xs tms-muted">{row.loadId}</span> },
    facetCol('carrier', 'CARRIER', carrierText, (row) => {
      const ownFleet = isOwnFleet(row)
      const quickPay = quickPayLabel(row.assignment)
      return (
        <>
          {carrierText(row)}
          {quickPay && !ownFleet && <> <TmsBadge tone="gray">{quickPay}</TmsBadge></>}
          {sharedProChip(shared, row.loadId)}
        </>
      )
    }, { extraPx: 90 }),
    {
      ...dayCol<ApWorklistRow>('delivered', 'DELIVERED', (row) => row.deliveredAt),
      text: (row) => (row.deliveredAt ? formatDay(row.deliveredAt) : 'Not delivered'),
      render: (row) => (row.deliveredAt ? formatDay(row.deliveredAt) : 'Not delivered'),
    },
    facetCol('rateCon', 'RATE CON', (row) => (isOwnFleet(row) ? '—' : row.rateConSigned ? 'Signed' : 'Not signed'), (row) => (
      isOwnFleet(row)
        ? <span className="tms-muted">—</span>
        : row.rateConSigned
          ? <span>✓</span>
          : <span style={{ color: 'var(--tms-badge-red)' }}>✗ not signed</span>
    )),
    facetCol('paperwork', 'PAPERWORK', (row) => (isOwnFleet(row) ? '—' : row.docsReady ? 'Ready' : row.docsMissing.join(', ') || 'Missing'), (row) => (
      isOwnFleet(row)
        ? <span className="tms-muted">—</span>
        : row.docsReady
          ? <span>✓</span>
          : <span style={{ color: 'var(--tms-badge-red)' }}>{row.docsMissing.join(', ') || 'Missing'}</span>
    ), { filter: 'text' }),
    moneyCol<ApWorklistRow>('cost', 'COST', (row) => row.costCents),
    {
      key: 'record',
      header: '',
      text: () => '',
      width: 330,
      ...ACTIONS,
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
            aria-label={`Record bill for ${row.shipmentNumber ?? row.loadCarrierId}${sharedProLabel(shared, row.loadId) ? ` — ${row.carrierName}` : ''}`}
            disabled={busy}
            onClick={() => onRecord(row)}
          >
            Record bill
          </TmsButton>
        )
      ),
    },
  ]

  const billable = rows.filter((row) => !isOwnFleet(row))
  return view<ApWorklistRow>({
    gridId: 'ap-awaiting',
    banner,
    columns,
    rows,
    rowKey: (row) => row.loadCarrierId,
    emptyText: 'No carrier owes us an invoice.',
    kpis: [
      { label: 'Awaiting', value: rows.length },
      { label: 'To bill', value: billable.length },
      { label: 'Agreed cost', value: formatCents(sumCents(rows, (row) => row.costCents)) },
      { label: 'Missing paperwork', value: billable.filter((row) => !row.docsReady).length, tone: 'warn' },
    ],
  })
}

/* ── In review ───────────────────────────────────────────────────────────── */

function reviewView({
  banner, bills, rows, shared, carriersById, settings, isAdmin, busy, onApprove, onCharges, onVoid,
}: {
  banner: ReactNode
  bills: CarrierBillRecord[]
  rows: Map<string, ApWorklistRow>
  shared: SharedProIndex
  carriersById: Map<string, CarrierRecord>
  settings: Pick<ApSettings, 'apRequireSignedRateCon'> | null
  isAdmin: boolean
  busy: boolean
  onApprove: (bill: CarrierBillRecord) => void
  onCharges: (bill: CarrierBillRecord) => void
  onVoid: (bill: CarrierBillRecord) => void
}): ListView {
  const gatesOf = (bill: CarrierBillRecord) => billGates({
    bill,
    row: rows.get(bill.loadCarrierId),
    carrier: carriersById.get(bill.carrierId) ?? null,
    settings,
    isAdmin,
  })
  const columns: ApColumn<CarrierBillRecord>[] = [
    {
      key: 'bill',
      header: 'BILL',
      text: (bill) => bill.billNumber ?? bill.id,
      extraPx: 40,
      render: (bill) => (
        <><Link to={`/tms/invoicing/payable/bills/${bill.id}`}>{bill.billNumber ?? bill.id}</Link><VerifyPaymentBadge bill={bill} /></>
      ),
    },
    facetCol('carrier', 'CARRIER', (bill) => bill.carrierName || '—', (bill) => <>{bill.carrierName || '—'}{sharedProChip(shared, bill.loadId)}</>, { extraPx: 90 }),
    dayCol<CarrierBillRecord>('billDate', 'BILL DATE', (bill) => bill.billDate),
    dayCol<CarrierBillRecord>('due', 'DUE', (bill) => bill.dueAt),
    moneyCol<CarrierBillRecord>('gross', 'GROSS', (bill) => bill.grossCents, (bill) => (
      <span className={RIGHT}>
        {formatCents(bill.grossCents)}
        {bill.varianceCents !== 0 && (
          <> <TmsBadge tone="red">{formatCents(bill.varianceCents)} variance</TmsBadge></>
        )}
      </span>
    )),
    moneyCol<CarrierBillRecord>('fee', 'FEE', (bill) => bill.quickPayFeeCents ?? 0, undefined, (bill) => !bill.quickPayFeeCents),
    moneyCol<CarrierBillRecord>('net', 'NET', (bill) => bill.netCents, (bill) => <span className={`${RIGHT} font-medium`}>{formatCents(bill.netCents)}</span>),
    {
      key: 'gates',
      header: 'STANDING IN THE WAY',
      text: (bill) => {
        const gates = gatesOf(bill)
        const all = [...gates.blocks, ...gates.warnings.map((w) => w.message)]
        return all.length === 0 ? 'Nothing — ready to approve' : all.join(' · ')
      },
      extraPx: 40,
      render: (bill) => {
        const gates = gatesOf(bill)
        return (
          <>
            {gates.blocks.length === 0 && gates.warnings.length === 0 && (
              <span className="tms-muted">Nothing — ready to approve</span>
            )}
            {gates.blocks.map((block) => (
              <span key={block} className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{block}{' '}</span>
            ))}
            {gates.warnings.map((warning) => (
              <span key={warning.key} className="text-xs tms-muted">{warning.message}{' '}</span>
            ))}
          </>
        )
      },
    },
    {
      key: 'actions',
      header: '',
      text: () => '',
      width: 300,
      ...ACTIONS,
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
    gridId: 'ap-review',
    banner,
    columns,
    rows: bills,
    rowKey: (bill) => bill.id,
    emptyText: 'No bill is waiting on review.',
    kpis: [
      { label: 'In review', value: bills.length },
      { label: 'Net', value: formatCents(sumCents(bills, (bill) => bill.netCents)) },
      { label: 'With variance', value: bills.filter((bill) => bill.varianceCents !== 0).length, tone: 'bad' },
    ],
  })
}

/* ── To be paid ──────────────────────────────────────────────────────────── */

function toBePaidView({
  errorBanner, bills, allBills, shared, filters, showFilters, selected, asOf, busy,
  onToggleFilters, onFilters, onSelect, onPay, onPaySelected, onUnapprove,
}: {
  errorBanner: ReactNode
  bills: CarrierBillRecord[]
  allBills: CarrierBillRecord[]
  shared: SharedProIndex
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

  const columns: ApColumn<CarrierBillRecord>[] = [
    {
      key: 'select',
      header: '',
      text: () => '',
      width: 40,
      filter: false,
      sortable: false,
      fixed: true,
      render: (bill) => (
        <input
          type="checkbox"
          aria-label={`Select bill ${bill.billNumber ?? bill.id}`}
          checked={selected.includes(bill.id)}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onSelect(
            selected.includes(bill.id) ? selected.filter((id) => id !== bill.id) : [...selected, bill.id],
          )}
        />
      ),
    },
    {
      key: 'bill',
      header: 'BILL',
      text: (bill) => bill.billNumber ?? bill.id,
      extraPx: 90,
      render: (bill) => (
        <>
          <Link to={`/tms/invoicing/payable/bills/${bill.id}`}>{bill.billNumber ?? bill.id}</Link>
          {bill.status === 'PARTIAL' && <> <TmsBadge tone="gray">{BILL_STATUS_LABEL.PARTIAL}</TmsBadge></>}
          <VerifyPaymentBadge bill={bill} />
        </>
      ),
    },
    facetCol('carrier', 'CARRIER', (bill) => bill.carrierName || '—', (bill) => <>{bill.carrierName || '—'}{sharedProChip(shared, bill.loadId)}</>, { extraPx: 90 }),
    dayCol<CarrierBillRecord>('due', 'DUE', (bill) => bill.dueAt),
    {
      key: 'age',
      header: 'AGE',
      text: (bill) => agingChipFor(bill.dueAt, asOf).label,
      sortValue: (bill) => agingChipFor(bill.dueAt, asOf).days,
      filter: 'multi',
      extraPx: 24,
      render: (bill) => {
        const chip = agingChipFor(bill.dueAt, asOf)
        return <TmsBadge tone={chip.late ? 'red' : 'gray'}>{chip.label}</TmsBadge>
      },
    },
    moneyCol<CarrierBillRecord>('net', 'NET', (bill) => bill.netCents),
    moneyCol<CarrierBillRecord>('paid', 'PAID', (bill) => bill.paidCents),
    moneyCol<CarrierBillRecord>('balance', 'BALANCE', (bill) => bill.balanceCents, (bill) => (
      <span className={`${RIGHT} font-medium`}>{formatCents(bill.balanceCents)}</span>
    )),
    facetCol('payee', 'PAYEE', payeeLabel),
    {
      key: 'actions',
      header: '',
      text: () => '',
      width: 190,
      ...ACTIONS,
      render: (bill) => (
        <span className="flex justify-end gap-1 whitespace-nowrap">
          <TmsButton variant="ghost" size="sm" aria-label={`Pay bill ${bill.billNumber ?? bill.id}`} disabled={busy} onClick={() => onPay(bill)}>Pay</TmsButton>
          <TmsButton variant="ghost" size="sm" aria-label={`Unapprove bill ${bill.billNumber ?? bill.id}`} disabled={busy} onClick={() => onUnapprove(bill)}>Unapprove</TmsButton>
        </span>
      ),
    },
  ]

  const overdue = bills.filter((bill) => agingChipFor(bill.dueAt, asOf).late)
  return view<CarrierBillRecord>({
    gridId: 'ap-to-pay',
    kpis: [
      { label: 'Bills to pay', value: bills.length },
      { label: 'Balance', value: formatCents(sumCents(bills, (bill) => bill.balanceCents)) },
      { label: 'Overdue', value: overdue.length, tone: 'bad' },
      { label: 'Overdue balance', value: formatCents(sumCents(overdue, (bill) => bill.balanceCents)), tone: 'bad' },
    ],
    actions: (
      <>
        <span className="text-sm tms-muted">
          {selected.length} selected ({formatCents(selectionBalanceCents(bills, selected))})
        </span>
        {selected.length > 0 && !payCarrierId && (
          <span className="text-xs tms-muted">One payment covers one carrier; narrow the selection.</span>
        )}
        <TmsButton
          size="sm"
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
      {
        key: 'verifyPayment',
        label: 'Verify payment',
        value: filters.verifyPayment ? 'only' : null,
        onClick: () => onFilters({ ...filters, verifyPayment: !filters.verifyPayment }),
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
              <TmsField label="Verify payment">
                <TmsSelect
                  aria-label="Filter verify payment"
                  value={filters.verifyPayment ? 'only' : ''}
                  onChange={(e) => onFilters({ ...filters, verifyPayment: e.target.value === 'only' })}
                >
                  <option value="">All bills</option>
                  <option value="only">Verify payment only ({allBills.filter(isVerifyPaymentBill).length})</option>
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
    emptyText: 'Nothing is approved and waiting in this view.',
    onClearFilters: () => onFilters(EMPTY_TO_BE_PAID_FILTERS),
  })
}

/* ── Paid ────────────────────────────────────────────────────────────────── */

function paidView({ banner, bills, shared, months, month, loading, onMonth, verifyOnly, verifyCount, onVerifyOnly }: {
  banner: ReactNode
  bills: CarrierBillRecord[]
  shared: SharedProIndex
  months: string[]
  month: string
  loading: boolean
  onMonth: (ym: string) => void
  verifyOnly: boolean
  verifyCount: number
  onVerifyOnly: (on: boolean) => void
}): ListView {
  const columns: ApColumn<CarrierBillRecord>[] = [
    {
      key: 'bill',
      header: 'BILL',
      text: (bill) => bill.billNumber ?? bill.id,
      extraPx: 40,
      render: (bill) => <><Link to={`/tms/invoicing/payable/bills/${bill.id}`}>{bill.billNumber ?? bill.id}</Link><VerifyPaymentBadge bill={bill} /></>,
    },
    facetCol('carrier', 'CARRIER', (bill) => bill.carrierName || '—', (bill) => <>{bill.carrierName || '—'}{sharedProChip(shared, bill.loadId)}</>, { extraPx: 90 }),
    dayCol<CarrierBillRecord>('billDate', 'BILL DATE', (bill) => bill.billDate),
    dayCol<CarrierBillRecord>('paid', 'PAID', (bill) => bill.paidAt),
    facetCol('payee', 'PAYEE', payeeLabel),
    moneyCol<CarrierBillRecord>('net', 'NET', (bill) => bill.netCents),
    moneyCol<CarrierBillRecord>('credits', 'CREDITS', (bill) => bill.creditedCents ?? 0, undefined, (bill) => !bill.creditedCents),
  ]

  return view<CarrierBillRecord>({
    gridId: 'ap-paid',
    kpis: [
      { label: `Paid in ${monthLabel(month)}`, value: bills.length },
      { label: 'Net paid', value: formatCents(sumCents(bills, (bill) => bill.netCents)) },
      { label: 'Verify payment', value: verifyCount, tone: 'warn' },
    ],
    actions: (
      <>
        <TmsSelect aria-label="Bill month" value={month} onChange={(e) => onMonth(e.target.value)}>
          {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
        </TmsSelect>
        <TmsButton
          size="sm"
          variant={verifyOnly ? 'primary' : 'secondary'}
          aria-pressed={verifyOnly}
          onClick={() => onVerifyOnly(!verifyOnly)}
        >
          Verify payment ({verifyCount})
        </TmsButton>
        {loading && <span className="text-sm tms-muted">Loading…</span>}
      </>
    ),
    banner,
    columns,
    rows: bills,
    rowKey: (bill) => bill.id,
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
  const remittanceText = (p: ApPaymentRecord) => (
    p.remittanceSentAt
      ? `Sent ${formatDay(p.remittanceSentAt)}`
      : p.markedSentAt
        ? `Marked sent ${formatDay(p.markedSentAt)}`
        : 'Not sent'
  )
  const columns: ApColumn<ApPaymentRecord>[] = [
    facetCol('kind', 'KIND', (p) => AP_PAYMENT_KIND_LABEL[p.kind]),
    dayCol<ApPaymentRecord>('date', 'DATE', (p) => p.paidAt),
    facetCol('method', 'METHOD', (p) => (p.method ? AP_PAYMENT_METHOD_LABEL[p.method] : '—')),
    { key: 'reference', header: 'REFERENCE', text: (p) => p.reference || '—', render: (p) => p.reference || '—' },
    moneyCol<ApPaymentRecord>('amount', 'AMOUNT', (p) => p.amountCents),
    moneyCol<ApPaymentRecord>('applied', 'APPLIED', (p) => p.appliedCents),
    moneyCol<ApPaymentRecord>('unapplied', 'UNAPPLIED', (p) => p.unappliedCents),
    facetCol('remittance', 'REMITTANCE', remittanceText, (p) => (
      p.remittanceSentAt || p.markedSentAt ? remittanceText(p) : <span className="tms-muted">Not sent</span>
    ), { filter: 'text' }),
    {
      key: 'actions',
      header: '',
      text: () => '',
      width: 270,
      ...ACTIONS,
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
    gridId: 'ap-payments',
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
            <TmsButton size="sm" variant="primary" aria-label="Pay carrier" disabled={busy} onClick={() => onPay(carrier.id)}>Pay carrier</TmsButton>
            <TmsButton size="sm" aria-label="New credit" disabled={busy} onClick={() => onCredit(carrier.id)}>New credit</TmsButton>
          </>
        )}
      </>
    ),
    banner,
    columns,
    rows: carrier ? payments : [],
    rowKey: (p) => p.id,
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
  const columns: ApColumn<Row>[] = [
    { key: 'carrier', header: 'CARRIER', text: (row) => row.partyName || row.partyId, render: (row) => row.partyName || row.partyId },
    ...AGING_BUCKETS.map((b) => moneyCol<Row>(b, AGING_BUCKET_LABEL[b].toUpperCase(), (row) => row.byBucket[b])),
    moneyCol<Row>('total', 'TOTAL', (row) => row.totalCents, (row) => (
      <span className={`${RIGHT} font-medium`}>{formatCents(row.totalCents)}</span>
    )),
    {
      key: 'late',
      header: 'LATE',
      align: 'right',
      text: (row) => String(row.lateCount || '—'),
      sortValue: (row) => row.lateCount,
      filter: 'number',
      numberOf: (row) => row.lateCount,
      render: (row) => <span className={RIGHT}>{row.lateCount || '—'}</span>,
    },
    {
      key: 'oldest',
      header: 'OLDEST',
      align: 'right',
      text: (row) => (row.oldestDays ? `${row.oldestDays}d` : '—'),
      sortValue: (row) => row.oldestDays ?? 0,
      filter: 'number',
      numberOf: (row) => row.oldestDays ?? 0,
      numberUnit: 'days',
      render: (row) => <span className={RIGHT}>{row.oldestDays ? `${row.oldestDays}d` : '—'}</span>,
    },
  ]

  return view<Row>({
    gridId: 'ap-aging',
    actions: (
      <TmsButton size="sm" aria-label="Download AP aging CSV" onClick={onCsv}>
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
    emptyText: 'We owe nothing.',
  })
}
