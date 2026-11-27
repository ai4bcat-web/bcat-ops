/**
 * `/tms/payments-received` — Accounting → Payments Received (Ryne 2026-11-15). The ONE place a customer
 * payment is recorded: every other screen links here with the customer (and invoice) picked.
 * Outstanding (the default, Ryne 2026-11-16) lists every open invoice by customer and receives a check
 * against the ticked ones; Payments Received / Credits & debits / All are the ledger.
 *
 * - "Collected this week / month" are the Receivables card's own figures (`computeArSummary` over the
 *   same six months of invoices, by paid date), so this page and the card cannot disagree.
 * - A payment that was later reversed and the reversal that undid it cancel out: the pair is hidden
 *   and left out of every total unless "Show reversed" is on.
 * - Rows come from BCAT `ArPayment` and from the Aljex CRED/DEBT memos kept as history.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './paymentsReceived.css'
import { Link, useSearchParams } from 'react-router-dom'
import { BackToAutoShipperLoads } from '@/features/car-shipping/BackToAutoShipperLoads'
import { periodFromParam, presetRange, type PresetKey } from './links'
import { Download, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge, TmsButton, TmsDialog, TmsInput, TmsSegmentedTabs, TmsSelect, TmsSummaryChips, type TmsSummaryChip,
} from '@/features/tms/kit'
import type { DenseColumn } from '@/features/tms/grid/denseGridModel'
import { ArDenseTable } from '@/features/ar/components/ArDenseTable'
import { ReceivePaymentDialog } from '@/features/ar/components/ReceivePaymentDialog'
import { CreditMemoDialog } from '@/features/ar/components/CreditMemoDialog'
import { ReasonDialog } from '@/features/ar/components/ReasonDialog'
import { computeArSummary, divisionKeyOf } from '@/features/ar/arSummary'
import { formatDay, lastMonths, PAID_LOOKBACK_MONTHS } from '@/features/ar/arViews'
import { useDirectory } from '@/hooks/useDirectory'
import { useOpenInvoices } from '@/hooks/useOpenInvoices'
import { OutstandingView } from './OutstandingView'
import { DifferencesView } from './DifferencesView'
import { openCount, differenceRows } from './differences'
import { isShortPayNote } from '@/lib/paymentDifference'
import { CustomerSearch } from './CustomerSearch'
import {
  SEARCH_RESULT_CAP, invoiceSearch, invoiceSearchState, ledgerSearch, looksLikeInvoiceNumber, poMapOf, proOfInvoiceId,
} from './search'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { getInvoice, graphqlErrorText, listArPayments, listInvoicesByCustomer, listInvoicesByMonth, listShipmentsByNumber, reversePayment } from '@/lib/apiClient'
import { listAljexMemoRows } from '@/lib/paymentsClient'
import { chicagoDateStr } from '@/lib/date'
import { saveBlob } from '@/lib/download'
import { formatCents } from '@/lib/invoiceBuild'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import type { ArPaymentRecord, CustomerRecord, InvoiceRecord, OtrOffsetFlag } from '@/types/tms'
import { OtrOffsetChip } from '@/features/ar/components/OtrOffsetChip'
import {
  NO_METHOD, RECEIVED_TYPE_LABEL, filterReceived, fromAljexMemo, fromArPayment, hideReversed, inView, monthBounds, nameKey,
  receivedCsv, receivedTotals, type ReceivedFilter, type ReceivedRow, type ReceivedView,
} from './paymentsReceived'

type Dialog =
  | { kind: 'pickCustomer'; next: 'payment' | 'credit' }
  | { kind: 'payment'; customerId: string; customerName: string; invoiceIds: string[] }
  | { kind: 'credit'; customerId: string; customerName: string }
  | { kind: 'detail'; row: ReceivedRow }
  | { kind: 'reverse'; payment: ArPaymentRecord }

/** A PRO's shipment, as far as this page needs it: where its link goes and which division it counts toward. */
interface ShipmentRef { id: string; division: string }

const proOf = (invoiceId: string) => invoiceId.split('-')[0].trim()

const PRESET_LABEL: Record<PresetKey, string> = {
  week: 'This week', month: 'This month', last: 'Last month', year: 'This year', all: 'All dates', custom: 'Custom dates',
}

type PageView = 'outstanding' | 'differences' | ReceivedView

const VIEW_TABS: Array<{ key: PageView; label: string }> = [
  { key: 'outstanding', label: 'Outstanding' },
  { key: 'payments', label: 'Payments Received' },
  { key: 'adjustments', label: 'Credits & debits' },
  { key: 'all', label: 'All' },
  { key: 'differences', label: 'Differences' },
]

export function PaymentsReceivedPage() {
  const [asOf] = useState(() => chicagoDateStr(new Date()))
  const [searchParams, setSearchParams] = useSearchParams()
  const [initialPeriod] = useState(() => periodFromParam(searchParams.get('period'), asOf))
  const [preset, setPreset] = useState<PresetKey>(initialPeriod?.preset ?? 'month')
  const [view, setViewState] = useState<PageView>(() => {
    const v = searchParams.get('view')
    return v === 'payments' || v === 'adjustments' || v === 'all' || v === 'differences' ? v : 'outstanding'
  })
  const setView = (v: PageView) => {
    setViewState(v)
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (v === 'outstanding') next.delete('view')
      else next.set('view', v)
      return next
    }, { replace: true })
  }
  const open = useOpenInvoices()
  const [outQuery, setOutQuery] = useState(() => searchParams.get('q') ?? '')
  const changeOutQuery = (text: string) => {
    setOutQuery(text)
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (text.trim()) next.set('q', text)
      else next.delete('q')
      return next
    }, { replace: true })
  }
  // Any text in the search box looks across ALL invoices and payments, on the All tab, whatever the date range (Ryne 2026-11-27).
  const searchTerm = outQuery.trim()
  const searching = searchTerm.length > 0
  const [showReversed, setShowReversed] = useState(false)
  const [baseFilter, setFilter] = useState<ReceivedFilter>(() => ({
    ...(initialPeriod?.range ?? monthBounds(asOf)),
    customers: [],
    types: [],
    methods: [],
    divisions: [],
    unappliedOnly: false,
    diffsOnly: false,
  }))
  // The picked customer lives in the URL (`?customer=`), so a link, a reload and the search box all agree.
  const urlCustomer = searchParams.get('customer')
  const filter = useMemo<ReceivedFilter>(() => ({ ...baseFilter, customers: urlCustomer ? [urlCustomer] : [] }), [baseFilter, urlCustomer])
  // While a term is typed the date range and the type / method / division toggles stay out of the way; only the picked customer narrows.
  const effectiveFilter = useMemo<ReceivedFilter>(
    () => (searching ? { ...filter, from: '', to: '', types: [], methods: [], divisions: [], unappliedOnly: false, diffsOnly: false } : filter),
    [filter, searching],
  )

  const { customers } = useDirectory({ locations: false })
  const { divisions } = useOwnershipDivisions()
  const [payments, setPayments] = useState<ArPaymentRecord[]>([])
  const [memos, setMemos] = useState<Awaited<ReturnType<typeof listAljexMemoRows>>>([])
  const [recentPaid, setRecentPaid] = useState<InvoiceRecord[]>([])
  /** Invoices found outside the six-month window: an exact invoice / PRO look-up and the picked customer's book. */
  const [lookedUp, setLookedUp] = useState<InvoiceRecord[]>([])
  const [customerBook, setCustomerBook] = useState<InvoiceRecord[]>([])
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

  // Beyond the six months the page loads: an exact invoice number / PRO is read directly, and a picked customer's whole book is read once.
  useEffect(() => {
    if (!looksLikeInvoiceNumber(searchTerm)) return
    let cancelled = false
    const ids = [...new Set([searchTerm, proOfInvoiceId(searchTerm)])]
    const timer = setTimeout(() => {
      void Promise.all(ids.map((id) => getInvoice(id))).then((found) => {
        const got = found.filter((i): i is InvoiceRecord => !!i)
        if (cancelled || got.length === 0) return
        setLookedUp((prev) => [...prev.filter((p) => !got.some((g) => g.id === p.id)), ...got])
      })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [searchTerm])
  useEffect(() => {
    if (!searching || !urlCustomer) return
    let cancelled = false
    void listInvoicesByCustomer(urlCustomer).then((list) => { if (!cancelled) setCustomerBook(list) })
    return () => { cancelled = true }
  }, [searching, urlCustomer])

  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers])
  // Who has money outstanding, so the customer search lists them first.
  const openByCustomer = useMemo(() => {
    const m = new Map<string, number>()
    for (const inv of open.invoices) if (inv.status === 'ISSUED' || inv.status === 'PARTIAL') m.set(inv.customerId, (m.get(inv.customerId) ?? 0) + (inv.balanceCents ?? 0))
    return m
  }, [open.invoices])
  const customerIdByKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of customers) if (c.name && !m.has(nameKey(c.name))) m.set(nameKey(c.name), c.id)
    return m
  }, [customers])

  // `?record=1&customer=…&invoice=…` (the link every other screen uses) opens Record payment, once.
  const handedOff = useRef(false)
  useEffect(() => {
    if (handedOff.current || searchParams.get('record') !== '1') return
    const customerId = searchParams.get('customer')
    handedOff.current = true
    const invoiceIds = searchParams.getAll('invoice')
    // A one-time hand-off from the link; the URL is then cleaned so a reload does not reopen it.
    setDialog(customerId
      ? { kind: 'payment', customerId, customerName: '', invoiceIds }
      : { kind: 'pickCustomer', next: 'payment' })
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('record')
      next.delete('invoice')
      return next
    }, { replace: true })
  }, [searchParams, setSearchParams])

  const rows: ReceivedRow[] = useMemo(() => {
    const name = (id: string) => customerById.get(id)?.name ?? ''
    const reversals = new Map(payments.filter((p) => p.kind === 'REVERSAL' && p.reversesPaymentId).map((p) => [p.reversesPaymentId!, p]))
    const bcat = payments.map((p) => fromArPayment(p, name, (id) => reversals.get(id)))
    const aljex = memos.map((m) => fromAljexMemo(m, (n) => customerIdByKey.get(nameKey(n)) ?? null)).filter((r): r is ReceivedRow => r != null)
    return [...bcat, ...aljex].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.id.localeCompare(a.id))
  }, [payments, memos, customerById, customerIdByKey])

  // Rev division: the shipment behind each applied invoice / referenced PRO, looked up by PRO once per visit.
  const [shipmentsByPro, setShipmentsByPro] = useState<ReadonlyMap<string, ShipmentRef | null>>(() => new Map())
  const asked = useRef(new Set<string>())
  const inRange = useMemo(
    () => filterReceived(rows, { ...effectiveFilter, types: [], methods: [], divisions: [], unappliedOnly: false, diffsOnly: false }, () => []),
    [rows, effectiveFilter],
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
    void Promise.all(Array.from({ length: Math.min(6, pros.length) }, worker))
      .then(() => setShipmentsByPro((prev) => new Map([...prev, ...found])))
  }, [inRange])
  const divisionsOf = useCallback((row: ReceivedRow) => row.invoices
    .map((i) => shipmentsByPro.get(proOf(i.invoiceId))?.division)
    .filter((d): d is string => !!d), [shipmentsByPro])

  // What the tabs show: a typed search always lands on All (the previous tab comes back when the box is cleared).
  const shownView: PageView = searching ? 'all' : view
  const knownInvoices = useMemo(() => [...open.invoices, ...recentPaid, ...lookedUp, ...customerBook], [open.invoices, recentPaid, lookedUp, customerBook])
  const poByInvoice = useMemo(() => poMapOf(knownInvoices), [knownInvoices])
  const filtered = useMemo(() => {
    const inFilter = filterReceived(rows, effectiveFilter, divisionsOf)
    return searching ? ledgerSearch(inFilter, searchTerm, poByInvoice) : inFilter
  }, [rows, effectiveFilter, divisionsOf, searching, searchTerm, poByInvoice])
  const reversedCount = useMemo(() => filtered.filter((r) => r.reversed).length, [filtered])
  const ledgerView: ReceivedView = shownView === 'outstanding' || shownView === 'differences' ? 'payments' : shownView
  const isLedger = shownView !== 'outstanding' && shownView !== 'differences'
  const invoiceHits = useMemo(
    () => (searching ? invoiceSearch([knownInvoices], searchTerm, (id) => customerById.get(id)?.name ?? '', { customerId: urlCustomer }) : { rows: [] as InvoiceRecord[], total: 0 }),
    [searching, knownInvoices, searchTerm, customerById, urlCustomer],
  )
  const diffOpen = useMemo(
    () => openCount(differenceRows(open.invoices, rows, (id, fallback) => customerById.get(id)?.name ?? fallback)),
    [open.invoices, rows, customerById],
  )
  const listed = useMemo(() => hideReversed(filtered, showReversed).filter((r) => inView(r, ledgerView)), [filtered, showReversed, ledgerView])
  // Totals never count a reversed pair, whatever is shown.
  const totals = useMemo(() => receivedTotals(filtered), [filtered])

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
  const methodOptions = useMemo(() => [...new Set(rows.map((r) => r.method ?? NO_METHOD))].filter((m) => m !== NO_METHOD).sort(), [rows])
  const oneCustomer = filter.customers.length === 1 ? filter.customers[0] : null

  const setCustomer = (id: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('customer', id)
      else next.delete('customer')
      return next
    }, { replace: true })
  }
  const choosePreset = (key: PresetKey) => {
    setPreset(key)
    const range = presetRange(key, asOf)
    if (range) setFilter((f) => ({ ...f, ...range }))
  }

  const runReverse = (payment: ArPaymentRecord, reason: string) => {
    setBusy(true)
    reversePayment({ paymentId: payment.id, reason })
      .then(() => { toast.success('Payment reversed'); setDialog(null); void load() })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not reverse the payment'))
      .finally(() => setBusy(false))
  }
  const closeAndRefresh = () => { setDialog(null); void load(); void open.refresh() }
  const startRecord = () => {
    const c = oneCustomer ? customerById.get(oneCustomer) : null
    setDialog(c ? { kind: 'payment', customerId: c.id, customerName: c.name, invoiceIds: [] } : { kind: 'pickCustomer', next: 'payment' })
  }
  const startMemo = () => {
    const c = oneCustomer ? customerById.get(oneCustomer) : null
    setDialog(c ? { kind: 'credit', customerId: c.id, customerName: c.name } : { kind: 'pickCustomer', next: 'credit' })
  }

  const rangeLabel = searching ? 'all dates' : preset === 'custom'
    ? `${filter.from ? formatDay(filter.from) : 'start'} – ${filter.to ? formatDay(filter.to) : 'today'}`
    : PRESET_LABEL[preset].toLowerCase()
  const n = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`
  const summaryItems: TmsSummaryChip[] = [
    { key: 'week', label: 'Collected this week', value: formatCents(collected.collectedWeekCents), sub: n(collected.collectedWeekCount, 'invoice'),
      title: 'Invoices paid this week, by paid date. Same as the Receivables card.' },
    { key: 'month', label: 'Collected this month', value: formatCents(collected.collectedMonthCents), sub: n(collected.collectedMonthCount, 'invoice'),
      title: 'Invoices paid this month, by paid date. Same as the Receivables card.' },
    { key: 'payments', label: `Payments · ${rangeLabel}`, value: formatCents(totals.paymentsCents), sub: n(totals.paymentsCount, 'payment'),
      title: 'Payments Received in the range and filters below. A payment that was later reversed is not counted.' },
    { key: 'credits', label: 'Credits', value: formatCents(Math.abs(totals.creditsCents)), sub: n(totals.creditsCount, 'credit') },
    { key: 'debits', label: 'Debits', value: formatCents(totals.debitsCents), sub: n(totals.debitsCount, 'debit') },
    { key: 'unapplied', label: 'Unapplied', value: formatCents(totals.unappliedCents), tone: totals.unappliedCents > 0 ? 'warn' : 'default',
      title: 'Money received but not yet put against an invoice.' },
  ]

  /** Invoices OTR Solutions offset (internal marker), among the recent ones this page already reads. */
  const offsetById = useMemo(() => new Map(recentPaid.filter((inv) => inv.otrOffset).map((inv) => [inv.id, inv.otrOffset as OtrOffsetFlag])), [recentPaid])

  const invoiceChips = (r: ReceivedRow): ReactNode => {
    if (r.invoices.length === 0) return <span className="tms-muted">—</span>
    return (
      <span className="pr-chips">
        {r.invoices.map((i) => {
          const ref = shipmentsByPro.get(proOf(i.invoiceId))
          const to = r.source === 'BCAT' ? `/tms/invoicing/invoices/${encodeURIComponent(i.invoiceId)}` : ref ? shipmentEditorPath(ref.id) : null
          const label = i.amountCents != null && r.invoices.length > 1 ? `${i.invoiceId} · ${formatCents(i.amountCents)}` : i.invoiceId
          const chip = to
            ? <Link key={i.invoiceId} className="pr-chip" to={to} onClick={(e) => e.stopPropagation()}>{label}</Link>
            : <span key={i.invoiceId} className="pr-chip">{label}</span>
          const offset = offsetById.get(i.invoiceId)
          return offset ? <span key={i.invoiceId} className="inline-flex items-center gap-1">{chip}<OtrOffsetChip flag={offset} /></span> : chip
        })}
      </span>
    )
  }

  const showType = ledgerView !== 'payments'
  const columns: Array<DenseColumn<ReceivedRow>> = [
    { key: 'date', header: 'Received', group: 'Payment', text: (r) => formatDay(r.date), filter: 'date', dateOf: (r) => r.date, sortValue: (r) => r.date ?? '' },
    { key: 'customer', header: 'Customer', group: 'Payment', text: (r) => r.customerName },
    ...(showType ? [{ key: 'type', header: 'Type', group: 'Payment', text: (r: ReceivedRow) => RECEIVED_TYPE_LABEL[r.type], filter: 'multi' as const }] : []),
    { key: 'method', header: 'Method', group: 'Payment', text: (r) => r.method ?? '—', filter: 'multi' },
    { key: 'reference', header: 'Reference', group: 'Payment', text: (r) => r.reference ?? '—' },
    {
      key: 'amount', header: 'Amount', group: 'Amounts', align: 'right', text: (r) => formatCents(r.amountCents), sortValue: (r) => r.amountCents,
      filter: 'number', numberOf: (r) => r.amountCents / 100, numberUnit: '$',
    },
    { key: 'invoices', header: 'Applied to', group: 'Payment', text: (r) => r.invoices.map((i) => i.invoiceId).join(' ') || '—' },
    {
      key: 'otrOffset', header: 'OTR offset', group: 'Payment', text: (r) => (r.invoices.some((i) => offsetById.has(i.invoiceId)) ? 'OTR offset' : '—'),
      filter: 'multi', optionsOf: (r) => [{ value: r.invoices.some((i) => offsetById.has(i.invoiceId)) ? 'OTR offset' : 'Not flagged', label: r.invoices.some((i) => offsetById.has(i.invoiceId)) ? 'OTR offset' : 'Not flagged' }],
    },
    {
      key: 'unapplied', header: 'Unapplied', group: 'Amounts', align: 'right', text: (r) => (r.unappliedCents > 0 ? formatCents(r.unappliedCents) : ''),
      sortValue: (r) => r.unappliedCents, filter: 'number', numberOf: (r) => r.unappliedCents / 100, numberUnit: '$',
    },
    { key: 'by', header: 'Recorded by', group: 'Payment', text: (r) => r.recordedBy ?? '—', filter: 'multi' },
  ]
  const renderCell = (r: ReceivedRow, key: string): ReactNode => {
    const struck = r.reversed ? 'pr-reversed' : undefined
    if (key === 'invoices') return invoiceChips(r)
    if (key === 'type') {
      const badge = <TmsBadge tone={r.type === 'debit' ? 'orange' : r.type === 'reversal' ? 'red' : r.type === 'payment' ? 'green' : 'gray'}>{RECEIVED_TYPE_LABEL[r.type]}</TmsBadge>
      if (r.type === 'write-off' && isShortPayNote(r.note)) return <span className="flex items-center gap-1">{badge}<TmsBadge tone="orange">Short pay</TmsBadge></span>
      return badge
    }
    if (key === 'unapplied') return r.unappliedCents > 0 && !r.reversed ? <TmsBadge tone="orange">{formatCents(r.unappliedCents)}</TmsBadge> : null
    if (key === 'amount') {
      return (
        <span className={struck}>
          {formatCents(r.amountCents)}
          {(r.overAcceptedCents ?? 0) > 0 && !r.reversed ? <TmsBadge tone="orange" title="Overpay accepted as paid in full: recorded, not kept as credit.">Over {formatCents(r.overAcceptedCents ?? 0)}</TmsBadge> : null}
        </span>
      )
    }
    if (key === 'reference' && r.reversed) {
      return (
        <span className="flex flex-col">
          <span className={struck}>{r.reference ?? '—'}</span>
          <span className="text-xs tms-muted">Reversed{r.reversedOn ? ` on ${formatDay(r.reversedOn)}` : ''}{r.reversedReason ? ` — ${r.reversedReason}` : ''}</span>
        </span>
      )
    }
    // Every other column draws its own text.
    return undefined
  }

  const filterCount = (filter.customers.length ? 1 : 0) + (filter.methods.length ? 1 : 0) + (filter.divisions.length ? 1 : 0) + (filter.unappliedOnly ? 1 : 0) + (filter.diffsOnly ? 1 : 0)

  return (
    <>
      <div className="tms-page" data-testid="payments-received-page">
        <BackToAutoShipperLoads />
        <div className="tms-page-head">
          <h1>Payments Received</h1>
          <div className="tms-page-actions">
            <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Refresh" onClick={() => { setLoading(true); void load() }}>
              <RefreshCw size={15} />
            </button>
            <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Export CSV" title="Export what is listed as CSV" data-testid="payments-received-csv"
              onClick={() => saveBlob(new Blob([receivedCsv(listed)], { type: 'text/csv' }), `payments-received-${filter.from || 'start'}-to-${filter.to || asOf}.csv`)}>
              <Download size={15} />
            </button>
            <TmsButton size="sm" onClick={startMemo} data-testid="payments-received-memo">
              <Plus size={14} aria-hidden="true" /> Add credit / debit memo
            </TmsButton>
            <TmsButton variant="primary" size="sm" onClick={startRecord} data-testid="payments-received-record">
              Record payment
            </TmsButton>
          </div>
        </div>

        <TmsSummaryChips aria-label="Payments Received at a glance" testId="payments-received-totals" items={summaryItems} />

        <div className="pr-toolbar" data-testid="payments-received-filters">
          <TmsSegmentedTabs aria-label="Show" size="sm" active={shownView} onSelect={(k) => { if (searching) changeOutQuery(''); setView(k as PageView) }}
            tabs={VIEW_TABS.map((t) => (t.key === 'differences' && diffOpen > 0 ? { ...t, label: `Differences (${diffOpen})` } : t))} />
          <CustomerSearch customers={customers} openByCustomer={openByCustomer} selectedId={oneCustomer}
            selectedName={oneCustomer ? customerById.get(oneCustomer)?.name : undefined} onSelect={setCustomer} />
          <TmsInput type="search" aria-label="Search invoice, PRO or PO" placeholder="Invoice #, PRO or PO" value={outQuery}
            title="Searches every invoice and payment, all dates, on the All tab." onChange={(e) => changeOutQuery(e.target.value)} />
          {isLedger && !searching && (<>
          <TmsSelect aria-label="Dates" value={preset} onChange={(e) => choosePreset(e.target.value as PresetKey)}>
            {(Object.keys(PRESET_LABEL) as PresetKey[]).map((k) => <option key={k} value={k}>{PRESET_LABEL[k]}</option>)}
          </TmsSelect>
          {preset === 'custom' && (
            <>
              <TmsInput type="date" aria-label="From" value={filter.from} onChange={(e) => setFilter((f) => ({ ...f, from: e.target.value }))} />
              <TmsInput type="date" aria-label="To" value={filter.to} onChange={(e) => setFilter((f) => ({ ...f, to: e.target.value }))} />
            </>
          )}
          <TmsSelect aria-label="Method" value={filter.methods[0] ?? ''} onChange={(e) => setFilter((f) => ({ ...f, methods: e.target.value ? [e.target.value] : [] }))}>
            <option value="">All methods</option>
            {methodOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </TmsSelect>
          <TmsSelect aria-label="Rev division" value={filter.divisions[0] ?? ''} onChange={(e) => setFilter((f) => ({ ...f, divisions: e.target.value ? [e.target.value] : [] }))}>
            <option value="">All divisions</option>
            {divisionOptions.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </TmsSelect>
          <button type="button" className="pr-toggle" aria-pressed={filter.unappliedOnly} onClick={() => setFilter((f) => ({ ...f, unappliedOnly: !f.unappliedOnly }))}>
            Unapplied only
          </button>
          <button type="button" className="pr-toggle" aria-pressed={filter.diffsOnly === true} data-testid="diffs-only"
            title="Short pays closed as paid in full, and overpays accepted as paid in full."
            onClick={() => setFilter((f) => ({ ...f, diffsOnly: !f.diffsOnly }))}>
            Short pay / overpay adjustments
          </button>
          {(reversedCount > 0 || showReversed) && (
            <button type="button" className="pr-toggle pr-toggle-muted" aria-pressed={showReversed} onClick={() => setShowReversed((v) => !v)}
              title="A reversed payment and the reversal that undid it cancel out; they are hidden and never counted.">
              {showReversed ? 'Hide reversed' : `Show reversed (${reversedCount})`}
            </button>
          )}
          </>)}
        </div>
        {memoError && <p className="text-sm" style={{ color: 'var(--tms-badge-red)' }}>{memoError}</p>}
        {searching && (
          <p className="text-sm tms-muted" data-testid="payments-received-searching">
            Searching every invoice and payment, all dates, for “{searchTerm}”. Clear the search to go back to the {VIEW_TABS.find((t) => t.key === view)?.label ?? 'previous'} tab.
          </p>
        )}

        {shownView === 'differences' ? (
          <DifferencesView invoices={open.invoices} ledger={rows} customers={customerById} loading={open.loading} customerId={oneCustomer}
            onAccepted={() => { void load(); void open.refresh() }} />
        ) : shownView === 'outstanding' ? (
          <OutstandingView invoices={open.invoices} customers={customerById} loading={open.loading} asOf={asOf}
            customerId={oneCustomer} query={outQuery} divisionName={divisionName}
            onReceived={() => { void load(); void open.refresh() }} />
        ) : (
        <>
        {searching && (
          <InvoiceSearchResults
            term={searchTerm}
            rows={invoiceHits.rows}
            total={invoiceHits.total}
            customerName={(id) => customerById.get(id)?.name ?? ''}
          />
        )}
        <ArDenseTable<ReceivedRow>
          key={`${ledgerView}-${showType}`}
          grid={{
            gridId: `payments-received-${ledgerView}`,
            label: 'Payments Received',
            columns,
            rows: listed,
            rowKey: (r) => r.id,
            renderCell,
            onRowClick: (r) => setDialog({ kind: 'detail', row: r }),
            cardLayout: { title: 'customer', party: 'date', amount: 'amount', pills: showType ? ['type'] : [] },
            empty: loading ? 'Loading…' : searching ? `No payment matches “${searchTerm}”.` : 'Nothing was received in this range.',
          }}
          pageFilters={{
            count: filterCount,
            onClear: () => { setCustomer(null); setFilter((f) => ({ ...f, customers: [], methods: [], divisions: [], unappliedOnly: false, diffsOnly: false })) },
          }}
        />
        </>
        )}
      </div>

      {dialog?.kind === 'pickCustomer' && (
        <PickCustomerDialog
          customers={customers}
          title={dialog.next === 'payment' ? 'Record payment' : 'Add credit / debit memo'}
          onClose={() => setDialog(null)}
          onPick={(c) => setDialog(dialog.next === 'payment'
            ? { kind: 'payment', customerId: c.id, customerName: c.name, invoiceIds: [] }
            : { kind: 'credit', customerId: c.id, customerName: c.name })}
        />
      )}
      {dialog?.kind === 'payment' && (
        <ReceivePaymentDialog
          key={dialog.customerId}
          customerId={dialog.customerId}
          customerName={dialog.customerName || customerById.get(dialog.customerId)?.name}
          invoiceIds={dialog.invoiceIds}
          busy={busy}
          onClose={() => setDialog(null)}
          onDone={closeAndRefresh}
          onChangeCustomer={() => setDialog({ kind: 'pickCustomer', next: 'payment' })}
        />
      )}
      {dialog?.kind === 'credit' && (
        <CreditMemoDialog customerId={dialog.customerId} customerName={dialog.customerName} busy={busy} onClose={() => setDialog(null)} onDone={closeAndRefresh} />
      )}
      {dialog?.kind === 'detail' && (
        <PaymentDetailDialog
          row={dialog.row}
          offsetById={offsetById}
          busy={busy}
          onClose={() => setDialog(null)}
          onReverse={(p) => setDialog({ kind: 'reverse', payment: p })}
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

/** Who paid: a search over every customer, for Record payment and memos opened without one. */
/** Invoices matching the typed search, whatever their state: open, partly paid, paid (with the paid date) or void. */
function InvoiceSearchResults({ term, rows, total, customerName }: {
  term: string
  rows: readonly InvoiceRecord[]
  total: number
  customerName: (customerId: string) => string
}) {
  return (
    <section className="pr-out-group" data-testid="payments-received-invoice-results" aria-label="Invoices matching the search">
      <div className="pr-out-head">
        <strong className="pr-out-name">Invoices matching “{term}”</strong>
        <span className="tms-muted text-sm">
          {total === 0 ? 'none' : total > rows.length ? `showing ${rows.length} of ${total}; refine the search` : `${total} ${total === 1 ? 'invoice' : 'invoices'}`}
        </span>
      </div>
      {rows.length > 0 && (
        <div className="pr-out-table-wrap">
          <table className="pr-out-table">
            <thead>
              <tr><th>Invoice</th><th>Customer</th><th>Status</th><th>Invoiced</th><th>Paid on</th><th>Amount</th><th>Paid</th><th>Balance</th></tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const state = invoiceSearchState(inv)
                const tone = state === 'Paid' ? 'green' : state === 'Void' ? 'red' : state === 'Partly paid' ? 'orange' : 'gray'
                return (
                  <tr key={inv.id} data-testid={`payments-received-invoice-${inv.id}`}>
                    <td><Link className="pr-chip" to={`/tms/invoicing/invoices/${encodeURIComponent(inv.id)}`}>{inv.number || inv.id}</Link></td>
                    <td>{customerName(inv.customerId)}</td>
                    <td><TmsBadge tone={tone}>{state}</TmsBadge></td>
                    <td>{formatDay(inv.invoiceDate)}</td>
                    <td>{state === 'Paid' || state === 'Partly paid' ? formatDay(inv.paidAt) : '—'}</td>
                    <td>{formatCents(inv.totalCents ?? 0)}</td>
                    <td>{formatCents(inv.paidCents ?? 0)}</td>
                    <td>{state === 'Void' ? '—' : formatCents(inv.balanceCents ?? 0)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {total >= SEARCH_RESULT_CAP && <p className="text-sm tms-muted" style={{ padding: '6px 12px' }}>Showing the newest {SEARCH_RESULT_CAP}. Type more of the number or the customer to narrow it.</p>}
    </section>
  )
}

function PickCustomerDialog({ customers, title, onClose, onPick }: {
  customers: CustomerRecord[]
  title: string
  onClose: () => void
  onPick: (customer: CustomerRecord) => void
}) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return customers
      .filter((c) => c.name && (!q || c.name.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 50)
  }, [customers, query])
  return (
    <TmsDialog open onOpenChange={(open) => { if (!open) onClose() }} title={`${title} — choose the customer`}>
      <div className="flex flex-col gap-2">
        <TmsInput autoFocus aria-label="Search customers" placeholder="Search customers" value={query} onChange={(e) => setQuery(e.target.value)} />
        <ul className="pr-pick-list" aria-label="Customers">
          {matches.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onPick(c)}>{c.name}</button>
            </li>
          ))}
          {matches.length === 0 && <li className="tms-muted p-2">No customer matches.</li>}
        </ul>
      </div>
    </TmsDialog>
  )
}

/** One row opened: what it was applied to, its note, and Reverse. */
function PaymentDetailDialog({ row, offsetById, busy, onClose, onReverse }: {
  row: ReceivedRow
  offsetById: ReadonlyMap<string, OtrOffsetFlag>
  busy: boolean
  onClose: () => void
  onReverse: (payment: ArPaymentRecord) => void
}) {
  const p = row.payment
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`${RECEIVED_TYPE_LABEL[row.type]} · ${row.customerName}`}
      footer={
        <>
          {p && p.kind !== 'REVERSAL' && !p.reversedByPaymentId && (
            <TmsButton variant="ghost" disabled={busy} onClick={() => onReverse(p)}>Reverse…</TmsButton>
          )}
          <TmsButton variant="primary" onClick={onClose}>Done</TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="payment-detail">
        <dl className="pr-detail">
          <dt>Received</dt><dd>{formatDay(row.date)}</dd>
          <dt>Amount</dt><dd className={row.reversed ? 'pr-reversed' : undefined}><strong>{formatCents(row.amountCents)}</strong></dd>
          <dt>Method</dt><dd>{row.method ?? '—'}</dd>
          <dt>Reference</dt><dd>{row.reference ?? '—'}</dd>
          <dt>Applied</dt><dd>{formatCents(row.appliedCents)}</dd>
          <dt>Unapplied</dt><dd>{row.unappliedCents > 0 ? <TmsBadge tone="orange">{formatCents(row.unappliedCents)}</TmsBadge> : '—'}</dd>
          <dt>Recorded by</dt><dd>{row.recordedBy ?? '—'}{row.source === 'Aljex' ? ' · Aljex history' : ''}</dd>
          {row.reversed && <><dt>Reversed</dt><dd>{row.reversedOn ? formatDay(row.reversedOn) : 'Yes'}{row.reversedReason ? ` — ${row.reversedReason}` : ''}</dd></>}
        </dl>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Applied to</p>
          {row.invoices.length === 0 ? <p className="tms-muted">Nothing.</p> : (
            <ul className="flex flex-col gap-1">
              {row.invoices.map((i) => (
                <li key={i.invoiceId} className="flex justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    {row.source === 'BCAT'
                      ? <Link to={`/tms/invoicing/invoices/${encodeURIComponent(i.invoiceId)}`}>Invoice {i.invoiceId}</Link>
                      : <span>PRO {i.invoiceId}</span>}
                    <OtrOffsetChip flag={offsetById.get(i.invoiceId)} />
                  </span>
                  <span>{i.amountCents != null ? formatCents(i.amountCents) : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {row.note && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">Note</p>
            <p>{row.note}</p>
          </div>
        )}
      </div>
    </TmsDialog>
  )
}

export default PaymentsReceivedPage
