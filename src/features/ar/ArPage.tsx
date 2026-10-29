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
import {
  TmsBadge, TmsButton, TmsCard, TmsField, TmsSelect, TmsListPage,
  type ColumnDef, type TmsListPageProps, type TmsTabGroup,
} from '@/features/tms/kit'
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
  AR_PAYMENT_KIND_LABEL, AR_PAYMENT_METHOD_LABEL, AR_TABS, BATCH_GENERATE_LIMIT, EMPTY_UNPAID_FILTERS,
  agingChipFor, applyUnpaidFilters, billToLabel, formatDay, invoiceCustomerOptions, lastThreeMonths, monthLabel,
  type ArTabKey, type UnpaidFilters,
} from './arViews'
import { CreditMemoDialog } from './components/CreditMemoDialog'
import { EmailInvoiceDialog } from './components/EmailInvoiceDialog'
import { GenerateInvoiceDialog } from './components/GenerateInvoiceDialog'
import { ReasonDialog } from './components/ReasonDialog'
import { ReceivePaymentDialog } from './components/ReceivePaymentDialog'
import { SendToFactorDialog } from './components/SendToFactorDialog'
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

export function ArPage({ viewTabs }: { viewTabs?: TmsTabGroup } = {}) {
  // One clock for the whole page: the chips, the buckets and the CSV all answer as of the
  // same day, so a row cannot read "Current" next to a 1–30 column it was counted in.
  const [asOf] = useState(() => chicagoDateStr(new Date()))

  const [tab, setTab] = useState<ArTabKey>('to-invoice')
  const [dialog, setDialog] = useState<ArDialog | null>(null)
  const [busy, setBusy] = useState(false)

  const unbilled = useArWorklist('UNBILLED')
  const docsNeeded = useArWorklist('DOCS_NEEDED')
  // Invoiced-but-unpaid shipments carry the ones the open invoices were raised against;
  // that pairing is the only way to measure delivery → invoice.
  const invoiced = useArWorklist('UNPAID')
  const open = useOpenInvoices()
  const { customers } = useDirectory()
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

  const counts: Record<ArTabKey, number> = {
    'to-invoice': unbilled.rows.length,
    'docs-needed': docsNeededRows.length,
    unpaid: open.invoices.length,
    paid: paidInvoices.filter((inv) => inv.status === 'PAID').length,
    payments: customerAr.payments.length,
    aging: open.aging.byCustomer.length,
  }

  const error = unbilled.error ?? docsNeeded.error ?? open.error ?? customerAr.error

  const chrome = {
    title: 'Invoicing',
    viewTabs,
    quickTabs: {
      tabs: AR_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] })),
      active: tab,
      onSelect: (key: string) => setTab(key as ArTabKey),
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
      onSelect: setSelected,
      onGenerate: (row) => setDialog({ kind: 'generate', orderId: row.orderId, shipmentNumber: row.shipmentNumber }),
      onBatchGenerate: runBatchGenerate,
      onBatchEmail: runBatchEmail,
    })
    : tab === 'docs-needed' ? docsNeededView({ banner: errorBanner, rows: docsNeededRows })
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
      <TmsListPage<never> {...chrome} {...current} />

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

function toInvoiceView({
  banner, rows, customersById, selected, justGenerated, busy, onSelect, onGenerate, onBatchGenerate, onBatchEmail,
}: {
  banner: ReactNode
  rows: ArWorklistRow[]
  customersById: Map<string, CustomerRecord>
  selected: string[]
  justGenerated: string[]
  busy: boolean
  onSelect: (ids: string[]) => void
  onGenerate: (row: ArWorklistRow) => void
  onBatchGenerate: () => void
  onBatchEmail: () => void
}): ListView {
  const toggle = (orderId: string) => {
    onSelect(selected.includes(orderId) ? selected.filter((id) => id !== orderId) : [...selected, orderId])
  }

  const columns: ColumnDef<ArWorklistRow>[] = [
    {
      key: 'select',
      header: '',
      width: 36,
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`Select ${row.shipmentNumber ?? row.orderId}`}
          checked={selected.includes(row.orderId)}
          disabled={row.reasons.length > 0}
          onChange={() => toggle(row.orderId)}
        />
      ),
    },
    {
      key: 'shipment',
      header: 'SHIPMENT',
      render: (row) => <Link to={`/tms/shipments/${row.shipmentId}`}>{row.shipmentNumber ?? row.shipmentId}</Link>,
    },
    { key: 'customer', header: 'CUSTOMER', render: (row) => row.customerName || '—' },
    {
      key: 'billTo',
      header: 'BILL-TO',
      render: (row) => billToLabel(customersById.get(row.customerId), row.billToId),
    },
    {
      key: 'delivered',
      header: 'DELIVERED',
      render: (row) => (row.deliveredAt ? formatDay(row.deliveredAt) : 'Not delivered'),
    },
    { key: 'revenue', header: 'REVENUE', render: (row) => <span className={RIGHT}>{formatCents(row.revenueCents)}</span> },
    {
      key: 'docs',
      header: 'DOCS',
      render: (row) => (
        <>
          {row.docsReady
            ? <span>✓</span>
            : <span style={{ color: 'var(--tms-badge-red)' }}>{row.docsMissing.join(', ') || 'Missing'}</span>}
          {row.reasons.length > 0 && (
            <ul className="mt-1 text-xs" style={{ color: 'var(--tms-badge-red)' }}>
              {row.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </>
      ),
    },
    {
      key: 'generate',
      header: '',
      render: (row) => (
        <TmsButton
          size="sm"
          aria-label={`Generate invoice for ${row.shipmentNumber ?? row.orderId}`}
          disabled={busy || row.reasons.length > 0}
          onClick={() => onGenerate(row)}
        >
          Generate
        </TmsButton>
      ),
    },
  ]

  return view<ArWorklistRow>({
    actions: (
      <>
        <span className="text-sm tms-muted">
          {selected.length} selected{selected.length > BATCH_GENERATE_LIMIT ? ` — ${BATCH_GENERATE_LIMIT} at a time` : ''}
        </span>
        <TmsButton
          variant="primary"
          aria-label="Batch generate invoices"
          disabled={busy || selected.length === 0 || selected.length > BATCH_GENERATE_LIMIT}
          onClick={onBatchGenerate}
        >
          Batch generate
        </TmsButton>
        <TmsButton
          aria-label="Batch e-mail generated invoices"
          disabled={busy || justGenerated.length === 0}
          onClick={onBatchEmail}
        >
          <Mail size={14} /> Batch e-mail ({justGenerated.length})
        </TmsButton>
      </>
    ),
    banner,
    columns,
    rows,
    rowKey: (row) => row.orderId,
    page: wholeList(rows.length),
    emptyText: 'Nothing is waiting to be billed.',
  })
}

/* ── Docs needed ─────────────────────────────────────────────────────────── */

function docsNeededView({ banner, rows }: { banner: ReactNode; rows: ArWorklistRow[] }): ListView {
  const columns: ColumnDef<ArWorklistRow>[] = [
    {
      key: 'shipment',
      header: 'SHIPMENT',
      render: (row) => (
        <Link to={`/tms/shipments/${row.shipmentId}?tab=documents`}>{row.shipmentNumber ?? row.shipmentId}</Link>
      ),
    },
    { key: 'customer', header: 'CUSTOMER', render: (row) => row.customerName || '—' },
    {
      key: 'delivered',
      header: 'DELIVERED',
      render: (row) => (
        row.deliveredAt ? formatDay(row.deliveredAt) : row.order.invoiceEarly ? 'Bills early' : 'Not delivered'
      ),
    },
    { key: 'revenue', header: 'REVENUE', render: (row) => <span className={RIGHT}>{formatCents(row.revenueCents)}</span> },
    {
      key: 'missing',
      header: 'STILL MISSING',
      render: (row) => (
        row.docsMissing.length > 0
          ? <span style={{ color: 'var(--tms-badge-red)' }}>{row.docsMissing.join(', ')}</span>
          : <span className="tms-muted">Nothing — ready for review</span>
      ),
    },
    {
      key: 'documents',
      header: '',
      render: (row) => (
        <Link
          className="tms-btn tms-btn-secondary tms-btn-sm"
          aria-label={`Open documents for ${row.shipmentNumber ?? row.shipmentId}`}
          to={`/tms/shipments/${row.shipmentId}?tab=documents`}
        >
          Documents
        </Link>
      ),
    },
  ]

  return view<ArWorklistRow>({
    banner,
    columns,
    rows,
    rowKey: (row) => row.orderId,
    page: wholeList(rows.length),
    emptyText: 'No shipment is waiting on paperwork.',
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

  const columns: ColumnDef<InvoiceRecord>[] = [
    {
      key: 'invoice',
      header: 'INVOICE',
      render: (inv) => <Link to={`/tms/invoicing/invoices/${inv.id}`}>{inv.number}</Link>,
    },
    { key: 'customer', header: 'CUSTOMER', render: (inv) => inv.customerName || '—' },
    { key: 'issued', header: 'ISSUED', render: (inv) => formatDay(inv.invoiceDate) },
    { key: 'due', header: 'DUE', render: (inv) => formatDay(inv.dueAt) },
    {
      key: 'age',
      header: 'AGE',
      render: (inv) => {
        const chip = agingChipFor(inv.dueAt, asOf)
        return <TmsBadge tone={chip.late ? 'red' : 'gray'}>{chip.label}</TmsBadge>
      },
    },
    { key: 'total', header: 'TOTAL', render: (inv) => <span className={RIGHT}>{formatCents(inv.totalCents)}</span> },
    { key: 'paid', header: 'PAID', render: (inv) => <span className={RIGHT}>{formatCents(inv.paidCents)}</span> },
    {
      key: 'balance',
      header: 'BALANCE',
      render: (inv) => <span className={`${RIGHT} font-medium`}>{formatCents(inv.balanceCents)}</span>,
    },
    { key: 'sent', header: 'SENT', render: (inv) => (inv.sentCount ? `✓ ${inv.sentCount}` : '—') },
    {
      key: 'factor',
      header: 'FACTOR',
      render: (inv) => {
        const item = inv.factoringItemId ? factorByItemId.get(inv.factoringItemId) : undefined
        const factor = otrStatusLabel(item?.otrStatus) ?? (inv.factoringItemId ? 'In the factoring queue' : null)
        return factor ?? (inv.factored ? 'Factored customer' : '—')
      },
    },
    {
      key: 'actions',
      header: '',
      render: (inv) => (
        <span className="flex justify-end gap-1 whitespace-nowrap">
          <TmsButton variant="ghost" size="sm" aria-label={`E-mail invoice ${inv.number}`} disabled={busy} onClick={() => onEmail(inv)}>E-mail</TmsButton>
          <TmsButton variant="ghost" size="sm" aria-label={`Receive payment for invoice ${inv.number}`} disabled={busy} onClick={() => onPayment(inv)}>Receive payment</TmsButton>
          <TmsButton variant="ghost" size="sm" aria-label={`Send invoice ${inv.number} to factor`} disabled={busy} onClick={() => onFactor(inv)}>Send to Factor</TmsButton>
          <TmsButton variant="ghost" size="sm" aria-label={`Void invoice ${inv.number}`} disabled={busy} onClick={() => onVoid(inv)}>Void</TmsButton>
        </span>
      ),
    },
  ]

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
    columns,
    rows: invoices,
    rowKey: (inv) => inv.id,
    page: wholeList(invoices.length),
    emptyText: 'Nothing is owed in this view.',
    onClearFilters: () => onFilters(EMPTY_UNPAID_FILTERS),
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
  const columns: ColumnDef<InvoiceRecord>[] = [
    {
      key: 'invoice',
      header: 'INVOICE',
      render: (inv) => <Link to={`/tms/invoicing/invoices/${inv.id}`}>{inv.number}</Link>,
    },
    { key: 'customer', header: 'CUSTOMER', render: (inv) => inv.customerName || '—' },
    { key: 'issued', header: 'ISSUED', render: (inv) => formatDay(inv.invoiceDate) },
    { key: 'paid', header: 'PAID', render: (inv) => formatDay(inv.paidAt) },
    { key: 'total', header: 'TOTAL', render: (inv) => <span className={RIGHT}>{formatCents(inv.totalCents)}</span> },
    {
      key: 'writtenOff',
      header: 'WRITTEN OFF',
      render: (inv) => <span className={RIGHT}>{inv.writtenOffCents ? formatCents(inv.writtenOffCents) : '—'}</span>,
    },
  ]

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
    columns,
    rows: paid,
    rowKey: (inv) => inv.id,
    page: wholeList(paid.length),
    emptyText: `Nothing was collected in ${monthLabel(month)}.`,
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
  const columns: ColumnDef<ArPaymentRecord>[] = [
    { key: 'kind', header: 'KIND', render: (p) => AR_PAYMENT_KIND_LABEL[p.kind] },
    { key: 'date', header: 'DATE', render: (p) => formatDay(p.receivedAt) },
    { key: 'method', header: 'METHOD', render: (p) => (p.method ? AR_PAYMENT_METHOD_LABEL[p.method] : '—') },
    { key: 'reference', header: 'REFERENCE', render: (p) => p.reference || '—' },
    { key: 'amount', header: 'AMOUNT', render: (p) => <span className={RIGHT}>{formatCents(p.amountCents)}</span> },
    { key: 'applied', header: 'APPLIED', render: (p) => <span className={RIGHT}>{formatCents(p.appliedCents)}</span> },
    { key: 'unapplied', header: 'UNAPPLIED', render: (p) => <span className={RIGHT}>{formatCents(p.unappliedCents)}</span> },
    {
      key: 'reverse',
      header: '',
      render: (p) => (
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
      ),
    },
  ]

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
    columns,
    rows: customer ? payments : [],
    rowKey: (p) => p.id,
    page: wholeList(customer ? payments.length : 0),
    emptyText: customer ? `No cash has been posted for ${customer.name}.` : 'Choose a customer to see their cash rows.',
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
  const columns: ColumnDef<Row>[] = [
    { key: 'customer', header: 'CUSTOMER', render: (row) => row.customerName || row.customerId },
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
    columns,
    rows: aging.byCustomer,
    rowKey: (row) => row.customerId,
    page: wholeList(aging.byCustomer.length),
    emptyText: 'Nothing is owed.',
  })
}
