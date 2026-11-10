/**
 * The receivable half of `/tms/invoicing` (spec §3.6, §6.6; `TMS_DESIGN` §4.12).
 *
 * Six views that follow one shipment's money from delivered to banked: what is waiting on
 * paperwork, what is ready to bill, what is owed, what was collected, every cash row, and
 * the aging behind all of it. Every number on the page is integer cents formatted once,
 * by `formatCents`; the deciding lives in `arViews.ts` and `@/lib/arAging`.
 *
 * It renders as one MVMNT list page: the Receivable/Payable view tabs come from
 * `InvoicingPage`, the AR ladder is the status quick-tab strip, and each view swaps the
 * columns under it.
 *
 * On dev, SES is denied: an invoice e-mail comes back NOT_SENT with the refusal and a
 * signed download. The page reports exactly that and never claims a send that did not
 * happen — a false "sent" here is a customer who never got their bill.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Download, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { Eye, Plus, RefreshCw } from 'lucide-react'
import {
  TmsBadge, TmsButton, TmsCard, TmsField, TmsFilterChip, TmsSelect, TmsTabs,
  type TmsTabGroup,
} from '@/features/tms/kit'
import type { DenseColumn } from '@/features/tms/grid/denseGridModel'
import { ArDenseTable, type ArGrid } from './components/ArDenseTable'
import { useArWorklist, type ArWorklistRow } from '@/hooks/useArWorklist'
import { useCustomerAr } from '@/hooks/useCustomerAr'
import { useOpenInvoices } from '@/hooks/useOpenInvoices'
import { useDirectory } from '@/hooks/useDirectory'
import { useFactoringItems } from '@/hooks/useFactoringItems'
import {
  batchEmailInvoices, batchGenerateInvoices, graphqlErrorText, listInvoicesByMonth, reversePayment, voidInvoice,
} from '@/lib/apiClient'
import {
  AGING_BUCKETS, AGING_BUCKET_LABEL, agingCsv, avgDaysToInvoice, avgDaysToPay, deliveredNotInvoiced,
  type AgingSummary,
} from '@/lib/arAging'
import { chicagoDateStr } from '@/lib/date'
import { saveBlob } from '@/lib/download'
import { formatCents } from '@/lib/invoiceBuild'
import { otrStatusLabel } from '@/lib/otrInvoiceStatus'
import { AgingStrip } from './AgingStrip'
import {
  AR_PAYMENT_KIND_LABEL, AR_PAYMENT_METHOD_LABEL, BATCH_GENERATE_LIMIT, EMPTY_UNPAID_FILTERS,
  agingChipFor, applyUnpaidFilters, billToLabel, formatDay, invoiceCustomerOptions, lastThreeMonths, monthLabel,
  type ArTabKey, type UnpaidFilters,
} from './arViews'
import { CreditMemoDialog } from './components/CreditMemoDialog'
import { EmailInvoiceDialog } from './components/EmailInvoiceDialog'
import { REVIEW_BILLING_LABEL, needsBillingReview, reviewBillingNote } from '@/lib/reviewBilling'
import { GenerateInvoiceDialog } from './components/GenerateInvoiceDialog'
import { ReasonDialog } from './components/ReasonDialog'
import { ReceivePaymentDialog } from './components/ReceivePaymentDialog'
import { SendToFactorDialog } from './components/SendToFactorDialog'
import { useBillingGrant, BILLING_GRANT_MESSAGE } from './useBillingGrant'
import { useReadyForBilling, type ReadyRow } from './components/useReadyForBilling'
import { ReadyForBillingReviewCell } from './components/ReadyForBillingReviewCell'
import type { FactoringItem } from '@/types'
import type { ArPaymentRecord, CustomerRecord, InvoiceRecord, ShipmentRecord } from '@/types/tms'

/** Which dialog is open, and the one thing it is open about. Mount is the `open` flag. */
type ArDialog =
  | { kind: 'generate'; orderId: string; shipmentNumber: string | null }
  | { kind: 'email'; invoiceId: string }
  | { kind: 'payment'; customerId: string; customerName: string; invoiceId?: string }
  | { kind: 'credit'; customerId: string; customerName: string }
  | { kind: 'factor'; invoiceId: string }
  | { kind: 'void'; invoice: InvoiceRecord }
  | { kind: 'reverse'; payment: ArPaymentRecord }

/** One shipment the batch would not bill, and exactly what the release gate said. */
interface BatchRefusal {
  orderId: string
  shipmentNumber: string
  reasons: string[]
}

/**
 * One view's half of the page: the head actions, the banner above the table, the filter
 * chips and the grid itself. Columns, rows and `rowKey` are built together by the view that
 * owns them, so the row type is erased here and the page renders them all.
 */
interface ListView {
  actions?: ReactNode
  banner?: ReactNode
  filterChips?: Array<{ key: string; label: string; value?: string | null; onClick?: () => void }>
  onAddFilter?: () => void
  grid: ArGrid<never>
}

function view<T>(config: Omit<ListView, 'grid'> & { grid: ArGrid<T> }): ListView {
  return config as unknown as ListView
}

type ExtendedArTabKey = ArTabKey | 'ready-for-billing'

export function ArPage({ viewTabs }: { viewTabs?: TmsTabGroup } = {}) {
  // One clock for the whole page: the chips, the buckets and the CSV all answer as of the
  // same day, so a row cannot read "Current" next to a 1–30 column it was counted in.
  const [asOf] = useState(() => chicagoDateStr(new Date()))

  const [tab, setTab] = useState<ExtendedArTabKey>('to-invoice')
  const [dialog, setDialog] = useState<ArDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const canRelease = useBillingGrant()

  const unbilled = useArWorklist('UNBILLED')
  const docsNeeded = useArWorklist('DOCS_NEEDED')
  // Invoiced-but-unpaid shipments carry the ones the open invoices were raised against;
  // that pairing is the only way to measure delivery → invoice.
  const invoiced = useArWorklist('UNPAID')
  const open = useOpenInvoices()
  const { customers } = useDirectory({ locations: false })
  const { items: factoringItems } = useFactoringItems()

  const [selected, setSelected] = useState<string[]>([])
  /** What the last batch generated, so "Batch e-mail" bills exactly those invoices. */
  const [justGenerated, setJustGenerated] = useState<string[]>([])
  /** What the last batch refused, with the release gate's own sentences. */
  const [refusals, setRefusals] = useState<BatchRefusal[]>([])

  const [unpaidFilters, setUnpaidFilters] = useState<UnpaidFilters>(EMPTY_UNPAID_FILTERS)
  const [showFilters, setShowFilters] = useState(false)

  const months = useMemo(() => lastThreeMonths(asOf), [asOf])
  const [month, setMonth] = useState(() => months[0])
  const [paidInvoices, setPaidInvoices] = useState<InvoiceRecord[]>([])
  const [paidLoading, setPaidLoading] = useState(true)

  const [arCustomerId, setArCustomerId] = useState<string | null>(null)
  const customerAr = useCustomerAr(arCustomerId)

  // No synchronous setState in the effect (react-hooks/set-state-in-effect): every write
  // happens in the promise chain, and the month picker owns its own spinner.
  const loadMonth = useCallback(() =>
    listInvoicesByMonth(month)
      .then((rows) => setPaidInvoices(rows))
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load that month'))
      .finally(() => setPaidLoading(false)),
  [month])
  useEffect(() => { loadMonth() }, [loadMonth])

  const customersById = useMemo(() => {
    const map = new Map<string, CustomerRecord>()
    for (const c of customers) map.set(c.id, c)
    return map
  }, [customers])

  const factorByItemId = useMemo(() => {
    const map = new Map<string, FactoringItem>()
    for (const item of factoringItems) map.set(item.id, item)
    return map
  }, [factoringItems])

  const unpaidRows = useMemo(
    () => applyUnpaidFilters(open.invoices, unpaidFilters, asOf),
    [open.invoices, unpaidFilters, asOf],
  )

  /**
   * A DOCS_NEEDED shipment whose freight has not moved yet is not a paperwork problem —
   * nobody can upload a POD for it. The view is the chase list: delivered, or a customer
   * that bills on pickup.
   */
  const docsNeededRows = useMemo(
    () => docsNeeded.rows.filter((r) => r.deliveredAt || r.shipment?.status === 'DELIVERED' || r.order.invoiceEarly),
    [docsNeeded.rows],
  )
  // "Review billing": pre-cutover shipments parked in Docs needed. Not narrowed by delivery:
  // an imported shipment with no delivery stamp is exactly the one nobody will chase.
  const [reviewOnly, setReviewOnly] = useState(false)
  const reviewRows = useMemo(() => docsNeeded.rows.filter(rowNeedsBillingReview), [docsNeeded.rows])
  const docsNeededShown = reviewOnly ? reviewRows : docsNeededRows

  /**
   * P10 — shipments whose paperwork is in but which have not been released to billing yet.
   * They live between Docs needed and Unbilled because that is the actual AR ladder;
   * once released they move to UNBILLED and show up on the next tab.
   */
  const readyRows = useMemo(
    () => docsNeeded.rows.filter((r) => r.docsReady && !r.shipment?.podFlaggedAt),
    [docsNeeded.rows],
  )
  const readyBilling = useReadyForBilling(readyRows, tab === 'ready-for-billing')

  const uninvoiced = useMemo(() => {
    const rows = [...unbilled.rows, ...docsNeeded.rows]
    const shipments = rows.map((r) => r.shipment).filter((s): s is ShipmentRecord => s !== null)
    return deliveredNotInvoiced(rows.map((r) => r.order), shipments, asOf)
  }, [unbilled.rows, docsNeeded.rows, asOf])

  const lagDays = useMemo(() => {
    const shipments = invoiced.rows.map((r) => r.shipment).filter((s): s is ShipmentRecord => s !== null)
    return avgDaysToInvoice([...open.invoices, ...paidInvoices], shipments)
  }, [invoiced.rows, open.invoices, paidInvoices])

  const refreshAll = () =>
    Promise.all([unbilled.refresh(), docsNeeded.refresh(), invoiced.refresh(), open.refresh(), customerAr.refresh(), loadMonth()])
      .then(() => undefined)

  const closeAndRefresh = () => {
    setDialog(null)
    void refreshAll()
  }

  const runBatchGenerate = () => {
    setBusy(true)
    const byOrder = new Map(unbilled.rows.map((r) => [r.orderId, r]))
    batchGenerateInvoices({ orderIds: selected })
      .then(({ results }) => {
        const made = results.flatMap((r) => (r.invoiceId ? [r.invoiceId] : []))
        const failed = results.filter((r) => r.error)
        setJustGenerated(made)
        setSelected([])
        // The gate's own sentences, row by row — a toast per refusal scrolls away before
        // anybody can act on eleven of them.
        setRefusals(failed.map((f) => ({
          orderId: f.orderId,
          shipmentNumber: byOrder.get(f.orderId)?.shipmentNumber ?? f.orderId,
          reasons: f.releaseGate && !f.releaseGate.ok
            ? f.releaseGate.missing.map((m) => m.message)
            : [f.error ?? 'Refused'],
        })))
        if (made.length > 0) toast.success(`${made.length} invoice${made.length === 1 ? '' : 's'} generated`)
        if (failed.length > 0) {
          toast.error(`${failed.length} shipment${failed.length === 1 ? '' : 's'} refused — the reasons are listed above the table`)
        }
        return refreshAll()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Batch generate failed'))
      .finally(() => setBusy(false))
  }

  const runBatchEmail = () => {
    setBusy(true)
    batchEmailInvoices({ invoiceIds: justGenerated })
      .then(({ results }) => {
        const sent = results.filter((r) => r.emailStatus === 'SENT').length
        const notSent = results.filter((r) => r.emailStatus === 'NOT_SENT').length
        const refused = results.filter((r) => r.error).length
        if (sent > 0) toast.success(`${sent} invoice${sent === 1 ? '' : 's'} e-mailed`)
        if (notSent > 0) {
          toast.warning(
            `${notSent} not sent (SES is off on dev) — open each invoice to copy the body or download the PDF.`,
          )
        }
        if (refused > 0) toast.error(`${refused} could not be queued`)
        setJustGenerated([])
        return refreshAll()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Batch e-mail failed'))
      .finally(() => setBusy(false))
  }

  const runVoid = (invoice: InvoiceRecord, reason: string) => {
    setBusy(true)
    voidInvoice({ invoiceId: invoice.id, reason })
      .then(() => {
        toast.success(`Invoice ${invoice.number} voided`)
        closeAndRefresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not void the invoice'))
      .finally(() => setBusy(false))
  }

  const runReverse = (payment: ArPaymentRecord, reason: string) => {
    setBusy(true)
    reversePayment({ paymentId: payment.id, reason })
      .then(() => {
        toast.success('Payment reversed')
        closeAndRefresh()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not reverse the payment'))
      .finally(() => setBusy(false))
  }

  const downloadAgingCsv = () => {
    saveBlob(new Blob([agingCsv(open.aging.byCustomer)], { type: 'text/csv' }), `ar-aging-${asOf}.csv`)
  }

  const counts: Record<ExtendedArTabKey, number> = {
    'docs-needed': docsNeededRows.length,
    'ready-for-billing': readyRows.length,
    'to-invoice': unbilled.rows.length,
    unpaid: open.invoices.length,
    paid: paidInvoices.filter((inv) => inv.status === 'PAID').length,
    payments: customerAr.payments.length,
    aging: open.aging.byCustomer.length,
  }

  const AR_TABS_EXTENDED: { key: ExtendedArTabKey; label: string }[] = [
    { key: 'docs-needed', label: 'Docs needed' },
    { key: 'ready-for-billing', label: 'Ready for billing' },
    { key: 'to-invoice', label: 'Unbilled' },
    { key: 'unpaid', label: 'Unpaid' },
    { key: 'paid', label: 'Paid' },
    { key: 'payments', label: 'Payments & credits' },
    { key: 'aging', label: 'Aging' },
  ]

  const error = unbilled.error ?? docsNeeded.error ?? open.error ?? customerAr.error

  const chrome = {
    title: 'Invoicing',
    viewTabs,
    quickTabs: {
      tabs: AR_TABS_EXTENDED.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] })),
      active: tab,
      onSelect: (key: string) => setTab(key as ExtendedArTabKey),
    },
    onRefresh: () => void refreshAll(),
  }

  const errorBanner = error
    ? <p style={{ color: 'var(--tms-badge-red)' }} className="text-sm">{error}</p>
    : null

  const customer = customers.find((c) => c.id === arCustomerId) ?? null

  // One `TmsListPage` for all six views: switching view swaps the columns and the rows
  // under the same chrome, so the tab strip itself is never torn down and remounted.
  const current =
    tab === 'to-invoice' ? toInvoiceView({
      banner: <>{errorBanner}<RefusalsCard refusals={refusals} onDismiss={() => setRefusals([])} /></>,
      rows: unbilled.rows,
      customersById,
      selected,
      justGenerated,
      busy,
      canRelease,
      onSelect: setSelected,
      onGenerate: (row) => setDialog({ kind: 'generate', orderId: row.orderId, shipmentNumber: row.shipmentNumber }),
      onBatchGenerate: runBatchGenerate,
      onBatchEmail: runBatchEmail,
    })
    : tab === 'docs-needed' ? docsNeededView({ banner: errorBanner, rows: docsNeededShown, reviewOnly, reviewCount: reviewRows.length, onReviewOnly: setReviewOnly })
    : tab === 'ready-for-billing' ? readyForBillingView({
      banner: errorBanner,
      ...readyBilling,
    })
    : tab === 'unpaid' ? unpaidView({
      errorBanner,
      invoices: unpaidRows,
      allInvoices: open.invoices,
      filters: unpaidFilters,
      showFilters,
      asOf,
      busy,
      factorByItemId,
      onToggleFilters: () => setShowFilters((s) => !s),
      onFilters: setUnpaidFilters,
      onEmail: (inv) => setDialog({ kind: 'email', invoiceId: inv.id }),
      onPayment: (inv) => setDialog({
        kind: 'payment',
        customerId: inv.customerId,
        customerName: inv.customerName ?? '',
        invoiceId: inv.id,
      }),
      onFactor: (inv) => setDialog({ kind: 'factor', invoiceId: inv.id }),
      onVoid: (inv) => setDialog({ kind: 'void', invoice: inv }),
    })
    : tab === 'paid' ? paidView({
      banner: errorBanner,
      invoices: paidInvoices,
      months,
      month,
      loading: paidLoading,
      onMonth: (ym: string) => { setPaidLoading(true); setMonth(ym) },
    })
    : tab === 'payments' ? paymentsView({
      banner: errorBanner,
      customers,
      customer,
      payments: customerAr.payments,
      openCents: customerAr.openCents,
      unappliedCents: customerAr.unappliedCents,
      busy,
      onCustomer: setArCustomerId,
      onPayment: (customerId, customerName) => setDialog({ kind: 'payment', customerId, customerName }),
      onCredit: (customerId, customerName) => setDialog({ kind: 'credit', customerId, customerName }),
      onReverse: (payment) => setDialog({ kind: 'reverse', payment }),
    })
    : agingView({
      errorBanner,
      aging: open.aging,
      uninvoicedCents: uninvoiced.reduce((sum, r) => sum + r.revenueCents, 0),
      uninvoicedCount: uninvoiced.length,
      avgDaysToInvoice: lagDays,
      avgDaysToPay: avgDaysToPay(paidInvoices),
      paidMonthLabel: monthLabel(month),
      onCsv: downloadAgingCsv,
    })

  return (
    <>
      <div className="tms-page">
        <div className="tms-page-head">
          <h1>{chrome.title}</h1>
          {viewTabs ? <span className="tms-views-btn"><Eye size={15} aria-hidden="true" />Views</span> : null}
          <div className="tms-page-actions">{current.actions}</div>
        </div>
        {viewTabs ? <TmsTabs tabs={viewTabs.tabs} active={viewTabs.active} onSelect={viewTabs.onSelect} /> : null}
        <div className="tms-filter-row">
          <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Refresh" onClick={chrome.onRefresh}>
            <RefreshCw size={15} />
          </button>
          {current.filterChips?.map((chip) => (
            <TmsFilterChip key={chip.key} label={chip.label} value={chip.value} onClick={chip.onClick} />
          ))}
        </div>
        {current.onAddFilter ? (
          <div>
            <button type="button" className="tms-add-filter" onClick={current.onAddFilter}><Plus size={14} aria-hidden="true" />Filter</button>
          </div>
        ) : null}
        <div className="tms-quick-tabs" role="tablist">
          {chrome.quickTabs.tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={t.key === chrome.quickTabs.active}
              className={`tms-quick-tab${t.key === chrome.quickTabs.active ? ' tms-active' : ''}`}
              onClick={() => chrome.quickTabs.onSelect(t.key)}
            >
              {t.label}
              <span className="tms-quick-tab-count">{t.count}</span>
            </button>
          ))}
        </div>
        {current.banner}
        <ArDenseTable<never> key={tab} grid={current.grid} />
      </div>

      {dialog?.kind === 'generate' && (
        <GenerateInvoiceDialog
          orderId={dialog.orderId}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={() => closeAndRefresh()}
        />
      )}
      {dialog?.kind === 'email' && (
        <EmailInvoiceDialog
          invoiceId={dialog.invoiceId}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'payment' && (
        <ReceivePaymentDialog
          customerId={dialog.customerId}
          customerName={dialog.customerName}
          invoiceId={dialog.invoiceId}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'credit' && (
        <CreditMemoDialog
          customerId={dialog.customerId}
          customerName={dialog.customerName}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'factor' && (
        <SendToFactorDialog
          invoiceId={dialog.invoiceId}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={closeAndRefresh}
        />
      )}
      {dialog?.kind === 'void' && (
        <ReasonDialog
          title={`Void invoice ${dialog.invoice.number}`}
          description="Voiding reopens the shipment for a fresh invoice and leaves this one on the record. It cannot be undone."
          label="Why it is being voided"
          confirmLabel="Void invoice"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => runVoid(dialog.invoice, reason)}
        />
      )}
      {dialog?.kind === 'reverse' && (
        <ReasonDialog
          title="Reverse payment"
          description="A reversal posts its own row and restores every balance this receipt took. Nothing is deleted."
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

/** The chrome every AR view shares comes from `ArPage`; each view builds only its table. */

/* ── Unbilled ────────────────────────────────────────────────────────────── */

/**
 * What the release gate refused in the last batch, shipment by shipment. The gate is
 * server-side and absolute; the only thing this page can do is say exactly what is
 * missing so somebody can go and fix it.
 */
function RefusalsCard({ refusals, onDismiss }: { refusals: BatchRefusal[]; onDismiss: () => void }) {
  if (refusals.length === 0) return null
  return (
    <TmsCard
      title={`${refusals.length} shipment${refusals.length === 1 ? '' : 's'} not ready for accounting`}
      actions={<TmsButton variant="ghost" size="sm" onClick={onDismiss}>Dismiss</TmsButton>}
    >
      <ul className="flex flex-col gap-2 text-sm">
        {refusals.map((r) => (
          <li key={r.orderId}>
            <span className="font-medium">{r.shipmentNumber}</span>
            <ul className="mt-0.5 flex flex-col gap-0.5 text-[13px]" style={{ color: 'var(--tms-badge-red)' }}>
              {r.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </li>
        ))}
      </ul>
    </TmsCard>
  )
}

/* ── Column helpers ──────────────────────────────────────────────────────── */

type Col<T> = DenseColumn<T>

/** A money column: right-aligned, sorted by integer cents, filtered in dollars. */
function moneyCol<T>(key: string, header: string, cents: (row: T) => number, group = 'Amounts'): Col<T> {
  return {
    key, header, group, align: 'right',
    text: (row) => formatCents(cents(row)),
    sortValue: (row) => cents(row),
    filter: 'number', numberOf: (row) => cents(row) / 100, numberUnit: '$',
  }
}

const opt = (value: string | null | undefined) => (value ? [{ value, label: value }] : [])

const sumCents = <T,>(rows: T[], cents: (row: T) => number) => rows.reduce((sum, row) => sum + cents(row), 0)

function toInvoiceView({
  banner, rows, customersById, selected, justGenerated, busy, canRelease, onSelect, onGenerate, onBatchGenerate, onBatchEmail,
}: {
  banner: ReactNode
  rows: ArWorklistRow[]
  customersById: Map<string, CustomerRecord>
  selected: string[]
  justGenerated: string[]
  busy: boolean
  canRelease: boolean
  onSelect: (ids: string[]) => void
  onGenerate: (row: ArWorklistRow) => void
  onBatchGenerate: () => void
  onBatchEmail: () => void
}): ListView {
  const toggle = (orderId: string) => {
    onSelect(selected.includes(orderId) ? selected.filter((id) => id !== orderId) : [...selected, orderId])
  }
  const billTo = (row: ArWorklistRow) => billToLabel(row.customerId ? customersById.get(row.customerId) : undefined, row.billToId)
  const docsText = (row: ArWorklistRow) => (row.docsReady ? '✓' : row.docsMissing.join(', ') || 'Missing')

  const columns: Array<Col<ArWorklistRow>> = [
    { key: 'select', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 40 },
    { key: 'shipment', header: 'Shipment', group: 'Shipment', text: (row) => row.shipmentNumber ?? row.shipmentId, extraPx: 16 },
    { key: 'customer', header: 'Customer', group: 'Shipment', text: (row) => row.customerName || '—', filter: 'multi', optionsOf: (row) => opt(row.customerName) },
    { key: 'billTo', header: 'Bill-to', group: 'Shipment', text: billTo },
    {
      key: 'delivered', header: 'Delivered', group: 'Shipment',
      text: (row) => (row.deliveredAt ? formatDay(row.deliveredAt) : 'Not delivered'),
      filter: 'date', dateOf: (row) => row.deliveredAt,
    },
    moneyCol('revenue', 'Revenue', (row) => row.revenueCents),
    { key: 'docs', header: 'Docs', group: 'Billing', text: docsText },
    { key: 'blockers', header: 'Why it cannot be billed', group: 'Billing', text: (row) => row.reasons.join('; '), extraPx: 24 },
    { key: 'generate', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 96 },
  ]

  const renderCell = (row: ArWorklistRow, key: string): ReactNode => {
    switch (key) {
      case 'select':
        return (
          <input
            type="checkbox"
            aria-label={`Select ${row.shipmentNumber ?? row.orderId}`}
            checked={selected.includes(row.orderId)}
            disabled={row.reasons.length > 0}
            onChange={() => toggle(row.orderId)}
          />
        )
      case 'shipment':
        return <Link to={`/tms/shipments/${row.shipmentId}`}>{row.shipmentNumber ?? row.shipmentId}</Link>
      case 'docs':
        return row.docsReady ? <span>✓</span> : <span style={{ color: 'var(--tms-badge-red)' }}>{docsText(row)}</span>
      case 'blockers':
        return row.reasons.length > 0 ? <span style={{ color: 'var(--tms-badge-red)' }}>{row.reasons.join('; ')}</span> : null
      case 'generate':
        return (
          <TmsButton
            size="sm"
            aria-label={`Generate invoice for ${row.shipmentNumber ?? row.orderId}`}
            disabled={busy || row.reasons.length > 0 || !canRelease}
            title={canRelease ? undefined : BILLING_GRANT_MESSAGE}
            onClick={() => onGenerate(row)}
          >
            Generate
          </TmsButton>
        )
      default:
        return columns.find((c) => c.key === key)?.text(row) ?? null
    }
  }

  return view<ArWorklistRow>({
    actions: (
      <>
        <span className="text-sm tms-muted">
          {selected.length} selected{selected.length > BATCH_GENERATE_LIMIT ? ` — ${BATCH_GENERATE_LIMIT} at a time` : ''}
        </span>
        <TmsButton
          variant="primary"
          aria-label="Batch generate invoices"
          disabled={busy || selected.length === 0 || selected.length > BATCH_GENERATE_LIMIT || !canRelease}
          title={canRelease ? undefined : BILLING_GRANT_MESSAGE}
          onClick={onBatchGenerate}
        >
          Batch generate
        </TmsButton>
        <TmsButton
          aria-label="Batch e-mail generated invoices"
          disabled={busy || justGenerated.length === 0 || !canRelease}
          title={canRelease ? undefined : BILLING_GRANT_MESSAGE}
          onClick={onBatchEmail}
        >
          <Mail size={14} /> Batch e-mail ({justGenerated.length})
        </TmsButton>
      </>
    ),
    banner,
    grid: {
      gridId: 'ar-unbilled',
      label: 'Unbilled shipments',
      columns,
      rows,
      rowKey: (row) => row.orderId,
      renderCell,
      empty: 'Nothing is waiting to be billed.',
      kpis: [
        { label: 'Shipments', value: rows.length },
        { label: 'Unbilled revenue', value: formatCents(sumCents(rows, (r) => r.revenueCents)) },
        { label: 'Blocked', value: rows.filter((r) => r.reasons.length > 0).length, tone: 'warn' },
      ],
    },
  })
}

/* ── Docs needed ─────────────────────────────────────────────────────────── */

const reviewFacts = (row: ArWorklistRow) => ({
  arStatus: row.order.arStatus,
  legacyImported: row.shipment?.legacyImported,
  source: row.shipment?.source,
  number: row.shipmentNumber,
})
const rowNeedsBillingReview = (row: ArWorklistRow) => needsBillingReview(reviewFacts(row))

function docsNeededView({ banner, rows, reviewOnly, reviewCount, onReviewOnly }: {
  banner: ReactNode
  rows: ArWorklistRow[]
  reviewOnly: boolean
  reviewCount: number
  onReviewOnly: (on: boolean) => void
}): ListView {
  const deliveredText = (row: ArWorklistRow) =>
    row.deliveredAt ? formatDay(row.deliveredAt) : row.order.invoiceEarly ? 'Bills early' : 'Not delivered'
  const missingText = (row: ArWorklistRow) => (row.docsMissing.length > 0 ? row.docsMissing.join(', ') : 'Nothing — ready for review')

  const columns: Array<Col<ArWorklistRow>> = [
    { key: 'shipment', header: 'Shipment', group: 'Shipment', text: (row) => row.shipmentNumber ?? row.shipmentId, extraPx: 110 },
    { key: 'customer', header: 'Customer', group: 'Shipment', text: (row) => row.customerName || '—', filter: 'multi', optionsOf: (row) => opt(row.customerName) },
    { key: 'delivered', header: 'Delivered', group: 'Shipment', text: deliveredText, filter: 'date', dateOf: (row) => row.deliveredAt },
    moneyCol('revenue', 'Revenue', (row) => row.revenueCents),
    { key: 'missing', header: 'Still missing', group: 'Billing', text: missingText },
    { key: 'documents', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 120 },
  ]

  const renderCell = (row: ArWorklistRow, key: string): ReactNode => {
    switch (key) {
      case 'shipment':
        return (
          <>
            <Link to={`/tms/shipments/${row.shipmentId}?tab=documents`}>{row.shipmentNumber ?? row.shipmentId}</Link>
            {rowNeedsBillingReview(row) && (
              <> <TmsBadge tone="orange" title={reviewBillingNote(reviewFacts(row))}>{REVIEW_BILLING_LABEL}</TmsBadge></>
            )}
          </>
        )
      case 'missing':
        return row.docsMissing.length > 0
          ? <span style={{ color: 'var(--tms-badge-red)' }}>{row.docsMissing.join(', ')}</span>
          : <span className="tms-muted">Nothing — ready for review</span>
      case 'documents':
        return (
          <Link
            className="tms-btn tms-btn-secondary tms-btn-sm"
            aria-label={`Open documents for ${row.shipmentNumber ?? row.shipmentId}`}
            to={`/tms/shipments/${row.shipmentId}?tab=documents`}
          >
            Documents
          </Link>
        )
      default:
        return columns.find((c) => c.key === key)?.text(row) ?? null
    }
  }

  return view<ArWorklistRow>({
    actions: (
      <TmsButton
        size="sm"
        variant={reviewOnly ? 'primary' : 'secondary'}
        aria-pressed={reviewOnly}
        onClick={() => onReviewOnly(!reviewOnly)}
      >
        {REVIEW_BILLING_LABEL} ({reviewCount})
      </TmsButton>
    ),
    banner,
    grid: {
      gridId: 'ar-docs-needed',
      label: 'Shipments waiting on paperwork',
      columns,
      rows,
      rowKey: (row) => row.orderId,
      renderCell,
      empty: reviewOnly ? 'No pre-cutover shipment is waiting on a billing review.' : 'No shipment is waiting on paperwork.',
      kpis: [
        { label: 'Shipments', value: rows.length },
        { label: 'Revenue waiting', value: formatCents(sumCents(rows, (r) => r.revenueCents)) },
        { label: 'Missing a document', value: rows.filter((r) => r.docsMissing.length > 0).length, tone: 'warn' },
      ],
    },
  })
}

/* ── Ready for billing (P10) ─────────────────────────────────────────────── */

function readyForBillingView({
  banner,
  rows,
  loading,
}: {
  banner: ReactNode
  rows: ReadyRow[]
  loading: boolean
}): ListView {
  const gateMessages = (row: ReadyRow) => (row.gate && !row.gate.ok ? row.gate.missing.map((reason) => reason.message) : [])
  const gateText = (row: ReadyRow) => (row.gate == null ? 'Checking…' : row.gate.ok ? 'Ready for billing' : gateMessages(row).join('; '))
  const docsText = (row: ReadyRow) => (row.docsRequired.length === 0 ? 'No required docs' : row.docsRequired.join(', '))
  const refsText = (row: ReadyRow) => {
    const refs = row.order.references ?? []
    return refs.length === 0 ? 'No references' : refs.map((ref) => `${ref.code}: ${ref.value || 'missing'}`).join('; ')
  }

  const columns: Array<Col<ReadyRow>> = [
    { key: 'shipment', header: 'Shipment', group: 'Shipment', text: (row) => row.shipmentNumber ?? row.shipmentId },
    { key: 'customer', header: 'Customer', group: 'Shipment', text: (row) => row.customerName || '—', filter: 'multi', optionsOf: (row) => opt(row.customerName) },
    { key: 'delivered', header: 'Delivered', group: 'Shipment', text: (row) => (row.deliveredAt ? formatDay(row.deliveredAt) : 'Not delivered'), filter: 'date', dateOf: (row) => row.deliveredAt },
    moneyCol('revenue', 'Revenue', (row) => row.revenueCents),
    { key: 'docs', header: 'Docs', group: 'Billing', text: docsText, extraPx: 40 },
    { key: 'refs', header: 'References', group: 'Billing', text: refsText },
    { key: 'gate', header: 'Release gate', group: 'Billing', text: gateText, extraPx: 24 },
    { key: 'review', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 150 },
  ]

  const renderCell = (row: ReadyRow, key: string): ReactNode => {
    switch (key) {
      case 'shipment':
        return <Link to={`/tms/shipments/${row.shipmentId}?tab=documents`}>{row.shipmentNumber ?? row.shipmentId}</Link>
      case 'docs':
        return (
          <span data-testid={`ready-docs-${row.orderId}`} className="flex gap-1 whitespace-nowrap">
            {row.docsRequired.length === 0
              ? <span className="tms-muted">No required docs</span>
              : row.docsRequired.map((type) => (
                <TmsBadge key={type} tone={row.docsMissing.includes(type) ? 'red' : 'green'}>{type}</TmsBadge>
              ))}
          </span>
        )
      case 'refs':
        return <span data-testid={`ready-refs-${row.orderId}`}>{refsText(row)}</span>
      case 'gate':
        if (row.gate == null) return <span className="tms-muted">Checking…</span>
        if (row.gate.ok) return <TmsBadge tone="green">Ready for billing</TmsBadge>
        return <span data-testid={`ready-gate-${row.orderId}`} style={{ color: 'var(--tms-badge-red)' }}>{gateMessages(row).join('; ')}</span>
      case 'review':
        return <ReadyForBillingReviewCell row={row} />
      default:
        return columns.find((c) => c.key === key)?.text(row) ?? null
    }
  }

  return view<ReadyRow>({
    banner,
    grid: {
      gridId: 'ar-ready-for-billing',
      label: 'Ready for billing',
      columns,
      rows,
      rowKey: (row) => row.orderId,
      renderCell,
      empty: loading ? 'Checking the release gate…' : 'No shipments are ready for billing.',
    },
  })
}

/* ── Unpaid ──────────────────────────────────────────────────────────────── */

function unpaidView({
  errorBanner, invoices, allInvoices, filters, showFilters, asOf, busy, factorByItemId,
  onToggleFilters, onFilters, onEmail, onPayment, onFactor, onVoid,
}: {
  errorBanner: ReactNode
  invoices: InvoiceRecord[]
  allInvoices: InvoiceRecord[]
  filters: UnpaidFilters
  showFilters: boolean
  asOf: string
  busy: boolean
  factorByItemId: Map<string, FactoringItem>
  onToggleFilters: () => void
  onFilters: (filters: UnpaidFilters) => void
  onEmail: (invoice: InvoiceRecord) => void
  onPayment: (invoice: InvoiceRecord) => void
  onFactor: (invoice: InvoiceRecord) => void
  onVoid: (invoice: InvoiceRecord) => void
}): ListView {
  const customerName = invoiceCustomerOptions(allInvoices).find((c) => c.id === filters.customerId)?.name ?? null
  const factorText = (inv: InvoiceRecord) => {
    const item = inv.factoringItemId ? factorByItemId.get(inv.factoringItemId) : undefined
    const factor = otrStatusLabel(item?.otrStatus) ?? (inv.factoringItemId ? 'In the factoring queue' : null)
    return factor ?? (inv.factored ? 'Factored customer' : '—')
  }

  const columns: Array<Col<InvoiceRecord>> = [
    { key: 'invoice', header: 'Invoice', group: 'Invoice', text: (inv) => inv.number, extraPx: 16 },
    { key: 'customer', header: 'Customer', group: 'Invoice', text: (inv) => inv.customerName || '—', filter: 'multi', optionsOf: (inv) => opt(inv.customerName) },
    { key: 'issued', header: 'Issued', group: 'Invoice', text: (inv) => formatDay(inv.invoiceDate), filter: 'date', dateOf: (inv) => inv.invoiceDate, sortValue: (inv) => inv.invoiceDate ?? '' },
    { key: 'due', header: 'Due', group: 'Invoice', text: (inv) => formatDay(inv.dueAt), filter: 'date', dateOf: (inv) => inv.dueAt, sortValue: (inv) => inv.dueAt ?? '' },
    {
      key: 'age', header: 'Age', group: 'Invoice', extraPx: 24,
      text: (inv) => agingChipFor(inv.dueAt, asOf).label,
      filter: 'multi', optionsOf: (inv) => opt(agingChipFor(inv.dueAt, asOf).label),
      sortValue: (inv) => inv.dueAt ?? '',
    },
    moneyCol('total', 'Total', (inv) => inv.totalCents),
    moneyCol('paid', 'Paid', (inv) => inv.paidCents),
    moneyCol('balance', 'Balance', (inv) => inv.balanceCents),
    { key: 'sent', header: 'Sent', group: 'Invoice', text: (inv) => (inv.sentCount ? `✓ ${inv.sentCount}` : '—'), sortValue: (inv) => inv.sentCount ?? 0, filter: false },
    { key: 'factor', header: 'Factor', group: 'Invoice', text: factorText, filter: 'multi', optionsOf: (inv) => opt(factorText(inv)), extraPx: 16 },
    { key: 'actions', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 400 },
  ]

  const renderCell = (inv: InvoiceRecord, key: string): ReactNode => {
    switch (key) {
      case 'invoice':
        return <Link to={`/tms/invoicing/invoices/${inv.id}`}>{inv.number}</Link>
      case 'age': {
        const chip = agingChipFor(inv.dueAt, asOf)
        return <TmsBadge tone={chip.late ? 'red' : 'gray'}>{chip.label}</TmsBadge>
      }
      case 'balance':
        return <span className="font-medium">{formatCents(inv.balanceCents)}</span>
      case 'actions':
        return (
          <span className="flex justify-end gap-1 whitespace-nowrap">
            <TmsButton variant="ghost" size="sm" aria-label={`E-mail invoice ${inv.number}`} disabled={busy} onClick={() => onEmail(inv)}>E-mail</TmsButton>
            <TmsButton variant="ghost" size="sm" aria-label={`Receive payment for invoice ${inv.number}`} disabled={busy} onClick={() => onPayment(inv)}>Receive payment</TmsButton>
            <TmsButton variant="ghost" size="sm" aria-label={`Send invoice ${inv.number} to factor`} disabled={busy} onClick={() => onFactor(inv)}>Send to Factor</TmsButton>
            <TmsButton variant="ghost" size="sm" aria-label={`Void invoice ${inv.number}`} disabled={busy} onClick={() => onVoid(inv)}>Void</TmsButton>
          </span>
        )
      default:
        return columns.find((c) => c.key === key)?.text(inv) ?? null
    }
  }

  return view<InvoiceRecord>({
    filterChips: [
      { key: 'customer', label: 'Customer is', value: customerName, onClick: onToggleFilters },
      {
        key: 'bucket',
        label: 'Aging is',
        value: filters.bucket ? AGING_BUCKET_LABEL[filters.bucket] : null,
        onClick: onToggleFilters,
      },
      {
        key: 'factored',
        label: 'Factored is',
        value: filters.factored ? (filters.factored === 'YES' ? 'Factored' : 'Not factored') : null,
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
              <TmsField label="Customer">
                <TmsSelect
                  aria-label="Filter customer"
                  value={filters.customerId}
                  onChange={(e) => onFilters({ ...filters, customerId: e.target.value })}
                >
                  <option value="">All</option>
                  {invoiceCustomerOptions(allInvoices).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </TmsSelect>
              </TmsField>
              <TmsField label="Aging">
                <TmsSelect
                  aria-label="Filter aging bucket"
                  value={filters.bucket}
                  onChange={(e) => onFilters({ ...filters, bucket: e.target.value as UnpaidFilters['bucket'] })}
                >
                  <option value="">All</option>
                  {AGING_BUCKETS.map((b) => <option key={b} value={b}>{AGING_BUCKET_LABEL[b]}</option>)}
                </TmsSelect>
              </TmsField>
              <TmsField label="Factored">
                <TmsSelect
                  aria-label="Filter factored"
                  value={filters.factored}
                  onChange={(e) => onFilters({ ...filters, factored: e.target.value as UnpaidFilters['factored'] })}
                >
                  <option value="">All</option>
                  <option value="YES">Factored</option>
                  <option value="NO">Not factored</option>
                </TmsSelect>
              </TmsField>
            </div>
          </TmsCard>
        )}
      </>
    ),
    grid: {
      gridId: 'ar-unpaid',
      label: 'Unpaid invoices',
      columns,
      rows: invoices,
      rowKey: (inv) => inv.id,
      renderCell,
      empty: (
        <>
          Nothing is owed in this view.{' '}
          <button type="button" className="tms-add-filter" onClick={() => onFilters(EMPTY_UNPAID_FILTERS)}>Click here to clear all filters</button>
        </>
      ),
      kpis: [
        { label: 'Invoices', value: invoices.length },
        { label: 'Open balance', value: formatCents(sumCents(invoices, (inv) => inv.balanceCents)) },
        { label: 'Past due', value: invoices.filter((inv) => agingChipFor(inv.dueAt, asOf).late).length, tone: 'bad' },
      ],
    },
  })
}

/* ── Paid ────────────────────────────────────────────────────────────────── */

function paidView({ banner, invoices, months, month, loading, onMonth }: {
  banner: ReactNode
  invoices: InvoiceRecord[]
  months: string[]
  month: string
  loading: boolean
  onMonth: (ym: string) => void
}): ListView {
  const paid = invoices.filter((inv) => inv.status === 'PAID')
  const columns: Array<Col<InvoiceRecord>> = [
    { key: 'invoice', header: 'Invoice', group: 'Invoice', text: (inv) => inv.number, extraPx: 16 },
    { key: 'customer', header: 'Customer', group: 'Invoice', text: (inv) => inv.customerName || '—', filter: 'multi', optionsOf: (inv) => opt(inv.customerName) },
    { key: 'issued', header: 'Issued', group: 'Invoice', text: (inv) => formatDay(inv.invoiceDate), filter: 'date', dateOf: (inv) => inv.invoiceDate, sortValue: (inv) => inv.invoiceDate ?? '' },
    { key: 'paid', header: 'Paid', group: 'Invoice', text: (inv) => formatDay(inv.paidAt), filter: 'date', dateOf: (inv) => inv.paidAt ?? null, sortValue: (inv) => inv.paidAt ?? '' },
    moneyCol('total', 'Total', (inv) => inv.totalCents),
    moneyCol('writtenOff', 'Written off', (inv) => inv.writtenOffCents ?? 0),
  ]

  const renderCell = (inv: InvoiceRecord, key: string): ReactNode => {
    if (key === 'invoice') return <Link to={`/tms/invoicing/invoices/${inv.id}`}>{inv.number}</Link>
    if (key === 'writtenOff') return inv.writtenOffCents ? formatCents(inv.writtenOffCents) : '—'
    return columns.find((c) => c.key === key)?.text(inv) ?? null
  }

  return view<InvoiceRecord>({
    actions: (
      <>
        <TmsSelect aria-label="Invoice month" value={month} onChange={(e) => onMonth(e.target.value)}>
          {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
        </TmsSelect>
        {loading && <span className="text-sm tms-muted">Loading…</span>}
      </>
    ),
    banner,
    grid: {
      gridId: 'ar-paid',
      label: 'Paid invoices',
      columns,
      rows: paid,
      rowKey: (inv) => inv.id,
      renderCell,
      empty: `Nothing was collected in ${monthLabel(month)}.`,
      kpis: [
        { label: 'Invoices paid', value: paid.length },
        { label: 'Invoiced total', value: formatCents(sumCents(paid, (inv) => inv.totalCents)) },
        { label: 'Written off', value: formatCents(sumCents(paid, (inv) => inv.writtenOffCents ?? 0)) },
      ],
    },
  })
}

/* ── Payments & credits ──────────────────────────────────────────────────── */

function paymentsView({
  banner, customers, customer, payments, openCents, unappliedCents, busy,
  onCustomer, onPayment, onCredit, onReverse,
}: {
  banner: ReactNode
  customers: CustomerRecord[]
  customer: CustomerRecord | null
  payments: ArPaymentRecord[]
  openCents: number
  unappliedCents: number
  busy: boolean
  onCustomer: (id: string | null) => void
  onPayment: (customerId: string, customerName: string) => void
  onCredit: (customerId: string, customerName: string) => void
  onReverse: (payment: ArPaymentRecord) => void
}): ListView {
  const columns: Array<Col<ArPaymentRecord>> = [
    { key: 'kind', header: 'Kind', group: 'Cash', text: (p) => AR_PAYMENT_KIND_LABEL[p.kind], filter: 'multi', optionsOf: (p) => opt(AR_PAYMENT_KIND_LABEL[p.kind]) },
    { key: 'date', header: 'Date', group: 'Cash', text: (p) => formatDay(p.receivedAt), filter: 'date', dateOf: (p) => p.receivedAt, sortValue: (p) => p.receivedAt ?? '' },
    { key: 'method', header: 'Method', group: 'Cash', text: (p) => (p.method ? AR_PAYMENT_METHOD_LABEL[p.method] : '—'), filter: 'multi', optionsOf: (p) => opt(p.method ? AR_PAYMENT_METHOD_LABEL[p.method] : null) },
    { key: 'reference', header: 'Reference', group: 'Cash', text: (p) => p.reference || '—' },
    moneyCol('amount', 'Amount', (p) => p.amountCents, 'Cash'),
    moneyCol('applied', 'Applied', (p) => p.appliedCents, 'Cash'),
    moneyCol('unapplied', 'Unapplied', (p) => p.unappliedCents, 'Cash'),
    { key: 'reverse', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 100 },
  ]

  const renderCell = (p: ArPaymentRecord, key: string): ReactNode => {
    if (key === 'reverse') {
      return (
        <span className="flex justify-end">
          {p.kind !== 'REVERSAL' && !p.reversedByPaymentId && (
            <TmsButton
              variant="ghost"
              size="sm"
              aria-label={`Reverse ${AR_PAYMENT_KIND_LABEL[p.kind].toLowerCase()} of ${formatCents(p.amountCents)}`}
              disabled={busy}
              onClick={() => onReverse(p)}
            >
              Reverse
            </TmsButton>
          )}
          {p.reversedByPaymentId && <span className="text-xs tms-muted">Reversed</span>}
        </span>
      )
    }
    return columns.find((c) => c.key === key)?.text(p) ?? null
  }

  const shown = customer ? payments : []
  return view<ArPaymentRecord>({
    actions: (
      <>
        <TmsSelect
          aria-label="Choose customer"
          value={customer?.id ?? ''}
          onChange={(e) => onCustomer(e.target.value || null)}
        >
          <option value="">Choose a customer…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </TmsSelect>
        {customer && (
          <>
            <TmsBadge tone="gray">{formatCents(openCents)} open</TmsBadge>
            <TmsBadge tone="gray">{formatCents(unappliedCents)} unapplied</TmsBadge>
            <TmsButton variant="primary" aria-label="Receive payment" disabled={busy} onClick={() => onPayment(customer.id, customer.name)}>
              Receive payment
            </TmsButton>
            <TmsButton aria-label="New credit" disabled={busy} onClick={() => onCredit(customer.id, customer.name)}>
              New credit
            </TmsButton>
          </>
        )}
      </>
    ),
    banner,
    grid: {
      gridId: 'ar-payments',
      label: 'Payments and credits',
      columns,
      rows: shown,
      rowKey: (p) => p.id,
      renderCell,
      empty: customer ? `No cash has been posted for ${customer.name}.` : 'Choose a customer to see their cash rows.',
    },
  })
}

/* ── Aging ───────────────────────────────────────────────────────────────── */

function agingView({
  errorBanner, aging, uninvoicedCents, uninvoicedCount, avgDaysToInvoice: lag, avgDaysToPay: dso,
  paidMonthLabel, onCsv,
}: {
  errorBanner: ReactNode
  aging: AgingSummary
  uninvoicedCents: number
  uninvoicedCount: number
  avgDaysToInvoice: number | null
  avgDaysToPay: number | null
  paidMonthLabel: string
  onCsv: () => void
}): ListView {
  type Row = AgingSummary['byCustomer'][number]
  const columns: Array<Col<Row>> = [
    { key: 'customer', header: 'Customer', group: 'Customer', text: (row) => row.customerName || row.customerId },
    ...AGING_BUCKETS.map((b) => moneyCol<Row>(b, AGING_BUCKET_LABEL[b], (row) => row.byBucket[b], 'Buckets')),
    moneyCol<Row>('total', 'Total', (row) => row.totalCents, 'Buckets'),
    {
      key: 'late', header: 'Late', group: 'Late', align: 'right',
      text: (row) => String(row.lateCount || '—'), sortValue: (row) => row.lateCount,
      filter: 'number', numberOf: (row) => row.lateCount,
    },
    {
      key: 'oldest', header: 'Oldest', group: 'Late', align: 'right',
      text: (row) => (row.oldestDays ? `${row.oldestDays}d` : '—'), sortValue: (row) => row.oldestDays,
      filter: 'number', numberOf: (row) => row.oldestDays, numberUnit: 'days',
    },
  ]

  return view<Row>({
    actions: (
      <TmsButton aria-label="Download aging CSV" onClick={onCsv}>
        <Download size={14} /> CSV
      </TmsButton>
    ),
    banner: (
      <>
        {errorBanner}
        <AgingStrip
          openCents={aging.totalCents}
          lateCents={aging.lateCents}
          deliveredNotInvoicedCents={uninvoicedCents}
          deliveredNotInvoicedCount={uninvoicedCount}
          avgDaysToInvoice={lag}
          avgDaysToPay={dso}
          paidMonthLabel={paidMonthLabel}
        />
      </>
    ),
    grid: {
      gridId: 'ar-aging',
      label: 'Aging by customer',
      columns,
      rows: aging.byCustomer,
      rowKey: (row) => row.customerId,
      empty: 'Nothing is owed.',
    },
  })
}
