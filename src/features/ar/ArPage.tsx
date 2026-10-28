/**
 * `/ar` — the accounts-receivable desk (spec §3.6, §6.6; `TMS_DESIGN` §4.12).
 *
 * Six tabs that follow one order's money from delivered to banked: what is waiting on
 * paperwork, what is ready to bill, what is owed, what was collected, every cash row, and
 * the aging behind all of it. Every number on the page is integer cents formatted once,
 * by `formatCents`; the deciding lives in `arViews.ts` and `@/lib/arAging`.
 *
 * On dev, SES is denied: an invoice e-mail comes back NOT_SENT with the refusal and a
 * signed download. The page reports exactly that and never claims a send that did not
 * happen — a false "sent" here is a customer who never got their bill.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Filter, Mail, RefreshCw, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
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
import { cn } from '@/lib/utils'
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

const TH = 'px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-2 align-top'
const MONEY = 'px-2 py-2 text-right tabular-nums align-top'

export function ArPage() {
  // One clock for the whole page: the chips, the buckets and the CSV all answer as of the
  // same day, so a row cannot read "Current" next to a 1–30 column it was counted in.
  const [asOf] = useState(() => chicagoDateStr(new Date()))

  const [tab, setTab] = useState<ArTabKey>('to-invoice')
  const [dialog, setDialog] = useState<ArDialog | null>(null)
  const [busy, setBusy] = useState(false)

  const unbilled = useArWorklist('UNBILLED')
  const docsNeeded = useArWorklist('DOCS_NEEDED')
  // Invoiced-but-unpaid orders carry the shipments the open invoices were raised against;
  // that pairing is the only way to measure delivery → invoice.
  const invoiced = useArWorklist('UNPAID')
  const open = useOpenInvoices()
  const { customers } = useDirectory()
  const { items: factoringItems } = useFactoringItems()

  const [selected, setSelected] = useState<string[]>([])
  /** What the last batch generated, so "Batch e-mail" bills exactly those invoices. */
  const [justGenerated, setJustGenerated] = useState<string[]>([])

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
   * A DOCS_NEEDED order whose freight has not moved yet is not a paperwork problem —
   * nobody can upload a POD for it. The tab is the chase list: delivered, or a customer
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
    batchGenerateInvoices({ orderIds: selected })
      .then(({ results }) => {
        const made = results.flatMap((r) => (r.invoiceId ? [r.invoiceId] : []))
        const failed = results.filter((r) => r.error)
        setJustGenerated(made)
        setSelected([])
        if (made.length > 0) toast.success(`${made.length} invoice${made.length === 1 ? '' : 's'} generated`)
        for (const f of failed) toast.error(`${f.orderId}: ${f.error ?? 'refused'}`)
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
  const loading = unbilled.loading || docsNeeded.loading || open.loading

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Wallet size={18} />
        <h1 className="text-lg font-semibold">AR</h1>
        <Badge variant="outline">{formatCents(open.aging.totalCents)} open</Badge>
        {open.aging.lateCents > 0 && (
          <Badge variant="destructive">{formatCents(open.aging.lateCents)} late</Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-9 w-9"
          aria-label="Refresh AR"
          onClick={() => void refreshAll()}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </Button>
      </header>

      <nav role="tablist" aria-label="AR views" className="flex gap-1 overflow-x-auto border-b border-border px-5">
        {AR_TABS.map((t) => (
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
        {tab === 'to-invoice' && (
          <ToInvoiceTab
            rows={unbilled.rows}
            customersById={customersById}
            selected={selected}
            justGenerated={justGenerated}
            busy={busy}
            onSelect={setSelected}
            onGenerate={(row) => setDialog({ kind: 'generate', orderId: row.orderId, shipmentNumber: row.shipmentNumber })}
            onBatchGenerate={runBatchGenerate}
            onBatchEmail={runBatchEmail}
          />
        )}

        {tab === 'docs-needed' && <DocsNeededTab rows={docsNeededRows} />}

        {tab === 'unpaid' && (
          <UnpaidTab
            invoices={unpaidRows}
            allInvoices={open.invoices}
            filters={unpaidFilters}
            showFilters={showFilters}
            asOf={asOf}
            busy={busy}
            factorByItemId={factorByItemId}
            onToggleFilters={() => setShowFilters((s) => !s)}
            onFilters={setUnpaidFilters}
            onEmail={(inv) => setDialog({ kind: 'email', invoiceId: inv.id })}
            onPayment={(inv) => setDialog({
              kind: 'payment',
              customerId: inv.customerId,
              customerName: inv.customerName ?? '',
              invoiceId: inv.id,
            })}
            onFactor={(inv) => setDialog({ kind: 'factor', invoiceId: inv.id })}
            onVoid={(inv) => setDialog({ kind: 'void', invoice: inv })}
          />
        )}

        {tab === 'paid' && (
          <PaidTab
            invoices={paidInvoices}
            months={months}
            month={month}
            loading={paidLoading}
            onMonth={(ym) => { setPaidLoading(true); setMonth(ym) }}
          />
        )}

        {tab === 'payments' && (
          <PaymentsTab
            customers={customers}
            customerId={arCustomerId}
            payments={customerAr.payments}
            openCents={customerAr.openCents}
            unappliedCents={customerAr.unappliedCents}
            loading={customerAr.loading}
            busy={busy}
            onCustomer={setArCustomerId}
            onPayment={(customerId, customerName) => setDialog({ kind: 'payment', customerId, customerName })}
            onCredit={(customerId, customerName) => setDialog({ kind: 'credit', customerId, customerName })}
            onReverse={(payment) => setDialog({ kind: 'reverse', payment })}
          />
        )}

        {tab === 'aging' && (
          <AgingTab
            aging={open.aging}
            uninvoicedCents={uninvoiced.reduce((sum, r) => sum + r.revenueCents, 0)}
            uninvoicedCount={uninvoiced.length}
            avgDaysToInvoice={lagDays}
            avgDaysToPay={avgDaysToPay(paidInvoices)}
            paidMonthLabel={monthLabel(month)}
            onCsv={downloadAgingCsv}
          />
        )}
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
          description="Voiding reopens the order for a fresh invoice and leaves this one on the record. It cannot be undone."
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
    </div>
  )
}

/* ── To invoice ──────────────────────────────────────────────────────────── */

function ToInvoiceTab({
  rows, customersById, selected, justGenerated, busy, onSelect, onGenerate, onBatchGenerate, onBatchEmail,
}: {
  rows: ArWorklistRow[]
  customersById: Map<string, CustomerRecord>
  selected: string[]
  justGenerated: string[]
  busy: boolean
  onSelect: (ids: string[]) => void
  onGenerate: (row: ArWorklistRow) => void
  onBatchGenerate: () => void
  onBatchEmail: () => void
}) {
  const toggle = (orderId: string) => {
    onSelect(selected.includes(orderId) ? selected.filter((id) => id !== orderId) : [...selected, orderId])
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {selected.length} selected{selected.length > BATCH_GENERATE_LIMIT ? ` — ${BATCH_GENERATE_LIMIT} at a time` : ''}
        </span>
        <Button
          size="sm"
          aria-label="Batch generate invoices"
          disabled={busy || selected.length === 0 || selected.length > BATCH_GENERATE_LIMIT}
          onClick={onBatchGenerate}
        >
          Batch generate
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-label="Batch e-mail generated invoices"
          disabled={busy || justGenerated.length === 0}
          onClick={onBatchEmail}
        >
          <Mail size={14} className="mr-1" /> Batch e-mail ({justGenerated.length})
        </Button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH} scope="col"><span className="sr-only">Select</span></th>
            <th className={TH} scope="col">Shipment</th>
            <th className={TH} scope="col">Customer</th>
            <th className={TH} scope="col">Bill-to</th>
            <th className={TH} scope="col">Delivered</th>
            <th className={cn(TH, 'text-right')} scope="col">Revenue</th>
            <th className={TH} scope="col">Docs</th>
            <th className={TH} scope="col"><span className="sr-only">Generate</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={8} className="py-8 text-center text-sm text-muted-foreground">Nothing is waiting to be billed.</td></tr>
          )}
          {rows.map((row) => {
            const ready = row.reasons.length === 0
            return (
              <tr key={row.orderId} className="border-b border-border/60">
                <td className={TD}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.shipmentNumber ?? row.orderId}`}
                    checked={selected.includes(row.orderId)}
                    disabled={!ready}
                    onChange={() => toggle(row.orderId)}
                  />
                </td>
                <td className={TD}>
                  <Link className="text-primary hover:underline" to={`/shipments/${row.shipmentId}`}>
                    {row.shipmentNumber ?? row.shipmentId}
                  </Link>
                </td>
                <td className={TD}>{row.customerName || '—'}</td>
                <td className={TD}>{billToLabel(customersById.get(row.customerId), row.billToId)}</td>
                <td className={TD}>{row.deliveredAt ? formatDay(row.deliveredAt) : 'Not delivered'}</td>
                <td className={MONEY}>{formatCents(row.revenueCents)}</td>
                <td className={TD}>
                  {row.docsReady
                    ? <span>{row.docsOverride ? 'Override' : '✓'}</span>
                    : <span className="text-destructive">{row.docsMissing.join(', ') || 'Missing'}</span>}
                  {!ready && (
                    <ul className="mt-1 space-y-0.5 text-xs text-destructive">
                      {row.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                    </ul>
                  )}
                </td>
                <td className={cn(TD, 'text-right')}>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Generate invoice for ${row.shipmentNumber ?? row.orderId}`}
                    disabled={busy || !ready}
                    onClick={() => onGenerate(row)}
                  >
                    Generate
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ── Docs needed ─────────────────────────────────────────────────────────── */

function DocsNeededTab({ rows }: { rows: ArWorklistRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className={TH} scope="col">Shipment</th>
          <th className={TH} scope="col">Customer</th>
          <th className={TH} scope="col">Delivered</th>
          <th className={cn(TH, 'text-right')} scope="col">Revenue</th>
          <th className={TH} scope="col">Still missing</th>
          <th className={TH} scope="col"><span className="sr-only">Documents</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={6} className="py-8 text-center text-sm text-muted-foreground">No shipment is waiting on paperwork.</td></tr>
        )}
        {rows.map((row) => (
          <tr key={row.orderId} className="border-b border-border/60">
            <td className={TD}>
              <Link className="text-primary hover:underline" to={`/shipments/${row.shipmentId}?tab=documents`}>
                {row.shipmentNumber ?? row.shipmentId}
              </Link>
            </td>
            <td className={TD}>{row.customerName || '—'}</td>
            <td className={TD}>
              {row.deliveredAt ? formatDay(row.deliveredAt) : row.order.invoiceEarly ? 'Bills early' : 'Not delivered'}
            </td>
            <td className={MONEY}>{formatCents(row.revenueCents)}</td>
            <td className={TD}>
              {row.docsMissing.length > 0
                ? <span className="text-destructive">{row.docsMissing.join(', ')}</span>
                : <span className="text-muted-foreground">Nothing — ready for review</span>}
            </td>
            <td className={cn(TD, 'text-right')}>
              <Button asChild size="sm" variant="outline">
                <Link
                  aria-label={`Open documents for ${row.shipmentNumber ?? row.shipmentId}`}
                  to={`/shipments/${row.shipmentId}?tab=documents`}
                >
                  Documents
                </Link>
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/* ── Unpaid ──────────────────────────────────────────────────────────────── */

function UnpaidTab({
  invoices, allInvoices, filters, showFilters, asOf, busy, factorByItemId,
  onToggleFilters, onFilters, onEmail, onPayment, onFactor, onVoid,
}: {
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
}) {
  const active = (filters.customerId ? 1 : 0) + (filters.bucket ? 1 : 0) + (filters.factored ? 1 : 0)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" aria-label="Filter unpaid invoices" onClick={onToggleFilters}>
          <Filter size={14} className="mr-1" /> Filters
          {active > 0 && <Badge className="ml-1">{active}</Badge>}
        </Button>
        <span className="text-sm text-muted-foreground">{invoices.length} invoices</span>
      </div>

      {showFilters && (
        <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-muted/20 px-3 py-2 sm:grid-cols-3">
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Customer</Label>
            <select
              aria-label="Filter customer"
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={filters.customerId}
              onChange={(e) => onFilters({ ...filters, customerId: e.target.value })}
            >
              <option value="">All</option>
              {invoiceCustomerOptions(allInvoices).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Aging</Label>
            <select
              aria-label="Filter aging bucket"
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={filters.bucket}
              onChange={(e) => onFilters({ ...filters, bucket: e.target.value as UnpaidFilters['bucket'] })}
            >
              <option value="">All</option>
              {AGING_BUCKETS.map((b) => <option key={b} value={b}>{AGING_BUCKET_LABEL[b]}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Factored</Label>
            <select
              aria-label="Filter factored"
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={filters.factored}
              onChange={(e) => onFilters({ ...filters, factored: e.target.value as UnpaidFilters['factored'] })}
            >
              <option value="">All</option>
              <option value="YES">Factored</option>
              <option value="NO">Not factored</option>
            </select>
          </div>
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH} scope="col">Invoice</th>
            <th className={TH} scope="col">Customer</th>
            <th className={TH} scope="col">Issued</th>
            <th className={TH} scope="col">Due</th>
            <th className={TH} scope="col">Age</th>
            <th className={cn(TH, 'text-right')} scope="col">Total</th>
            <th className={cn(TH, 'text-right')} scope="col">Paid</th>
            <th className={cn(TH, 'text-right')} scope="col">Balance</th>
            <th className={TH} scope="col">Sent</th>
            <th className={TH} scope="col">Factor</th>
            <th className={TH} scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {invoices.length === 0 && (
            <tr><td colSpan={11} className="py-8 text-center text-sm text-muted-foreground">Nothing is owed in this view.</td></tr>
          )}
          {invoices.map((inv) => {
            const chip = agingChipFor(inv.dueAt, asOf)
            const item = inv.factoringItemId ? factorByItemId.get(inv.factoringItemId) : undefined
            const factor = otrStatusLabel(item?.otrStatus) ?? (inv.factoringItemId ? 'In the factoring queue' : null)
            return (
              <tr key={inv.id} className="border-b border-border/60">
                <td className={TD}>
                  <Link className="text-primary hover:underline" to={`/ar/invoices/${inv.id}`}>{inv.number}</Link>
                </td>
                <td className={TD}>{inv.customerName || '—'}</td>
                <td className={TD}>{formatDay(inv.invoiceDate)}</td>
                <td className={TD}>{formatDay(inv.dueAt)}</td>
                <td className={TD}>
                  <Badge variant={chip.late ? 'destructive' : 'outline'} className="text-[10px]">{chip.label}</Badge>
                </td>
                <td className={MONEY}>{formatCents(inv.totalCents)}</td>
                <td className={MONEY}>{formatCents(inv.paidCents)}</td>
                <td className={cn(MONEY, 'font-medium')}>{formatCents(inv.balanceCents)}</td>
                <td className={TD}>{inv.sentCount ? `✓ ${inv.sentCount}` : '—'}</td>
                <td className={TD}>{factor ?? (inv.factored ? 'Factored customer' : '—')}</td>
                <td className={cn(TD, 'whitespace-nowrap text-right')}>
                  <Button size="sm" variant="ghost" aria-label={`E-mail invoice ${inv.number}`} disabled={busy} onClick={() => onEmail(inv)}>E-mail</Button>
                  <Button size="sm" variant="ghost" aria-label={`Receive payment for invoice ${inv.number}`} disabled={busy} onClick={() => onPayment(inv)}>Receive payment</Button>
                  <Button size="sm" variant="ghost" aria-label={`Send invoice ${inv.number} to factor`} disabled={busy} onClick={() => onFactor(inv)}>Send to Factor</Button>
                  <Button size="sm" variant="ghost" aria-label={`Void invoice ${inv.number}`} disabled={busy} onClick={() => onVoid(inv)}>Void</Button>
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

function PaidTab({ invoices, months, month, loading, onMonth }: {
  invoices: InvoiceRecord[]
  months: string[]
  month: string
  loading: boolean
  onMonth: (ym: string) => void
}) {
  const paid = invoices.filter((inv) => inv.status === 'PAID')
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Invoice month</Label>
        <select
          aria-label="Invoice month"
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
            <th className={TH} scope="col">Invoice</th>
            <th className={TH} scope="col">Customer</th>
            <th className={TH} scope="col">Issued</th>
            <th className={TH} scope="col">Paid</th>
            <th className={cn(TH, 'text-right')} scope="col">Total</th>
            <th className={cn(TH, 'text-right')} scope="col">Written off</th>
          </tr>
        </thead>
        <tbody>
          {paid.length === 0 && !loading && (
            <tr><td colSpan={6} className="py-8 text-center text-sm text-muted-foreground">Nothing was collected in {monthLabel(month)}.</td></tr>
          )}
          {paid.map((inv) => (
            <tr key={inv.id} className="border-b border-border/60">
              <td className={TD}>
                <Link className="text-primary hover:underline" to={`/ar/invoices/${inv.id}`}>{inv.number}</Link>
              </td>
              <td className={TD}>{inv.customerName || '—'}</td>
              <td className={TD}>{formatDay(inv.invoiceDate)}</td>
              <td className={TD}>{formatDay(inv.paidAt)}</td>
              <td className={MONEY}>{formatCents(inv.totalCents)}</td>
              <td className={MONEY}>{inv.writtenOffCents ? formatCents(inv.writtenOffCents) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── Payments & credits ──────────────────────────────────────────────────── */

function PaymentsTab({
  customers, customerId, payments, openCents, unappliedCents, loading, busy,
  onCustomer, onPayment, onCredit, onReverse,
}: {
  customers: CustomerRecord[]
  customerId: string | null
  payments: ArPaymentRecord[]
  openCents: number
  unappliedCents: number
  loading: boolean
  busy: boolean
  onCustomer: (id: string | null) => void
  onPayment: (customerId: string, customerName: string) => void
  onCredit: (customerId: string, customerName: string) => void
  onReverse: (payment: ArPaymentRecord) => void
}) {
  const customer = customers.find((c) => c.id === customerId) ?? null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Customer</Label>
        <select
          aria-label="Choose customer"
          className="h-8 min-w-56 rounded-md border border-input bg-background px-2 text-sm"
          value={customerId ?? ''}
          onChange={(e) => onCustomer(e.target.value || null)}
        >
          <option value="">Choose a customer…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {customer && (
          <>
            <Badge variant="outline">{formatCents(openCents)} open</Badge>
            <Badge variant="outline">{formatCents(unappliedCents)} unapplied</Badge>
            <Button
              size="sm"
              aria-label="Receive payment"
              disabled={busy}
              onClick={() => onPayment(customer.id, customer.name)}
            >
              Receive payment
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-label="New credit"
              disabled={busy}
              onClick={() => onCredit(customer.id, customer.name)}
            >
              New credit
            </Button>
          </>
        )}
      </div>

      {!customer && <p className="text-sm text-muted-foreground">Choose a customer to see their cash rows.</p>}

      {customer && (
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
              <th className={TH} scope="col"><span className="sr-only">Reverse</span></th>
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 && !loading && (
              <tr><td colSpan={8} className="py-8 text-center text-sm text-muted-foreground">No cash has been posted for {customer.name}.</td></tr>
            )}
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-border/60">
                <td className={TD}>{AR_PAYMENT_KIND_LABEL[p.kind]}</td>
                <td className={TD}>{formatDay(p.receivedAt)}</td>
                <td className={TD}>{p.method ? AR_PAYMENT_METHOD_LABEL[p.method] : '—'}</td>
                <td className={TD}>{p.reference || '—'}</td>
                <td className={MONEY}>{formatCents(p.amountCents)}</td>
                <td className={MONEY}>{formatCents(p.appliedCents)}</td>
                <td className={MONEY}>{formatCents(p.unappliedCents)}</td>
                <td className={cn(TD, 'text-right')}>
                  {p.kind !== 'REVERSAL' && !p.reversedByPaymentId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Reverse ${AR_PAYMENT_KIND_LABEL[p.kind].toLowerCase()} of ${formatCents(p.amountCents)}`}
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

function AgingTab({
  aging, uninvoicedCents, uninvoicedCount, avgDaysToInvoice: lag, avgDaysToPay: dso, paidMonthLabel, onCsv,
}: {
  aging: AgingSummary
  uninvoicedCents: number
  uninvoicedCount: number
  avgDaysToInvoice: number | null
  avgDaysToPay: number | null
  paidMonthLabel: string
  onCsv: () => void
}) {
  return (
    <div className="space-y-4">
      <AgingStrip
        openCents={aging.totalCents}
        lateCents={aging.lateCents}
        deliveredNotInvoicedCents={uninvoicedCents}
        deliveredNotInvoicedCount={uninvoicedCount}
        avgDaysToInvoice={lag}
        avgDaysToPay={dso}
        paidMonthLabel={paidMonthLabel}
      />

      <div className="flex justify-end">
        <Button variant="outline" size="sm" aria-label="Download aging CSV" onClick={onCsv}>
          <Download size={14} className="mr-1" /> CSV
        </Button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH} scope="col">Customer</th>
            {AGING_BUCKETS.map((b) => <th key={b} className={cn(TH, 'text-right')} scope="col">{AGING_BUCKET_LABEL[b]}</th>)}
            <th className={cn(TH, 'text-right')} scope="col">Total</th>
            <th className={cn(TH, 'text-right')} scope="col">Late</th>
            <th className={cn(TH, 'text-right')} scope="col">Oldest</th>
          </tr>
        </thead>
        <tbody>
          {aging.byCustomer.length === 0 && (
            <tr><td colSpan={9} className="py-8 text-center text-sm text-muted-foreground">Nothing is owed.</td></tr>
          )}
          {aging.byCustomer.map((row) => (
            <tr key={row.customerId} className="border-b border-border/60">
              <td className={TD}>{row.customerName || row.customerId}</td>
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
