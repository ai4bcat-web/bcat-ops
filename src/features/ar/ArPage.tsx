/**
 * The receivable half of `/tms/invoicing` (spec §3.6, §6.6; `TMS_DESIGN` §4.12).
 *
 * The queue holds only shipments released to billing from Load Review, and follows each one
 * to paid in three statuses: Ready to invoice, Invoiced, Paid (`arQueue.ts` decides which).
 * Paperwork chasing lives in Load Review, not here. Payments & credits and Aging are the two
 * ledger views after the queue. Every number is integer cents formatted once, by `formatCents`.
 *
 * On dev, SES is denied: an invoice e-mail comes back NOT_SENT with the refusal and a
 * signed download. The page reports exactly that and never claims a send that did not
 * happen — a false "sent" here is a customer who never got their bill.
 */
import { ArSummaryStrip } from './ArSummaryStrip'
import { computeArSummary, divisionKeyOf } from './arSummary'
import { SendReviewCarousel } from './components/SendReviewCarousel'
import { AgingStatementDialog } from './components/AgingStatementDialog'
import { allApEmails } from '@/lib/billingMethod'
import { useAuthUser } from '@/hooks/useAuth'
import { isOwnerOrAdmin } from '@/lib/accountingAccess'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Download, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { BillingGapsPanel } from './components/BillingGapsPanel'
import { Eye, RefreshCw } from 'lucide-react'
import {
  TmsBadge, TmsButton, TmsCard, TmsSelect, TmsTabStrip, TmsTabs,
  type TmsTabGroup,
} from '@/features/tms/kit'
import type { DenseColumn } from '@/features/tms/grid/denseGridModel'
import { ArDenseTable, type ArGrid } from './components/ArDenseTable'
import { useArWorklist } from '@/hooks/useArWorklist'
import { useCustomerAr } from '@/hooks/useCustomerAr'
import { useOpenInvoices } from '@/hooks/useOpenInvoices'
import { exportOutstandingReceivables } from '@/lib/opsExports'
import { useDirectory } from '@/hooks/useDirectory'
import { useFactoringItems } from '@/hooks/useFactoringItems'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import {
  agingStatement, batchEmailInvoices, batchGenerateInvoices, graphqlErrorText, listInvoicesByMonth, listUserProfiles, reversePayment, voidInvoice,
} from '@/lib/apiClient'
import { loadWorklistShipments } from '@/lib/worklistShipments'
import {
  AR_AGING_BUCKETS, AR_AGING_BUCKET_LABEL, agingCsv,
  type AgingSummary,
} from '@/lib/arAging'
import { chicagoDateStr } from '@/lib/date'
import { saveBlob } from '@/lib/download'
import { formatCents } from '@/lib/invoiceBuild'
import { otrStatusLabel } from '@/lib/otrInvoiceStatus'
import { otrRejection } from '@/lib/otrRejection'
import {
  AR_PAYMENT_KIND_LABEL, AR_PAYMENT_METHOD_LABEL, BATCH_GENERATE_LIMIT,
  agingChipFor, formatDay, lastThreeMonths, monthLabel,
} from './arViews'
import {
  AR_BILLED_BY_LABEL, AR_GROUP_BY_LABEL, AR_QUEUE_STATUS_LABEL, billedByMatches, isInvoiceSent, splitOpenInvoices, buildPaidRows, buildReadyRows, groupKeyOf, groupTotals,
  orderByGroup, type ArBilledBy, type ArGroupBy, type ArQueueLookups, type ArQueueRow, type ArQueueStatus,
} from './arQueue'
import { CreditMemoDialog } from './components/CreditMemoDialog'
import { EmailInvoiceDialog } from './components/EmailInvoiceDialog'
import { GenerateInvoiceDialog } from './components/GenerateInvoiceDialog'
import { ReasonDialog } from './components/ReasonDialog'
import { ReceivePaymentDialog } from './components/ReceivePaymentDialog'
import { SendToFactorDialog } from './components/SendToFactorDialog'
import { useBillingGrant, BILLING_GRANT_MESSAGE } from './useBillingGrant'
import type { FactoringItem } from '@/types'
import type { ArPaymentRecord, CustomerRecord, InvoiceRecord, ShipmentRecord, UserProfileRecord } from '@/types/tms'

/** Which dialog is open, and the one thing it is open about. Mount is the `open` flag. */
type ArDialog =
  | { kind: 'review'; invoices: InvoiceRecord[] }
  | { kind: 'statement'; customerId: string; customerName: string }
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
 * One view's half of the page: the head actions, the banner above the table and the grid
 * itself. Columns, rows and `rowKey` are built together by the view that owns them, so the
 * row type is erased here and the page renders them all.
 */
interface ListView {
  actions?: ReactNode
  banner?: ReactNode
  grid: ArGrid<never>
}

function view<T>(config: Omit<ListView, 'grid'> & { grid: ArGrid<T> }): ListView {
  return config as unknown as ListView
}

/** The three queue statuses, then the two ledger views. */
export type ArPageTab = 'ready' | 'invoiced' | 'paid' | 'payments' | 'aging'

const QUEUE_TAB_STATUS: Record<'ready' | 'invoiced' | 'paid', ArQueueStatus> = {
  ready: 'READY',
  invoiced: 'INVOICED',
  paid: 'PAID',
}

const GROUP_BY_KEY = 'tms:ar:groupBy'
const BILLED_BY_KEY = 'tms:ar:billedBy'

function readBilledBy(): ArBilledBy {
  try {
    const v = localStorage.getItem(BILLED_BY_KEY)
    return v === 'factored' || v === 'all' ? v : 'manual'
  } catch {
    return 'manual'
  }
}

function readGroupBy(): ArGroupBy {
  try {
    const v = localStorage.getItem(GROUP_BY_KEY)
    return v === 'division' || v === 'customer' || v === 'rep' ? v : 'none'
  } catch {
    return 'none'
  }
}

export function ArPage({ viewTabs }: { viewTabs?: TmsTabGroup } = {}) {
  // One clock for the whole page: the chips, the buckets and the CSV all answer as of the
  // same day, so a row cannot read "Current" next to a 1–30 column it was counted in.
  const [asOf] = useState(() => chicagoDateStr(new Date()))

  const [tab, setTab] = useState<ArPageTab>('ready')
  const [dialog, setDialog] = useState<ArDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const canRelease = useBillingGrant()
  const authUser = useAuthUser()
  // Voiding is an admin act (owner or ADMIN); Invoicing access alone does not include it.
  const canVoid = isOwnerOrAdmin(authUser?.groups, authUser?.email)
  const [groupBy, setGroupByState] = useState<ArGroupBy>(readGroupBy)
  // Manually invoiced (the default) vs factored through OTR; the OTR queue itself is the Factored view.
  const [billedBy, setBilledByState] = useState<ArBilledBy>(readBilledBy)
  const setBilledBy = (next: ArBilledBy) => {
    setBilledByState(next)
    setSelected([])
    try { localStorage.setItem(BILLED_BY_KEY, next) } catch { /* per-viewer convenience only */ }
  }
  const setGroupBy = (next: ArGroupBy) => {
    setGroupByState(next)
    try { localStorage.setItem(GROUP_BY_KEY, next) } catch { /* per-viewer convenience only */ }
  }

  // Released to billing from Load Review = Order.arStatus UNBILLED.
  const unbilled = useArWorklist('UNBILLED')
  // Invoiced-but-unpaid orders: the shipments behind the open invoices, and their release dates.
  const invoiced = useArWorklist('UNPAID')
  const open = useOpenInvoices()
  const { customers } = useDirectory({ locations: false })
  const { items: factoringItems } = useFactoringItems()
  const { divisions } = useOwnershipDivisions()

  const [profiles, setProfiles] = useState<UserProfileRecord[]>([])
  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(() => listUserProfiles())
      .then((rows) => { if (alive) setProfiles(rows ?? []) })
      .catch(() => { /* names fall back to the id */ })
    return () => { alive = false }
  }, [])

  const [selected, setSelected] = useState<string[]>([])
  /** A division chip from the summary strip: `BROKERAGE` or `ASSETS/LOCAL`. */
  const [divisionFilter, setDivisionFilter] = useState<string | null>(null)
  /** Customers ticked on the Aging tab for a bulk statement send. */
  const [statementSelected, setStatementSelected] = useState<string[]>([])
  /** What the last batch generated, so "Batch e-mail" bills exactly those invoices. */
  const [justGenerated, setJustGenerated] = useState<string[]>([])
  /** What the last batch refused, with the release gate's own sentences. */
  const [refusals, setRefusals] = useState<BatchRefusal[]>([])

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

  // Shipments behind paid invoices are not in any worklist; read them by id for division and rep.
  const [paidShipments, setPaidShipments] = useState<ShipmentRecord[]>([])
  const paidShipmentIds = useMemo(
    () => [...new Set(paidInvoices.filter((inv) => inv.status === 'PAID').map((inv) => inv.shipmentId))].sort().join(','),
    [paidInvoices],
  )
  useEffect(() => {
    let alive = true
    const ids = paidShipmentIds.split(',').filter(Boolean)
    Promise.resolve()
      .then(() => (ids.length ? loadWorklistShipments(ids) : []))
      .then((rows) => { if (alive) setPaidShipments(rows ?? []) })
      .catch(() => { /* division and rep fall back to the invoice */ })
    return () => { alive = false }
  }, [paidShipmentIds])

  const factorByItemId = useMemo(() => {
    const map = new Map<string, FactoringItem>()
    for (const item of factoringItems) map.set(item.id, item)
    return map
  }, [factoringItems])

  const lookups: ArQueueLookups = useMemo(() => {
    const shipmentsById = new Map<string, ShipmentRecord>()
    for (const s of paidShipments) shipmentsById.set(s.id, s)
    for (const r of [...unbilled.rows, ...invoiced.rows]) if (r.shipment) shipmentsById.set(r.shipmentId, r.shipment)
    const divisionByCode = new Map((divisions ?? []).map((d) => [d.code, d.name]))
    const profileById = new Map<string, UserProfileRecord>()
    for (const p of profiles) {
      if (p.id) profileById.set(p.id, p)
      if (p.email) profileById.set(p.email, p)
    }
    return {
      shipmentsById,
      asOf,
      divisionName: (code) => (code ? divisionByCode.get(code) ?? code : 'No division'),
      repName: (id) => {
        if (!id) return 'No sales rep'
        const p = profileById.get(id)
        return p?.name ?? p?.email ?? id
      },
    }
  }, [paidShipments, unbilled.rows, invoiced.rows, divisions, profiles, asOf])

  const releasedByOrder = useMemo(
    () => new Map(invoiced.rows.map((r) => [r.orderId, r.order.readyToInvoiceAt ?? null])),
    [invoiced.rows],
  )

  const queue: Record<ArQueueStatus, ArQueueRow[]> = useMemo(() => {
    // Auto-generated on release but not yet sent = a draft for review in Ready to invoice.
    const split = splitOpenInvoices(open.invoices, lookups, releasedByOrder, (inv) =>
      isInvoiceSent(inv, inv.factoringItemId ? factorByItemId.get(inv.factoringItemId) : null))
    const keep = (rows: ArQueueRow[]) => rows.filter((row) => billedByMatches(row, billedBy)
      && (!divisionFilter || divisionKeyOf(lookups.shipmentsById.get(row.shipmentId) ?? { revDivision: row.revDivision }) === divisionFilter))
    return {
      READY: keep((() => {
        const ready = buildReadyRows(unbilled.rows, lookups)
        const readyOrders = new Set(ready.map((r) => r.orderId))
        return [...split.drafts.filter((r) => !readyOrders.has(r.orderId)), ...ready]
      })()),
      INVOICED: keep(split.invoiced),
      PAID: keep(buildPaidRows(paidInvoices, lookups)),
    }
  }, [unbilled.rows, open.invoices, paidInvoices, lookups, releasedByOrder, billedBy, factorByItemId, divisionFilter])

  // Paid invoices over the last three months, for the days-to-pay figures (90-day window).
  const [recentPaid, setRecentPaid] = useState<InvoiceRecord[]>([])
  useEffect(() => {
    let alive = true
    Promise.all(months.map((m) => listInvoicesByMonth(m).catch(() => [] as InvoiceRecord[])))
      .then((sets) => { if (alive) setRecentPaid(sets.flat()) })
    return () => { alive = false }
  }, [months])
  const summary = useMemo(() => computeArSummary({
    open: open.invoices,
    paid: recentPaid,
    factorByItemId,
    shipmentsById: lookups.shipmentsById,
    divisionName: lookups.divisionName,
    asOf,
  }), [open.invoices, recentPaid, factorByItemId, lookups, asOf])


  const refreshAll = () =>
    Promise.all([unbilled.refresh(), invoiced.refresh(), open.refresh(), customerAr.refresh(), loadMonth()])
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

  const queueTotal = (status: ArQueueStatus) => formatCents(queue[status].reduce((sum, r) => sum + (status === 'INVOICED' ? r.balanceCents : r.amountCents), 0))
  const tabs = [
    { key: 'ready', label: `${AR_QUEUE_STATUS_LABEL.READY} · ${queueTotal('READY')}`, count: queue.READY.length, testId: 'ar-tab-ready' },
    { key: 'invoiced', label: `${AR_QUEUE_STATUS_LABEL.INVOICED} · ${queueTotal('INVOICED')} open`, count: queue.INVOICED.length, testId: 'ar-tab-invoiced' },
    { key: 'paid', label: `${AR_QUEUE_STATUS_LABEL.PAID} · ${queueTotal('PAID')}`, count: queue.PAID.length, testId: 'ar-tab-paid' },
    { key: 'payments', label: 'Payments & credits', count: customerAr.payments.length, testId: 'ar-tab-payments' },
    { key: 'aging', label: 'Aging', count: open.aging.byCustomer.length, testId: 'ar-tab-aging' },
  ]

  const error = unbilled.error ?? invoiced.error ?? open.error ?? customerAr.error
  const errorBanner = error
    ? <p style={{ color: 'var(--tms-badge-red)' }} className="text-sm">{error}</p>
    : null

  const customer = customers.find((c) => c.id === arCustomerId) ?? null
  const customerById = new Map(customers.map((c) => [c.id, c]))
  const runBulkStatements = async () => {
    setBusy(true)
    let sent = 0
    const failed: string[] = []
    for (const id of statementSelected) {
      const name = customerById.get(id)?.name ?? id
      try {
        const row = await agingStatement({ customerId: id, send: true })
        if (row.emailStatus === 'SENT') sent++
        else failed.push(`${name}: ${row.emailError || row.emailStatus}`)
      } catch (err) {
        failed.push(`${name}: ${graphqlErrorText(err)}`)
      }
    }
    setBusy(false)
    setStatementSelected([])
    if (sent) toast.success(`Sent ${sent} aging report${sent === 1 ? '' : 's'}`)
    if (failed.length) toast.error(`Not sent — ${failed.join('; ')}`)
    void refreshAll()
  }

  const groupControl = (
    <>
    <label className="flex items-center gap-1 text-sm">
      <span className="tms-muted">Billed</span>
      <TmsSelect aria-label="Billed" value={billedBy} onChange={(e) => setBilledBy(e.target.value as ArBilledBy)}>
        {(Object.keys(AR_BILLED_BY_LABEL) as ArBilledBy[]).map((k) => <option key={k} value={k}>{AR_BILLED_BY_LABEL[k]}</option>)}
      </TmsSelect>
    </label>
    <label className="flex items-center gap-1 text-sm">
      <span className="tms-muted">Group by</span>
      <TmsSelect aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as ArGroupBy)}>
        {(Object.keys(AR_GROUP_BY_LABEL) as ArGroupBy[]).map((k) => <option key={k} value={k}>{AR_GROUP_BY_LABEL[k]}</option>)}
      </TmsSelect>
    </label>
    </>
  )

  const current =
    tab === 'ready' || tab === 'invoiced' || tab === 'paid' ? queueView({
      status: QUEUE_TAB_STATUS[tab],
      rows: queue[QUEUE_TAB_STATUS[tab]],
      groupBy,
      groupControl,
      banner: (
        <>
          {errorBanner}
          {tab === 'ready' && <RefusalsCard refusals={refusals} onDismiss={() => setRefusals([])} />}
          {tab === 'ready' && (
            <p className="text-sm tms-muted" data-testid="ar-ready-note">
              Only shipments moved to billing from <Link to="/tms/load-review">Load Review</Link> appear here. Paperwork and undelivered loads stay in Load Review.
            </p>
          )}
        </>
      ),
      asOf,
      busy,
      canRelease,
      canVoid,
      selected,
      justGenerated,
      factorByItemId,
      customerById,
      months,
      month,
      paidLoading,
      onMonth: (ym: string) => { setPaidLoading(true); setMonth(ym) },
      onSelect: setSelected,
      onGenerate: (row) => setDialog({ kind: 'generate', orderId: row.orderId, shipmentNumber: row.shipmentNumber }),
      onBatchGenerate: runBatchGenerate,
      onBatchEmail: runBatchEmail,
      onEmail: (inv) => setDialog({ kind: 'email', invoiceId: inv.id }),
      onPayment: (inv) => setDialog({ kind: 'payment', customerId: inv.customerId, customerName: inv.customerName ?? '', invoiceId: inv.id }),
      onFactor: (inv) => setDialog({ kind: 'factor', invoiceId: inv.id }),
      onReview: (invs) => setDialog({ kind: 'review', invoices: invs }),
      onVoid: (inv) => setDialog({ kind: 'void', invoice: inv }),
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
      onCsv: downloadAgingCsv,
      customerById,
      statementSelected,
      onStatementSelect: setStatementSelected,
      onStatement: (customerId, customerName) => setDialog({ kind: 'statement', customerId, customerName }),
      onBulkStatements: () => void runBulkStatements(),
      busy,
    })

  return (
    <>
      <div className="tms-page">
        <div className="tms-page-head">
          <h1>Invoicing</h1>
          {viewTabs ? <span className="tms-views-btn"><Eye size={15} aria-hidden="true" />Views</span> : null}
          <div className="tms-page-actions">
            <button type="button" className="tms-btn tms-btn-secondary tms-btn-sm" data-testid="export-outstanding-receivables" title="Every open invoice with every field"
              onClick={() => { exportOutstandingReceivables().then((n) => toast.success(`Exported ${n} outstanding receivables`)).catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not export')) }}>
              <Download size={14} aria-hidden="true" /> Export outstanding
            </button>
            {current.actions}
          </div>
        </div>
        {viewTabs ? <TmsTabs tabs={viewTabs.tabs} active={viewTabs.active} onSelect={viewTabs.onSelect} /> : null}
        <div className="tms-filter-row">
          <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Refresh" onClick={() => void refreshAll()}>
            <RefreshCw size={15} />
          </button>
        </div>
        <BillingGapsPanel onFixed={() => void refreshAll()} />
        <ArSummaryStrip summary={summary} division={divisionFilter} onDivision={(key) => { setSelected([]); setDivisionFilter(key) }} />
        <TmsTabStrip aria-label="Invoicing status" tabs={tabs} active={tab} onSelect={(key) => { setSelected([]); setTab(key as ArPageTab) }} />
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
      {dialog?.kind === 'review' && (
        <SendReviewCarousel
          invoices={dialog.invoices}
          customerById={customerById}
          shipmentsById={lookups.shipmentsById}
          onClose={() => setDialog(null)}
          onDone={() => { setSelected([]); void refreshAll() }}
        />
      )}
      {dialog?.kind === 'statement' && (
        <AgingStatementDialog
          customerId={dialog.customerId}
          customerName={dialog.customerName}
          onClose={() => setDialog(null)}
          onSent={() => { setDialog(null); void refreshAll() }}
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



/* ── The queue: Ready to invoice / Invoiced / Paid ──────────────────────────── */

function dateCol<T>(key: string, header: string, of: (row: T) => string | null, group = 'Dates'): Col<T> {
  return { key, header, group, text: (row) => formatDay(of(row)), filter: 'date', dateOf: (row) => of(row), sortValue: (row) => of(row) ?? '' }
}

function queueView({
  status, rows, groupBy, groupControl, banner, asOf, busy, canRelease, canVoid, selected, justGenerated, factorByItemId, customerById,
  months, month, paidLoading, onMonth, onSelect, onGenerate, onBatchGenerate, onBatchEmail, onPayment, onFactor, onVoid, onReview,
}: {
  status: ArQueueStatus
  rows: ArQueueRow[]
  groupBy: ArGroupBy
  groupControl: ReactNode
  banner: ReactNode
  asOf: string
  busy: boolean
  canRelease: boolean
  selected: string[]
  justGenerated: string[]
  factorByItemId: Map<string, FactoringItem>
  customerById: Map<string, CustomerRecord>
  months: string[]
  month: string
  paidLoading: boolean
  onMonth: (ym: string) => void
  onSelect: (ids: string[]) => void
  onGenerate: (row: ArQueueRow) => void
  onBatchGenerate: () => void
  onBatchEmail: () => void
  onEmail: (invoice: InvoiceRecord) => void
  onPayment: (invoice: InvoiceRecord) => void
  onFactor: (invoice: InvoiceRecord) => void
  onReview: (invoices: InvoiceRecord[]) => void
  onVoid: (invoice: InvoiceRecord) => void
  canVoid: boolean
}): ListView {
  const ready = status === 'READY'
  const invoiced = status === 'INVOICED'
  const toggle = (orderId: string) => {
    onSelect(selected.includes(orderId) ? selected.filter((id) => id !== orderId) : [...selected, orderId])
  }
  const sentText = (row: ArQueueRow) =>
    row.sentAt ? `${formatDay(row.sentAt)}${row.sentTo ? ` → ${row.sentTo}` : ''}` : row.invoiceId ? 'Not sent' : '—'
  const pastDueText = (row: ArQueueRow) =>
    row.dueAt && invoiced ? agingChipFor(row.dueAt, asOf).label : '—'
  // Who the invoice is (or will be) e-mailed to: the customer's AP addresses, and the copy list.
  const invoiceEmailsOf = (row: ArQueueRow): { to: string[]; cc: string[] } => {
    const c = row.customerId ? customerById.get(row.customerId) : undefined
    const to = allApEmails(c)
    const cc = (c?.invoiceCopyEmails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e && !to.includes(e))
    return { to, cc }
  }
  const factorText = (row: ArQueueRow) => {
    const inv = row.invoice
    if (!inv) return '—'
    const item = inv.factoringItemId ? factorByItemId.get(inv.factoringItemId) : undefined
    if (item && otrRejection(item)) return 'OTR rejected: invoice manually'
    const factor = otrStatusLabel(item?.otrStatus) ?? (inv.factoringItemId ? 'In the factoring queue' : null)
    return factor ?? (inv.factored ? 'Factored customer' : '—')
  }

  const columns: Array<Col<ArQueueRow>> = [
    ...(ready ? [{ key: 'select', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 40 } as Col<ArQueueRow>] : []),
    { key: 'shipment', header: 'PRO', group: 'Shipment', text: (row) => row.shipmentNumber ?? row.shipmentId, extraPx: 16 },
    { key: 'invoice', header: 'Invoice #', group: 'Invoice', text: (row) => row.invoiceNumber ?? '—' },
    {
      key: 'via', header: 'Invoiced via', group: 'Invoice', text: (row) => (row.factored ? 'OTR' : 'Manual'),
      filter: 'multi', optionsOf: (row) => opt(row.factored ? 'OTR' : 'Manual'),
    },
    {
      key: 'email', header: 'Invoice email', group: 'Invoice',
      text: (row) => invoiceEmailsOf(row).to.join(', ') || (row.factored ? '' : 'No AP email'),
    },
    { key: 'customer', header: 'Customer', group: 'Shipment', text: (row) => row.customerName, filter: 'multi', optionsOf: (row) => opt(row.customerName) },
    { key: 'division', header: 'Rev division', group: 'Shipment', text: (row) => row.revDivisionName, filter: 'multi', optionsOf: (row) => opt(row.revDivisionName) },
    { key: 'rep', header: 'Sales rep', group: 'Shipment', text: (row) => row.salesRepName, filter: 'multi', optionsOf: (row) => opt(row.salesRepName) },
    dateCol<ArQueueRow>('delivered', 'Delivered', (row) => row.deliveredAt),
    dateCol<ArQueueRow>('released', 'Released', (row) => row.releasedAt),
    dateCol<ArQueueRow>('invoiceDate', 'Invoice date', (row) => row.invoiceDate),
    dateCol<ArQueueRow>('due', 'Due', (row) => row.dueAt),
    moneyCol<ArQueueRow>('amount', 'Amount', (row) => row.amountCents),
    moneyCol<ArQueueRow>('balance', 'Balance', (row) => row.balanceCents),
    { key: 'status', header: 'Status', group: 'Invoice', text: (row) => (row.shortPaid ? `Short paid ${formatCents(row.balanceCents)} open` : AR_QUEUE_STATUS_LABEL[row.status]), filter: 'multi', optionsOf: (row) => opt(AR_QUEUE_STATUS_LABEL[row.status]) },
    { key: 'sent', header: 'Sent', group: 'Invoice', text: sentText, sortValue: (row) => row.sentAt ?? '' },
    {
      key: 'age', header: 'Days since invoice', group: 'Invoice', align: 'right',
      text: (row) => (row.daysSinceInvoice == null ? '—' : `${row.daysSinceInvoice}d`),
      sortValue: (row) => row.daysSinceInvoice ?? -1, filter: 'number', numberOf: (row) => row.daysSinceInvoice ?? 0, numberUnit: 'days',
    },
    {
      key: 'pastDue', header: 'Days past due', group: 'Invoice', align: 'right', text: pastDueText,
      sortValue: (row) => row.daysPastDue ?? -99999, filter: 'number', numberOf: (row) => row.daysPastDue ?? 0, numberUnit: 'days',
    },
    ...(status === 'PAID' ? [dateCol<ArQueueRow>('paidAt', 'Paid on', (row) => row.paidAt)] : []),
    ...(invoiced ? [{ key: 'factor', header: 'Factor', group: 'Invoice', text: factorText, filter: 'multi', optionsOf: (row: ArQueueRow) => opt(factorText(row)) } as Col<ArQueueRow>] : []),
    ...(ready || invoiced ? [{ key: 'actions', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: ready ? 104 : 400 } as Col<ArQueueRow>] : []),
  ]

  const renderCell = (row: ArQueueRow, key: string): ReactNode => {
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
      case 'invoice':
        return row.invoiceId ? <Link to={`/tms/invoicing/invoices/${row.invoiceId}`}>{row.invoiceNumber}</Link> : <span className="tms-muted">—</span>
      case 'email': {
        const { to, cc } = invoiceEmailsOf(row)
        const tip = [to.length ? `To: ${to.join(', ')}` : '', cc.length ? `Copy: ${cc.join(', ')}` : ''].filter(Boolean).join('\n')
        const factoredCustomer = row.customerId ? customerById.get(row.customerId)?.billingMethod === 'FACTOR' : false
        if (row.factored || factoredCustomer) {
          return <span className="tms-muted" title={`Not used — factored (OTR)${tip ? `\n${tip}` : ''}`}>{to[0] ?? '—'}{to.length > 1 ? ` +${to.length - 1}` : ''}</span>
        }
        if (to.length === 0) return <TmsBadge tone="red" title="This customer has no AP e-mail on file">No AP email</TmsBadge>
        return <span title={tip}>{to[0]}{to.length > 1 ? ` +${to.length - 1}` : ''}</span>
      }
      case 'via':
        return row.factored
          ? <TmsBadge tone="purple" title="Factored: sent to OTR">OTR</TmsBadge>
          : <TmsBadge tone="blue" title="Invoiced by hand: e-mailed to the customer">Manual</TmsBadge>
      case 'balance':
        return <span className="font-medium">{formatCents(row.balanceCents)}</span>
      case 'status':
        if (row.shortPaid) return <TmsBadge tone="orange">Short paid {formatCents(row.balanceCents)} open</TmsBadge>
        if (row.status === 'READY' && row.reasons.length > 0) {
          return <span className="flex items-center gap-1"><TmsBadge tone="red">Blocked</TmsBadge><span style={{ color: 'var(--tms-badge-red)' }}>{row.reasons.join('; ')}</span></span>
        }
        if (row.status === 'READY' && row.invoiceId) return <TmsBadge tone="orange">Draft — not sent</TmsBadge>
        return <TmsBadge tone={row.status === 'PAID' ? 'green' : row.status === 'INVOICED' ? 'blue' : 'gray'}>{AR_QUEUE_STATUS_LABEL[row.status]}</TmsBadge>
      case 'sent':
        if (!row.invoiceId) return <span className="tms-muted">—</span>
        return row.sentAt
          ? <span title={row.sentTo ?? undefined}>✓ {formatDay(row.sentAt)}{row.sentCount > 1 ? ` (${row.sentCount}×)` : ''}</span>
          : <TmsBadge tone="orange">Not sent</TmsBadge>
      case 'pastDue': {
        if (!invoiced || !row.dueAt) return <span className="tms-muted">—</span>
        const chip = agingChipFor(row.dueAt, asOf)
        return <TmsBadge tone={chip.late ? 'red' : 'gray'}>{chip.label}</TmsBadge>
      }
      case 'actions': {
        const inv = row.invoice
        const view = inv
          ? <Link className="tms-icon-btn tms-icon-btn-plain" to={`/tms/invoicing/invoices/${inv.id}`} aria-label={`View or edit invoice ${inv.number}`} title="View / edit"><Eye size={15} /></Link>
          : null
        if (ready && !inv) {
          return (
            <TmsButton size="sm" aria-label={`Generate invoice for ${row.shipmentNumber ?? row.orderId}`}
              disabled={busy || row.reasons.length > 0 || !canRelease} title={canRelease ? undefined : BILLING_GRANT_MESSAGE} onClick={() => onGenerate(row)}>
              Generate
            </TmsButton>
          )
        }
        if (!inv) return null
        const more = (options: Array<[string, string, () => void]>) => options.length === 0 ? null : (
          <TmsSelect aria-label={`More actions for invoice ${inv.number}`} value="" disabled={busy} className="w-12"
            onChange={(e) => { options.find(([k]) => k === e.target.value)?.[2](); e.target.value = '' }}>
            <option value="">…</option>
            {options.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </TmsSelect>
        )
        if (ready) {
          return (
            <span className="flex items-center justify-end gap-1 whitespace-nowrap">
              {view}
              {row.factored
                ? <TmsButton size="sm" aria-label={`Send invoice ${inv.number} to OTR`} disabled={busy || !canRelease} onClick={() => onReview([inv])}>Send to OTR</TmsButton>
                : <TmsButton size="sm" variant="primary" aria-label={`Send invoice ${inv.number}`} disabled={busy || !canRelease} onClick={() => onReview([inv])}>Send</TmsButton>}
              {more(row.factored ? [] : [['factor', 'Send to factor instead', () => onFactor(inv)]])}
            </span>
          )
        }
        if (status === 'PAID') return <span className="flex justify-end">{view}</span>
        return (
          <span className="flex items-center justify-end gap-1 whitespace-nowrap">
            {view}
            <TmsButton variant="ghost" size="sm" aria-label={`Receive payment for invoice ${inv.number}`} disabled={busy} onClick={() => onPayment(inv)}>Receive payment</TmsButton>
            {more([
              ...(row.factored ? [] : [['resend', 'Resend', () => onReview([inv])] as [string, string, () => void]]),
              ...(canVoid ? [['void', 'Void', () => onVoid(inv)] as [string, string, () => void]] : []),
            ])}
          </span>
        )
      }
      default:
        return columns.find((c) => c.key === key)?.text(row) ?? null
    }
  }

  // Drafts (auto-generated, not sent) ticked in Ready to invoice: the review carousel's batch.
  const selectedDrafts = rows.filter((row) => row.invoice && selected.includes(row.orderId)).map((row) => row.invoice as InvoiceRecord)
  const actions = (
    <>
      {groupControl}
      {ready && (
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
            variant="primary"
            aria-label="Review and send selected invoices"
            disabled={busy || !canRelease || selectedDrafts.length === 0}
            onClick={() => onReview(selectedDrafts)}
          >
            Review &amp; send{selectedDrafts.length ? ` (${selectedDrafts.length})` : ''}
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
      )}
      {status === 'PAID' && (
        <>
          <TmsSelect aria-label="Invoice month" value={month} onChange={(e) => onMonth(e.target.value)}>
            {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
          </TmsSelect>
          {paidLoading && <span className="text-sm tms-muted">Loading…</span>}
        </>
      )}
    </>
  )

  const totals = groupTotals(rows)
  const kpis = [
    { label: ready ? 'Shipments' : 'Invoices', value: totals.count },
    { label: ready ? 'To invoice' : 'Amount', value: formatCents(totals.amountCents) },
    ...(invoiced
      ? [
        { label: 'Open balance', value: formatCents(totals.balanceCents) },
        { label: 'Past due', value: rows.filter((r) => (r.daysPastDue ?? 0) > 0).length, tone: 'bad' as const },
        { label: 'Short paid', value: rows.filter((r) => r.shortPaid).length, tone: 'warn' as const },
        { label: 'Not sent', value: rows.filter((r) => !r.sentAt).length, tone: 'warn' as const },
      ]
      : []),
    ...(ready ? [{ label: 'Blocked', value: rows.filter((r) => r.reasons.length > 0).length, tone: 'warn' as const }] : []),
  ]

  const gridId = ready ? 'ar-queue-ready' : invoiced ? 'ar-queue-invoiced' : 'ar-queue-paid'
  return view<ArQueueRow>({
    actions,
    banner,
    grid: {
      gridId,
      label: AR_QUEUE_STATUS_LABEL[status],
      columns,
      rows,
      rowKey: (row) => row.key,
      renderCell,
      empty: ready
        ? 'Nothing released is waiting to be invoiced.'
        : invoiced ? 'No invoice has an open balance.' : `Nothing was collected in ${monthLabel(month)}.`,
      kpis,
      group: groupBy === 'none' ? undefined : {
        keyOf: (row) => groupKeyOf(row, groupBy),
        order: (shown) => orderByGroup(shown, groupBy),
        header: (key, shown) => {
          const t = groupTotals(shown)
          return (
            <span className="flex items-center gap-3" data-testid="ar-group-head">
              <strong>{key}</strong>
              <span className="tms-muted">{t.count} {ready ? 'shipment' : 'invoice'}{t.count === 1 ? '' : 's'}</span>
              <span>{formatCents(t.amountCents)}</span>
              {invoiced && <span className="tms-muted">{formatCents(t.balanceCents)} open</span>}
            </span>
          )
        },
      },
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
  errorBanner, aging, onCsv, customerById, statementSelected, onStatementSelect, onStatement, onBulkStatements, busy,
}: {
  errorBanner: ReactNode
  aging: AgingSummary
  onCsv: () => void
  customerById: Map<string, CustomerRecord>
  statementSelected: string[]
  onStatementSelect: (ids: string[]) => void
  onStatement: (customerId: string, customerName: string) => void
  onBulkStatements: () => void
  busy: boolean
}): ListView {
  type Row = AgingSummary['byCustomer'][number]
  const columns: Array<Col<Row>> = [
    { key: 'select', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 32 },
    { key: 'customer', header: 'Customer', group: 'Customer', text: (row) => row.customerName || row.customerId },
    ...AR_AGING_BUCKETS.map((b) => moneyCol<Row>(b, AR_AGING_BUCKET_LABEL[b], (row) => row.byBucket[b], 'Buckets')),
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
    {
      key: 'lastStatement', header: 'Last statement', group: 'Customer',
      text: (row) => formatDay(customerById.get(row.customerId)?.agingStatementSentAt ?? null) || '—',
      sortValue: (row) => customerById.get(row.customerId)?.agingStatementSentAt ?? '',
    },
    { key: 'statement', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 150 },
  ]
  const renderCell = (row: Row, key: string): ReactNode => {
    if (key === 'select') {
      return (
        <input
          type="checkbox"
          aria-label={`Select ${row.customerName || row.customerId}`}
          checked={statementSelected.includes(row.customerId)}
          onChange={() => onStatementSelect(statementSelected.includes(row.customerId)
            ? statementSelected.filter((id) => id !== row.customerId)
            : [...statementSelected, row.customerId])}
        />
      )
    }
    if (key === 'statement') {
      return (
        <TmsButton size="sm" aria-label={`Email aging report to ${row.customerName || row.customerId}`} disabled={busy}
          onClick={() => onStatement(row.customerId, row.customerName || row.customerId)}>
          <Mail size={12} /> Email aging report
        </TmsButton>
      )
    }
    return undefined
  }

  return view<Row>({
    actions: (
      <>
        <TmsButton aria-label="Email aging reports to selected" disabled={busy || statementSelected.length === 0} onClick={onBulkStatements}>
          <Mail size={14} /> Email aging reports{statementSelected.length ? ` (${statementSelected.length})` : ''}
        </TmsButton>
        <TmsButton aria-label="Download aging CSV" onClick={onCsv}>
          <Download size={14} /> CSV
        </TmsButton>
      </>
    ),
    banner: (
      <>
        {errorBanner}
        <p className="text-sm tms-muted">Aged from the invoice date. Email aging report previews the statement and the e-mail before anything is sent.</p>
      </>
    ),
    grid: {
      gridId: 'ar-aging',
      label: 'Aging by customer',
      columns,
      rows: aging.byCustomer,
      rowKey: (row) => row.customerId,
      renderCell,
      empty: 'Nothing is owed.',
    },
  })
}
