/**
 * `/tms/payments-received` — Accounting → Payments received (Ryne 2026-11-15): every payment received,
 * all customers, with every credit and debit, in one ledger. It replaced the Receivable list's
 * "Payments & credits" tab, which only ever showed one customer.
 *
 * The "Collected this week / month" figures are the Receivables card's own (`computeArSummary` over
 * the same six months of invoices, by paid date), so this page and the card cannot disagree. The rows
 * below are the cash ledger itself: receipts, credit memos, write-offs and reversals from BCAT, and the
 * Aljex CRED/DEBT memos kept as history.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Download, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsInput, TmsSelect, TmsSummaryChips, type TmsSummaryChip } from '@/features/tms/kit'
import type { DenseColumn } from '@/features/tms/grid/denseGridModel'
import { ArDenseTable } from '@/features/ar/components/ArDenseTable'
import { ReceivePaymentDialog } from '@/features/ar/components/ReceivePaymentDialog'
import { CreditMemoDialog } from '@/features/ar/components/CreditMemoDialog'
import { ReasonDialog } from '@/features/ar/components/ReasonDialog'
import { computeArSummary, divisionKeyOf } from '@/features/ar/arSummary'
import { formatDay, lastMonths, PAID_LOOKBACK_MONTHS } from '@/features/ar/arViews'
import { useCustomerAr } from '@/hooks/useCustomerAr'
import { useDirectory } from '@/hooks/useDirectory'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { graphqlErrorText, listArPayments, listInvoicesByMonth, listShipmentsByNumber, reversePayment } from '@/lib/apiClient'
import { listAljexMemoRows } from '@/lib/paymentsClient'
import { chicagoDateStr } from '@/lib/date'
import { saveBlob } from '@/lib/download'
import { formatCents } from '@/lib/invoiceBuild'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import type { ArPaymentRecord, InvoiceRecord } from '@/types/tms'
import {
  NO_METHOD, RECEIVED_TYPE_LABEL, filterReceived, fromAljexMemo, fromArPayment, monthBounds, nameKey,
  receivedCsv, receivedTotals, withRunningTotal, type ReceivedFilter, type ReceivedRow, type ReceivedType,
} from './paymentsReceived'

type Dialog =
  | { kind: 'payment'; customerId: string; customerName: string }
  | { kind: 'credit'; customerId: string; customerName: string }
  | { kind: 'reverse'; payment: ArPaymentRecord }

/** A PRO's shipment, as far as this page needs it: where its link goes and which division it counts toward. */
interface ShipmentRef { id: string; division: string }

const proOf = (invoiceId: string) => invoiceId.split('-')[0].trim()

/** Date presets for the range picker; every one is whole days. */
function presets(asOf: string): Array<{ key: string; label: string; from: string; to: string }> {
  const month = monthBounds(asOf)
  const d = new Date(`${asOf}T12:00:00Z`)
  const weekStart = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10)
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15)).toISOString().slice(0, 10)
  const last = monthBounds(prev)
  return [
    { key: 'week', label: 'This week', from: weekStart, to: asOf },
    { key: 'month', label: 'This month', from: month.from, to: month.to },
    { key: 'last', label: 'Last month', from: last.from, to: last.to },
    { key: 'year', label: 'This year', from: `${asOf.slice(0, 4)}-01-01`, to: asOf },
    { key: 'all', label: 'All dates', from: '', to: '' },
  ]
}

export function PaymentsReceivedPage() {
  const [asOf] = useState(() => chicagoDateStr(new Date()))
  const [searchParams, setSearchParams] = useSearchParams()
  const customerParam = searchParams.get('customer')
  const [filter, setFilter] = useState<ReceivedFilter>(() => ({
    ...monthBounds(asOf),
    customers: customerParam ? [customerParam] : [],
    types: [],
    methods: [],
    divisions: [],
    unappliedOnly: false,
  }))
  const setCustomer = (id: string | null) => {
    setFilter((f) => ({ ...f, customers: id ? [id] : [] }))
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('customer', id)
      else next.delete('customer')
      return next
    }, { replace: true })
  }

  const { customers } = useDirectory({ locations: false })
  const { divisions } = useOwnershipDivisions()
  const [payments, setPayments] = useState<ArPaymentRecord[]>([])
  const [memos, setMemos] = useState<Awaited<ReturnType<typeof listAljexMemoRows>>>([])
  const [recentPaid, setRecentPaid] = useState<InvoiceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [memoError, setMemoError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)

  const months = useMemo(() => lastMonths(asOf, PAID_LOOKBACK_MONTHS), [asOf])
  const load = useCallback(() => Promise.all([
    listArPayments().then(setPayments),
    listAljexMemoRows().then((rows) => { setMemos(rows); setMemoError(null) })
      .catch((e: unknown) => setMemoError(graphqlErrorText(e) || 'Aljex credit/debit history could not load')),
    // The Receivables card's "Collected" read: the last six months of invoices, by paid date.
    Promise.all(months.map((m) => listInvoicesByMonth(m).catch(() => [] as InvoiceRecord[]))).then((sets) => setRecentPaid(sets.flat())),
  ])
    .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Payments could not load'))
    .finally(() => setLoading(false)), [months])
  useEffect(() => { void load() }, [load])

  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers])
  const customerIdByKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of customers) if (c.name && !m.has(nameKey(c.name))) m.set(nameKey(c.name), c.id)
    return m
  }, [customers])
  const rows: ReceivedRow[] = useMemo(() => {
    const name = (id: string) => customerById.get(id)?.name ?? ''
    const bcat = payments.map((p) => fromArPayment(p, name))
    const aljex = memos.map((m) => fromAljexMemo(m, (n) => customerIdByKey.get(nameKey(n)) ?? null)).filter((r): r is ReceivedRow => r != null)
    return [...bcat, ...aljex].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.id.localeCompare(a.id))
  }, [payments, memos, customerById, customerIdByKey])

  // Rev division: the shipment behind each applied invoice / referenced PRO, looked up by PRO once per page visit.
  const [shipmentsByPro, setShipmentsByPro] = useState<ReadonlyMap<string, ShipmentRef | null>>(() => new Map())
  const asked = useRef(new Set<string>())
  const inRange = useMemo(
    () => filterReceived(rows, { ...filter, types: [], methods: [], divisions: [], unappliedOnly: false }, () => []),
    [rows, filter],
  )
  useEffect(() => {
    const pros = [...new Set(inRange.flatMap((r) => r.invoices.map((i) => proOf(i.invoiceId))))].filter((p) => p && !asked.current.has(p))
    if (pros.length === 0) return
    for (const p of pros) asked.current.add(p)
    const found = new Map<string, ShipmentRef | null>()
    const queue = [...pros]
    const worker = async () => {
      while (queue.length) {
        const pro = queue.shift()!
        try {
          const s = (await listShipmentsByNumber(pro))[0]
          found.set(pro, s ? { id: s.id, division: divisionKeyOf(s) } : null)
        } catch {
          found.set(pro, null)
        }
      }
    }
    // Lookups that land after the page closes still fill the map; nothing else is written.
    void Promise.all(Array.from({ length: Math.min(6, pros.length) }, worker))
      .then(() => setShipmentsByPro((prev) => new Map([...prev, ...found])))
  }, [inRange])
  const divisionsOf = useCallback((row: ReceivedRow) => row.invoices
    .map((i) => shipmentsByPro.get(proOf(i.invoiceId))?.division)
    .filter((d): d is string => !!d), [shipmentsByPro])

  const visible = useMemo(() => filterReceived(rows, filter, divisionsOf), [rows, filter, divisionsOf])
  const oneCustomer = filter.customers.length === 1 ? filter.customers[0] : null
  const ledger = useMemo(() => (oneCustomer ? withRunningTotal(visible) : null), [oneCustomer, visible])
  const customerAr = useCustomerAr(oneCustomer)
  const totals = useMemo(() => receivedTotals(visible), [visible])

  // The Receivables card's figures, narrowed by customer the way the card narrows them.
  const collected = useMemo(() => computeArSummary({
    open: [],
    paid: recentPaid.filter((inv) => filter.customers.length === 0 || filter.customers.includes(inv.customerId)),
    factorByItemId: new Map(),
    shipmentsById: new Map(),
    divisionName: (c) => c ?? '',
    asOf,
  }), [recentPaid, filter.customers, asOf])

  const divisionName = useMemo(() => {
    const m = new Map((divisions ?? []).map((d) => [d.code, d.name]))
    return (code: string) => m.get(code) ?? code
  }, [divisions])
  const divisionOptions = useMemo(() => {
    const keys = new Set<string>()
    for (const ref of shipmentsByPro.values()) if (ref) keys.add(ref.division.split('/')[0])
    for (const d of filter.divisions) keys.add(d)
    return [...keys].sort().map((k) => ({ value: k, label: k === 'NONE' ? 'No division' : divisionName(k) }))
  }, [shipmentsByPro, filter.divisions, divisionName])
  const methodOptions = useMemo(() => [...new Set(rows.map((r) => r.method ?? NO_METHOD))].sort(), [rows])
  const customerOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) if (r.customerId && !seen.has(r.customerId)) seen.set(r.customerId, customerById.get(r.customerId)?.name ?? r.customerName)
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]))
  }, [rows, customerById])

  const runReverse = (payment: ArPaymentRecord, reason: string) => {
    setBusy(true)
    reversePayment({ paymentId: payment.id, reason })
      .then(() => { toast.success('Payment reversed'); setDialog(null); void load(); void customerAr.refresh() })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not reverse the payment'))
      .finally(() => setBusy(false))
  }
  const closeAndRefresh = () => { setDialog(null); void load(); void customerAr.refresh() }

  const range = presets(asOf)
  const activePreset = range.find((p) => p.from === filter.from && p.to === filter.to)?.key ?? 'custom'
  const rangeLabel = activePreset === 'custom'
    ? `${filter.from ? formatDay(filter.from) : 'the start'} – ${filter.to ? formatDay(filter.to) : 'today'}`
    : range.find((p) => p.key === activePreset)?.label ?? ''

  const chip = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`
  const summaryItems: TmsSummaryChip[] = [
    { key: 'week', label: 'Collected this week', value: formatCents(collected.collectedWeekCents), sub: chip(collected.collectedWeekCount, 'invoice'),
      title: 'Invoices paid this week, by paid date. Same as the Receivables card.' },
    { key: 'month', label: 'Collected this month', value: formatCents(collected.collectedMonthCents), sub: chip(collected.collectedMonthCount, 'invoice'),
      title: 'Invoices paid this month, by paid date. Same as the Receivables card.' },
    { key: 'payments', label: `Payments · ${rangeLabel}`, value: formatCents(totals.paymentsCents), sub: chip(totals.paymentsCount, 'payment'),
      title: 'Cash receipts in the rows below.' },
    { key: 'credits', label: 'Credits', value: formatCents(totals.creditsCents), sub: chip(totals.creditsCount, 'credit') },
    { key: 'debits', label: 'Debits', value: formatCents(totals.debitsCents), sub: chip(totals.debitsCount, 'debit') },
    ...(totals.reversalsCount > 0 ? [{ key: 'reversals', label: 'Reversals', value: formatCents(totals.reversalsCents), sub: chip(totals.reversalsCount, 'reversal'), tone: 'warn' as const }] : []),
    { key: 'unapplied', label: 'Unapplied', value: formatCents(totals.unappliedCents), tone: totals.unappliedCents > 0 ? 'warn' : 'default' },
  ]

  const invoiceLinks = (r: ReceivedRow): ReactNode => {
    if (r.invoices.length === 0) return '—'
    return (
      <span className="flex flex-wrap gap-x-2">
        {r.invoices.map((i) => {
          const ref = shipmentsByPro.get(proOf(i.invoiceId))
          const to = r.source === 'BCAT' ? `/tms/invoicing/invoices/${encodeURIComponent(i.invoiceId)}` : ref ? shipmentEditorPath(ref.id) : null
          return to ? <Link key={i.invoiceId} to={to}>{i.invoiceId}</Link> : <span key={i.invoiceId}>{i.invoiceId}</span>
        })}
      </span>
    )
  }

  type Row = ReceivedRow & { runningCents?: number }
  const money = (key: string, header: string, of: (r: Row) => number): DenseColumn<Row> => ({
    key, header, group: 'Amounts', align: 'right', text: (r) => formatCents(of(r)), sortValue: (r) => of(r),
    filter: 'number', numberOf: (r) => of(r) / 100, numberUnit: '$',
  })
  const columns: Array<DenseColumn<Row>> = [
    { key: 'date', header: 'Date received', group: 'Payment', text: (r) => formatDay(r.date), filter: 'date', dateOf: (r) => r.date, sortValue: (r) => r.date ?? '' },
    { key: 'customer', header: 'Customer', group: 'Payment', text: (r) => r.customerName },
    { key: 'type', header: 'Type', group: 'Payment', text: (r) => RECEIVED_TYPE_LABEL[r.type] + (r.reversed ? ' (reversed)' : ''), filter: 'multi' },
    { key: 'method', header: 'Method', group: 'Payment', text: (r) => r.method ?? '—', filter: 'multi' },
    { key: 'reference', header: 'Reference', group: 'Payment', text: (r) => r.reference ?? '—' },
    money('amount', 'Amount', (r) => r.amountCents),
    money('applied', 'Applied', (r) => r.appliedCents),
    money('unapplied', 'Unapplied', (r) => r.unappliedCents),
    ...(ledger ? [money('running', 'Running total', (r) => r.runningCents ?? 0)] : []),
    { key: 'invoices', header: 'Applied to', group: 'Payment', text: (r) => r.invoices.map((i) => i.invoiceId).join(' ') || '—' },
    { key: 'by', header: 'Recorded by', group: 'Payment', text: (r) => r.recordedBy ?? '—', filter: 'multi' },
    { key: 'source', header: 'Source', group: 'Payment', text: (r) => (r.source === 'Aljex' ? 'Aljex history' : 'BCAT Ops'), filter: 'multi' },
    { key: 'note', header: 'Note', group: 'Payment', text: (r) => r.note ?? '' },
    { key: 'reverse', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 100 },
  ]
  const renderCell = (r: Row, key: string): ReactNode => {
    if (key === 'invoices') return invoiceLinks(r)
    if (key === 'type') {
      return (
        <span className="flex items-center gap-1">
          <TmsBadge tone={r.type === 'payment' ? 'green' : r.type === 'debit' ? 'orange' : r.type === 'reversal' ? 'red' : 'gray'}>{RECEIVED_TYPE_LABEL[r.type]}</TmsBadge>
          {r.reversed && <span className="text-xs tms-muted">Reversed</span>}
        </span>
      )
    }
    if (key === 'reverse') {
      const p = r.payment
      if (!p || p.kind === 'REVERSAL' || p.reversedByPaymentId) return null
      return (
        <span className="flex justify-end">
          <TmsButton variant="ghost" size="sm" disabled={busy} aria-label={`Reverse ${RECEIVED_TYPE_LABEL[r.type].toLowerCase()} of ${formatCents(Math.abs(r.amountCents))}`}
            onClick={() => setDialog({ kind: 'reverse', payment: p })}>
            Reverse
          </TmsButton>
        </span>
      )
    }
    return undefined
  }

  const customer = oneCustomer ? customerById.get(oneCustomer) ?? null : null
  const filterCount = (filter.customers.length ? 1 : 0) + (filter.types.length ? 1 : 0) + (filter.methods.length ? 1 : 0)
    + (filter.divisions.length ? 1 : 0) + (filter.unappliedOnly ? 1 : 0)

  return (
    <>
      <div className="tms-page" data-testid="payments-received-page">
        <div className="tms-page-head">
          <h1>Payments received</h1>
          <div className="tms-page-actions">
            <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Refresh" onClick={() => { setLoading(true); void load() }}>
              <RefreshCw size={15} />
            </button>
            <TmsButton size="sm" data-testid="payments-received-csv" onClick={() => saveBlob(new Blob([receivedCsv(visible)], { type: 'text/csv' }), `payments-received-${filter.from || 'start'}-to-${filter.to || asOf}.csv`)}>
              <Download size={14} aria-hidden="true" /> Export CSV
            </TmsButton>
            {customer && (
              <>
                <TmsButton variant="primary" size="sm" disabled={busy} onClick={() => setDialog({ kind: 'payment', customerId: customer.id, customerName: customer.name })}>Receive payment</TmsButton>
                <TmsButton size="sm" disabled={busy} onClick={() => setDialog({ kind: 'credit', customerId: customer.id, customerName: customer.name })}>New credit</TmsButton>
              </>
            )}
          </div>
        </div>

        <TmsSummaryChips aria-label="Payments received at a glance" testId="payments-received-totals" items={summaryItems} />

        <div className="tms-filter-row flex flex-wrap items-center gap-2" data-testid="payments-received-filters">
          <TmsSelect aria-label="Dates" value={activePreset} onChange={(e) => {
            const p = range.find((x) => x.key === e.target.value)
            if (p) setFilter((f) => ({ ...f, from: p.from, to: p.to }))
          }}>
            {range.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            {activePreset === 'custom' && <option value="custom">Custom</option>}
          </TmsSelect>
          <TmsInput type="date" aria-label="From" value={filter.from} onChange={(e) => setFilter((f) => ({ ...f, from: e.target.value }))} />
          <TmsInput type="date" aria-label="To" value={filter.to} onChange={(e) => setFilter((f) => ({ ...f, to: e.target.value }))} />
          <TmsSelect aria-label="Customer" value={oneCustomer ?? ''} onChange={(e) => setCustomer(e.target.value || null)}>
            <option value="">All customers</option>
            {customerOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </TmsSelect>
          <TmsSelect aria-label="Type" value={filter.types[0] ?? ''} onChange={(e) => setFilter((f) => ({ ...f, types: e.target.value ? [e.target.value as ReceivedType] : [] }))}>
            <option value="">All types</option>
            {(Object.keys(RECEIVED_TYPE_LABEL) as ReceivedType[]).map((t) => <option key={t} value={t}>{RECEIVED_TYPE_LABEL[t]}</option>)}
          </TmsSelect>
          <TmsSelect aria-label="Method" value={filter.methods[0] ?? ''} onChange={(e) => setFilter((f) => ({ ...f, methods: e.target.value ? [e.target.value] : [] }))}>
            <option value="">All methods</option>
            {methodOptions.map((m) => <option key={m} value={m}>{m === NO_METHOD ? 'No method' : m}</option>)}
          </TmsSelect>
          <TmsSelect aria-label="Rev division" value={filter.divisions[0] ?? ''} onChange={(e) => setFilter((f) => ({ ...f, divisions: e.target.value ? [e.target.value] : [] }))}>
            <option value="">All divisions</option>
            {divisionOptions.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </TmsSelect>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={filter.unappliedOnly} onChange={(e) => setFilter((f) => ({ ...f, unappliedOnly: e.target.checked }))} />
            Has unapplied
          </label>
        </div>

        {customer && (
          <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="payments-received-ledger">
            <span className="font-medium">{customer.name}</span>
            <TmsBadge tone="gray">{formatCents(customerAr.openCents)} open</TmsBadge>
            <TmsBadge tone="gray">{formatCents(customerAr.unappliedCents)} unapplied</TmsBadge>
            <span className="tms-muted">Oldest first, with a running total of what is listed.</span>
          </p>
        )}
        {memoError && <p className="text-sm" style={{ color: 'var(--tms-badge-red)' }}>{memoError}</p>}

        <ArDenseTable<Row>
          key={ledger ? 'ledger' : 'all'}
          grid={{
            gridId: ledger ? 'payments-received-ledger' : 'payments-received',
            label: 'Payments received',
            columns,
            rows: ledger ?? visible,
            rowKey: (r) => r.id,
            renderCell,
            cardLayout: { title: 'date', party: 'customer', amount: 'amount', pills: ['type'] },
            empty: loading ? 'Loading…' : 'Nothing was received in this range.',
          }}
          pageFilters={{
            count: filterCount,
            onClear: () => { setCustomer(null); setFilter((f) => ({ ...f, customers: [], types: [], methods: [], divisions: [], unappliedOnly: false })) },
          }}
        />
      </div>

      {dialog?.kind === 'payment' && (
        <ReceivePaymentDialog customerId={dialog.customerId} customerName={dialog.customerName} busy={busy} onClose={() => setDialog(null)} onDone={closeAndRefresh} />
      )}
      {dialog?.kind === 'credit' && (
        <CreditMemoDialog customerId={dialog.customerId} customerName={dialog.customerName} busy={busy} onClose={() => setDialog(null)} onDone={closeAndRefresh} />
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

export default PaymentsReceivedPage
