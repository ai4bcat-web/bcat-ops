/**
 * Payments Received → Outstanding: every open invoice in ONE table (Ryne 2026-11-16: "look more like a table
 * like active shipments"), the shared dense grid. A Type column says Manual or Factored (OTR); every column
 * filters and sorts; the customer search box (and ?customer=) narrows the table to one customer.
 *
 * Tick the invoices a payment covers, adjust each amount, enter the check # / OTR reference and date, and
 * "Receive payments" posts the payment (RECORD_PAYMENT) after a read-back.
 *
 * A factored invoice is pre-filled at its balance less OTR's fee (TmsSettings.factorFeeBps, default
 * 2%). After the payment posts, the fee is closed on the invoice as a write-off reasoned
 * "Factoring fee (OTR 2%)", so the invoice ends PAID and the fee is reportable.
 *
 * "Paid in full" (Ryne 2026-11-16): a row, or the whole bar, can accept the amount typed as the full settlement.
 * A short pay is closed as a write-off reasoned "Short pay accepted as paid in full" and an overpay is recorded on
 * the payment (acceptOverage), so the invoice ends PAID with no open balance and no customer credit. Both stay
 * reportable. `TmsSettings.payDiffAutoAcceptCents` accepts a small gap without ticking anything.
 *
 * Manual and Factored are never received together: each type has its own receive bar (a check is one
 * customer's; one OTR remittance covers many customers' invoices and posts one payment per customer).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsInput, TmsSelect } from '@/features/tms/kit'
import type { DenseColumn, DenseOption } from '@/features/tms/grid/denseGridModel'
import { ArDenseTable } from '@/features/ar/components/ArDenseTable'
import { AR_PAYMENT_METHOD_LABEL, formatDay } from '@/features/ar/arViews'
import { useCustomerPaymentFacts } from '@/hooks/useCustomerPaymentFacts'
import { getTmsSettings, graphqlErrorText, recordPayment, writeOffInvoice } from '@/lib/apiClient'
import { termsVsActualText } from '@/lib/daysToPay'
import { formatCents } from '@/lib/invoiceBuild'
import type { ArPaymentMethod, CustomerRecord, InvoiceRecord } from '@/types/tms'
import {
  DEFAULT_FACTOR_FEE_BPS, LATE_BUCKETS, SHORT_PAY_REASON, allocateOldestFirst, differenceReason, factorFeeReason, filterTableRows, lateBucket, parseDollars,
  planReceive, prefillCents, recordPaymentInput, tableRows,
  type OutstandingSectionKey, type OutstandingTableRow, type ReceiveDraft, type ReceivePlan,
} from './outstanding'

const MANUAL_METHODS: ArPaymentMethod[] = ['CHECK', 'ACH', 'WIRE', 'CARD', 'ZELLE', 'OTHER']
const FACTOR_METHODS: ArPaymentMethod[] = ['FACTOR', 'ACH', 'WIRE', 'CHECK', 'OTHER']

const TYPE_LABEL: Record<OutstandingSectionKey, string> = { manual: 'Manual', factored: 'Factored (OTR)' }

interface BarForm { reference: string; receivedAt: string; method: ArPaymentMethod; note: string }

const invoicePath = (id: string) => `/tms/invoicing/invoices/${encodeURIComponent(id)}`
const dollars = (cents: number) => (cents / 100).toFixed(2)
const typedCents = (text: string | undefined) => Math.max(0, Math.round(Number((text ?? '').replace(/[$,\s]/g, '')) * 100) || 0)
const opt = (value: string): DenseOption[] => (value ? [{ value, label: value }] : [])

export function OutstandingView({ invoices, customers, loading, asOf, onReceived, customerId = null, query = '', divisionName }: {
  invoices: InvoiceRecord[]
  customers: Map<string, CustomerRecord>
  loading: boolean
  asOf: string
  onReceived: () => void
  /** Work on one customer: only their invoices (Ryne 2026-11-16). */
  customerId?: string | null
  /** A typed search over invoice #, PRO and PO. */
  query?: string
  /** A division key → its name, for the Rev division column. */
  divisionName?: (key: string) => string
}) {
  const [feeBps, setFeeBps] = useState(DEFAULT_FACTOR_FEE_BPS)
  // "Auto-accept differences under $X": 0 means never (the default).
  const [autoAcceptCents, setAutoAcceptCents] = useState(0)
  // "Accept payment amounts as entered": on unless Settings turns it off.
  const [asEntered, setAsEntered] = useState(true)
  useEffect(() => {
    let alive = true
    getTmsSettings().then((s) => {
      if (!alive) return
      if (s?.factorFeeBps != null) setFeeBps(s.factorFeeBps)
      if (s?.payDiffAutoAcceptCents != null) setAutoAcceptCents(s.payDiffAutoAcceptCents)
      if (s?.payAcceptAsEntered === false) setAsEntered(false)
    }).catch(() => { /* default 2%, no auto-accept */ })
    return () => { alive = false }
  }, [])

  const allRows = useMemo(
    () => tableRows(invoices, (id, fallback) => customers.get(id)?.name ?? fallback, asOf),
    [invoices, customers, asOf],
  )
  // The page's own filters: one customer, the typed search, and the Manual / Factored chips.
  const [typeChip, setTypeChip] = useState<OutstandingSectionKey | null>(null)
  const baseRows = useMemo(() => filterTableRows(allRows, { customerId, query }), [allRows, customerId, query])
  const rows = useMemo(() => (typeChip ? baseRows.filter((r) => r.type === typeChip) : baseRows), [baseRows, typeChip])
  // What the grid leaves after its column filters, search and sort: what the totals, Select all and the bars act on.
  const [shown, setShown] = useState<OutstandingTableRow[]>([])
  const onFiltered = useCallback((next: OutstandingTableRow[]) => setShown(next), [])

  const manualCustomerIds = useMemo(() => [...new Set(allRows.filter((r) => r.type === 'manual').map((r) => r.customerId))], [allRows])
  const [factsVersion, setFactsVersion] = useState(0)
  const facts = useCustomerPaymentFacts(manualCustomerIds, factsVersion)

  const [tickedAll, setTicked] = useState<Record<string, string>>({})
  // Invoices whose amount is accepted as the full settlement, short or over.
  const [accept, setAccept] = useState<Record<string, boolean>>({})
  const [forms, setForms] = useState<Record<string, BarForm>>({})
  const [confirm, setConfirm] = useState<{ barKey: OutstandingSectionKey; title: string; draft: ReceiveDraft; plan: ReceivePlan } | null>(null)
  const [posting, setPosting] = useState(false)
  const [errors, setErrors] = useState<Record<string, string[]>>({})

  // A filter change can hide invoices that were ticked: they count as unticked, so no bar can post them.
  const shownIds = useMemo(() => new Set(shown.map((r) => r.invoiceId)), [shown])
  const ticked = useMemo(
    () => Object.fromEntries(Object.entries(tickedAll).filter(([id]) => shownIds.has(id))),
    [shownIds, tickedAll],
  )

  const [checkAmount, setCheckAmount] = useState('')
  const [applyError, setApplyError] = useState<string | null>(null)
  const manualShown = useMemo(() => shown.filter((r) => r.type === 'manual'), [shown])
  const allShownTicked = shown.length > 0 && shown.every((r) => r.invoiceId in ticked)
  const applyOldestFirst = () => {
    const cents = parseDollars(checkAmount)
    if (cents == null || cents <= 0) { setApplyError('Enter the check amount first.'); return }
    setApplyError(null)
    const plan = allocateOldestFirst(manualShown, cents, feeBps)
    setTicked((t) => {
      const next = { ...t }
      for (const r of manualShown) delete next[r.invoiceId]
      for (const [id, c] of plan) next[id] = dollars(c)
      return next
    })
  }

  const formOf = (barKey: OutstandingSectionKey): BarForm =>
    forms[barKey] ?? { reference: '', receivedAt: asOf, method: barKey === 'factored' ? 'FACTOR' : 'CHECK', note: '' }
  const setForm = (barKey: OutstandingSectionKey, patch: Partial<BarForm>) =>
    setForms((f) => ({ ...f, [barKey]: { ...formOf(barKey), ...patch } }))
  const tick = (list: OutstandingTableRow[], on: boolean) => setTicked((t) => {
    const next = { ...t }
    for (const r of list) {
      if (!on) delete next[r.invoiceId]
      else if (!(r.invoiceId in next)) next[r.invoiceId] = dollars(prefillCents(r, feeBps))
    }
    return next
  })
  const toggleRow = (row: OutstandingTableRow) => tick([row], !(row.invoiceId in ticked))

  const pickedOf = (type: OutstandingSectionKey) => shown.filter((r) => r.type === type && r.invoiceId in ticked)

  const startReceive = (barKey: OutstandingSectionKey) => {
    const f = formOf(barKey)
    const draft: ReceiveDraft = {
      lines: pickedOf(barKey).map((row) => ({ row, amount: ticked[row.invoiceId], accept: accept[row.invoiceId] === true })),
      feeBps, autoAcceptCents, acceptAsEntered: asEntered, ...f,
    }
    const plan = planReceive(draft)
    setErrors((e) => ({ ...e, [barKey]: plan.errors }))
    if (!plan.ok) return
    const names = [...new Set(pickedOf(barKey).map((r) => r.customerName))]
    setConfirm({ barKey, title: barKey === 'factored' ? 'OTR' : names[0] ?? 'the customer', draft, plan })
  }

  const post = async () => {
    if (!confirm) return
    setPosting(true)
    const { draft, plan } = confirm
    const reqId = crypto.randomUUID()
    let posted = 0
    try {
      for (const p of plan.payments) {
        await recordPayment(recordPaymentInput(draft, p, `${reqId}-${p.customerId}`.slice(0, 64)))
        posted++
      }
      // OTR's fee, closed on each factored invoice once its payment is in.
      for (const l of plan.lines) {
        if (l.feeCents <= 0) continue
        await writeOffInvoice({
          invoiceId: l.invoiceId,
          amountCents: l.feeCents,
          reason: factorFeeReason(draft.feeBps),
          clientRequestId: `${reqId}-fee-${l.invoiceId}`.slice(0, 64),
        })
      }
      // A short pay accepted as paid in full: the rest is closed as an adjustment, so no balance stays open.
      for (const l of plan.lines) {
        if (l.shortCents <= 0) continue
        await writeOffInvoice({
          invoiceId: l.invoiceId,
          amountCents: l.shortCents,
          reason: differenceReason(SHORT_PAY_REASON, draft.note),
          clientRequestId: `${reqId}-short-${l.invoiceId}`.slice(0, 64),
        })
      }
      const accepted = plan.lines.filter((l) => l.accepted).length
      toast.success(`Received ${formatCents(plan.receivedCents)}${plan.feeCents ? ` · OTR fee ${formatCents(plan.feeCents)} closed` : ''}${accepted ? ` · ${accepted} accepted as paid in full` : ''}`)
      setTicked((t) => {
        const next = { ...t }
        for (const l of plan.lines) delete next[l.invoiceId]
        return next
      })
      setAccept((a) => {
        const next = { ...a }
        for (const l of plan.lines) delete next[l.invoiceId]
        return next
      })
      setForms((f) => { const next = { ...f }; delete next[confirm.barKey]; return next })
      setConfirm(null)
      setFactsVersion((v) => v + 1)
    } catch (e: unknown) {
      toast.error(`${graphqlErrorText(e) || 'The payment could not be posted'}${posted ? ` (${posted} of ${plan.payments.length} payments went through; check Payments Received)` : ''}`)
    } finally {
      setPosting(false)
      onReceived()
    }
  }

  const divLabel = useCallback((key: string) => (key ? (divisionName?.(key) ?? key) : ''), [divisionName])

  const columns: Array<DenseColumn<OutstandingTableRow>> = useMemo(() => [
    { key: 'select', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 44 },
    { key: 'customer', header: 'Customer', group: 'Invoice', text: (r) => r.customerName, filter: 'multi', optionsOf: (r) => opt(r.customerName) },
    {
      key: 'type', header: 'Type', group: 'Invoice', text: (r) => TYPE_LABEL[r.type], filter: 'multi', optionsOf: (r) => opt(TYPE_LABEL[r.type]),
      fixedOptions: [{ value: TYPE_LABEL.manual, label: TYPE_LABEL.manual }, { value: TYPE_LABEL.factored, label: TYPE_LABEL.factored }],
    },
    { key: 'invoice', header: 'Invoice #', group: 'Invoice', text: (r) => r.number },
    { key: 'pro', header: 'PRO', group: 'Invoice', text: (r) => r.pro },
    { key: 'po', header: 'PO', group: 'Invoice', text: (r) => r.po ?? '' },
    { key: 'invoiced', header: 'Invoiced', group: 'Dates', text: (r) => (r.invoiceDate ? formatDay(r.invoiceDate) : ''), filter: 'date', dateOf: (r) => r.invoiceDate || null, sortValue: (r) => r.invoiceDate },
    { key: 'due', header: 'Due', group: 'Dates', text: (r) => (r.dueAt ? formatDay(r.dueAt) : ''), filter: 'date', dateOf: (r) => r.dueAt || null, sortValue: (r) => r.dueAt },
    {
      key: 'daysOut', header: 'Days out', group: 'Dates', align: 'right', text: (r) => `${r.daysOutstanding}d`,
      sortValue: (r) => r.daysOutstanding, filter: 'number', numberOf: (r) => r.daysOutstanding, numberUnit: 'days',
    },
    {
      key: 'status', header: 'Status', group: 'Dates', text: (r) => (r.daysLate > 0 ? `${r.daysLate} days late` : 'Current'), sortValue: (r) => r.daysLate,
      filter: 'multi', optionsOf: (r) => opt(lateBucket(r.daysLate)), fixedOptions: LATE_BUCKETS.map((b) => ({ value: b, label: b })),
    },
    { key: 'terms', header: 'Terms', group: 'Invoice', text: (r) => r.termsText, filter: 'multi', optionsOf: (r) => opt(r.termsText) },
    {
      key: 'amount', header: 'Amount', group: 'Amounts', align: 'right', text: (r) => formatCents(r.totalCents), sortValue: (r) => r.totalCents,
      filter: 'number', numberOf: (r) => r.totalCents / 100, numberUnit: '$',
    },
    {
      key: 'paid', header: 'Paid', group: 'Amounts', align: 'right', text: (r) => (r.paidCents ? formatCents(r.paidCents) : ''), sortValue: (r) => r.paidCents,
      filter: 'number', numberOf: (r) => r.paidCents / 100, numberUnit: '$',
    },
    {
      key: 'balance', header: 'Balance', group: 'Amounts', align: 'right', text: (r) => formatCents(r.balanceCents), sortValue: (r) => r.balanceCents,
      filter: 'number', numberOf: (r) => r.balanceCents / 100, numberUnit: '$',
    },
    { key: 'division', header: 'Rev division', group: 'Invoice', text: (r) => divLabel(r.divisionKey), filter: 'multi', optionsOf: (r) => opt(divLabel(r.divisionKey)) },
    { key: 'sent', header: 'Sent', group: 'Dates', text: (r) => (r.sentOn ? formatDay(r.sentOn) : ''), filter: 'date', dateOf: (r) => r.sentOn || null, sortValue: (r) => r.sentOn },
    { key: 'amountPaid', header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 210 },
  ], [divLabel])

  const renderCell = (r: OutstandingTableRow, key: string): ReactNode => {
    switch (key) {
      case 'select':
        return <input type="checkbox" aria-label={`Select ${r.pro}`} checked={r.invoiceId in ticked} onChange={() => toggleRow(r)} />
      case 'amountPaid': {
        const on = r.invoiceId in ticked
        return (
          <span className="pr-out-amtcell">
            <TmsInput className="pr-out-amt" inputMode="decimal" aria-label={`Amount paid on ${r.pro}`} disabled={!on}
              value={on ? ticked[r.invoiceId] : ''} placeholder={on ? '' : 'Amount paid'}
              onChange={(e) => setTicked((t) => ({ ...t, [r.invoiceId]: e.target.value }))} />
            {on && (
              <label className="pr-out-full" title="Accept this amount as the full settlement: a short pay is closed and an overpay is accepted, leaving no open balance or credit.">
                <input type="checkbox" aria-label={`Accept ${r.pro} as paid in full`} checked={accept[r.invoiceId] === true}
                  onChange={(e) => setAccept((a) => ({ ...a, [r.invoiceId]: e.target.checked }))} />
                In full
              </label>
            )}
          </span>
        )
      }
      case 'type':
        return <TmsBadge tone={r.type === 'factored' ? 'blue' : 'gray'}>{TYPE_LABEL[r.type]}</TmsBadge>
      case 'invoice':
        return <Link to={invoicePath(r.invoiceId)}>{r.number}</Link>
      case 'status':
        return r.daysLate > 0 ? <TmsBadge tone="red">{r.daysLate} days late</TmsBadge> : <TmsBadge tone="green">Current</TmsBadge>
      case 'balance':
        return <strong>{formatCents(r.balanceCents)}</strong>
      default:
        return undefined
    }
  }

  const receiveBar = (barKey: OutstandingSectionKey) => {
    const picked = pickedOf(barKey)
    if (picked.length === 0) return null
    const factored = barKey === 'factored'
    const f = formOf(barKey)
    const running = picked.reduce((s, r) => s + typedCents(ticked[r.invoiceId]), 0)
    const allAccepted = picked.every((r) => accept[r.invoiceId] === true)
    const anyAccepted = picked.some((r) => accept[r.invoiceId] === true)
    const methods = factored ? FACTOR_METHODS : MANUAL_METHODS
    const refLabel = f.method === 'CHECK' ? 'Check number' : factored ? 'OTR remittance or ACH reference' : 'Reference'
    // A check is one customer's: ticked manual invoices from several customers can't share one payment.
    const customersPicked = new Set(picked.map((r) => r.customerId)).size
    const mixed = !factored && customersPicked > 1
    return (
      <div className="pr-out-bar" data-testid={factored ? 'receive-bar-factored' : 'receive-bar'}>
        <strong className="pr-out-bar-title">{factored ? 'Factored (OTR) · received from OTR' : `Manual · ${picked[0].customerName}`}</strong>
        <TmsSelect aria-label={`${TYPE_LABEL[barKey]} method`} value={f.method} onChange={(e) => setForm(barKey, { method: e.target.value as ArPaymentMethod })}>
          {methods.map((m) => <option key={m} value={m}>{m === 'FACTOR' ? 'OTR (factor)' : AR_PAYMENT_METHOD_LABEL[m]}</option>)}
        </TmsSelect>
        <TmsInput aria-label={`${TYPE_LABEL[barKey]} ${refLabel}`} placeholder={f.method === 'CHECK' ? 'Check #' : factored ? 'OTR remittance #' : 'Reference'}
          value={f.reference} onChange={(e) => setForm(barKey, { reference: e.target.value })} />
        <TmsInput type="date" aria-label={`${TYPE_LABEL[barKey]} payment date`} value={f.receivedAt} onChange={(e) => setForm(barKey, { receivedAt: e.target.value })} />
        <label className="pr-out-full pr-out-fullall" title="Accept every ticked amount as the full settlement: short pays are closed and overpays accepted, with no open balance or credit left.">
          <input type="checkbox" aria-label={`Accept all ${TYPE_LABEL[barKey]} as paid in full`} checked={allAccepted}
            onChange={(e) => setAccept((a) => { const next = { ...a }; for (const r of picked) next[r.invoiceId] = e.target.checked; return next })} />
          Accept all as paid in full
        </label>
        {anyAccepted && (
          <TmsInput aria-label={`${TYPE_LABEL[barKey]} reason for accepting the difference`} placeholder="Reason (optional)" value={f.note}
            onChange={(e) => setForm(barKey, { note: e.target.value })} />
        )}
        <span className="pr-out-total">{picked.length} invoice{picked.length === 1 ? '' : 's'} · <strong>{formatCents(running)}</strong></span>
        <TmsButton variant="primary" size="sm" disabled={mixed} onClick={() => startReceive(barKey)} data-testid="receive-payments">Receive payments</TmsButton>
        {mixed && <p className="pr-out-errors" role="alert" data-testid="receive-mixed-customers">A check is one customer&rsquo;s. The ticked manual invoices belong to {customersPicked} customers: pick one customer above, or untick the others.</p>}
        {(errors[barKey] ?? []).length > 0 && (
          <ul className="pr-out-errors" role="alert">
            {errors[barKey].map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
      </div>
    )
  }

  const customerName = customerId ? customers.get(customerId)?.name ?? shown[0]?.customerName ?? baseRows[0]?.customerName ?? 'Customer' : ''
  const oneDays = customerId ? facts.daysToPayByCustomer.get(customerId) : undefined
  const oneRows = customerId ? allRows.filter((r) => r.customerId === customerId) : []
  const oneOpenCents = oneRows.reduce((n, r) => n + r.balanceCents, 0)
  const shownCents = shown.reduce((n, r) => n + r.balanceCents, 0)
  const manualCount = baseRows.filter((r) => r.type === 'manual').length
  const factoredCount = baseRows.filter((r) => r.type === 'factored').length

  if (allRows.length === 0) return <p className="tms-muted text-sm" style={{ padding: 16 }}>{loading ? 'Loading…' : 'Nothing is outstanding.'}</p>

  return (
    <div className="pr-out" data-testid="payments-outstanding">
      {customerId && (
        <div className="pr-one" data-testid="one-customer-bar">
          <strong className="pr-one-name">{customerName}</strong>
          <span className="tms-muted text-sm">{oneRows.length} open invoice{oneRows.length === 1 ? '' : 's'} · {formatCents(oneOpenCents)} open</span>
          <span className="pr-out-d2p text-sm" data-testid="one-customer-days-to-pay">{termsVsActualText(customers.get(customerId)?.paymentTermsDays, oneDays)}</span>
          <div className="pr-one-actions">
            <TmsButton size="sm" onClick={() => tick(shown, !allShownTicked)} disabled={shown.length === 0} data-testid="select-all-customer">
              {allShownTicked ? 'Clear selection' : `Select all open (${shown.length})`}
            </TmsButton>
            {manualShown.length > 0 && (
              <>
                <TmsInput inputMode="decimal" aria-label="Check amount" placeholder="Check amount" value={checkAmount}
                  onChange={(e) => { setCheckAmount(e.target.value); setApplyError(null) }} />
                <TmsButton size="sm" onClick={applyOldestFirst} data-testid="apply-oldest-first">Apply oldest first</TmsButton>
              </>
            )}
          </div>
          {applyError && <p className="pr-out-errors" role="alert">{applyError}</p>}
        </div>
      )}

      <div className="pr-out-summary" data-testid="outstanding-summary">
        <span><strong>{shown.length}</strong> invoice{shown.length === 1 ? '' : 's'} · <strong>{formatCents(shownCents)}</strong> open</span>
        <button type="button" className="pr-toggle" aria-pressed={typeChip === 'manual'} data-testid="chip-manual"
          onClick={() => setTypeChip((c) => (c === 'manual' ? null : 'manual'))}>Manual {manualCount}</button>
        <button type="button" className="pr-toggle" aria-pressed={typeChip === 'factored'} data-testid="chip-factored"
          onClick={() => setTypeChip((c) => (c === 'factored' ? null : 'factored'))}>Factored (OTR) {factoredCount}</button>
        {!customerId && shown.length > 0 && (
          <TmsButton size="sm" variant="ghost" onClick={() => tick(shown, !allShownTicked)} data-testid="select-all-shown">
            {allShownTicked ? 'Clear selection' : `Select all shown (${shown.length})`}
          </TmsButton>
        )}
        <span className="tms-muted text-sm pr-out-hint">Factored invoices start at the balance less OTR&rsquo;s {feeBps / 100}% fee; the fee is closed on the invoice.</span>
      </div>

      <ArDenseTable<OutstandingTableRow>
        grid={{
          gridId: 'payments-outstanding',
          label: 'Outstanding invoices',
          columns,
          rows,
          rowKey: (r) => r.invoiceId,
          renderCell,
          onFiltered,
          defaultColumns: ['customer', 'type', 'invoice', 'pro', 'po', 'invoiced', 'due', 'daysOut', 'status', 'amount', 'paid', 'balance'],
          cardLayout: { title: 'invoice', party: 'customer', amount: 'balance', pills: ['type', 'status'] },
          empty: loading ? 'Loading…' : `No open invoices match${customerId ? ` for ${customerName}` : ''}${query.trim() ? ` “${query.trim()}”` : ''}.`,
        }}
        pageFilters={{ count: typeChip ? 1 : 0, onClear: () => setTypeChip(null) }}
      />

      {/* One bar per type, only for the type with ticked invoices: Manual and Factored are never received together. */}
      <div className="pr-out-bars">
        {receiveBar('manual')}
        {receiveBar('factored')}
      </div>

      {confirm && (
        <TmsDialog
          open
          onOpenChange={(open) => { if (!open && !posting) setConfirm(null) }}
          title={`Receive ${formatCents(confirm.plan.receivedCents)} from ${confirm.title}`}
          footer={
            <>
              <TmsButton variant="ghost" disabled={posting} onClick={() => setConfirm(null)}>Back</TmsButton>
              <TmsButton variant="primary" disabled={posting} onClick={() => { void post() }} data-testid="receive-confirm">
                {posting ? 'Posting…' : 'Receive payments'}
              </TmsButton>
            </>
          }
        >
          <div className="flex flex-col gap-2 text-sm" data-testid="receive-readback">
            <p>
              {confirm.draft.method === 'FACTOR' ? 'OTR (factor)' : AR_PAYMENT_METHOD_LABEL[confirm.draft.method]}
              {confirm.draft.reference.trim() ? <> #<strong>{confirm.draft.reference.trim()}</strong></> : null}
              {' '}· received {formatDay(confirm.draft.receivedAt)}
            </p>
            <p data-testid="receive-fee-summary">
              Received <strong>{formatCents(confirm.plan.receivedCents)}</strong>
              {confirm.plan.feeCents > 0 && <> · OTR fee {confirm.draft.feeBps / 100}% <strong>{formatCents(confirm.plan.feeCents)}</strong></>}
              {' '}· Invoice total <strong>{formatCents(confirm.plan.invoiceCents)}</strong>
              {confirm.plan.shortCents > 0 && <> · accepted as paid in full (short <strong>{formatCents(confirm.plan.shortCents)}</strong>)</>}
              {confirm.plan.overCents > 0 && <> · accepted as paid in full (over <strong>{formatCents(confirm.plan.overCents)}</strong>)</>}
            </p>
            <ul className="flex flex-col gap-1">
              {confirm.plan.lines.map((l) => (
                <li key={l.invoiceId} className="flex justify-between gap-3">
                  <span>
                    {l.pro}
                    {l.feeCents > 0 ? <span className="tms-muted"> · fee {formatCents(l.feeCents)}</span> : null}
                    {l.leftCents > 0 ? <span className="tms-muted"> · {formatCents(l.leftCents)} stays open</span> : null}
                    {l.shortCents > 0 ? <span className="tms-muted"> · paid in full, short {formatCents(l.shortCents)}{l.auto ? ' (auto-accepted)' : ''}</span> : null}
                    {l.overCents > 0 ? <span className="tms-muted"> · paid in full, over {formatCents(l.overCents)}{l.auto ? ' (auto-accepted)' : ''}</span> : null}
                  </span>
                  <strong>{formatCents(l.paidCents)}</strong>
                </li>
              ))}
            </ul>
            <p className="tms-muted">
              {confirm.plan.payments.length === 1 ? 'One payment' : `${confirm.plan.payments.length} payments, one per customer,`} with this reference.
              {confirm.plan.feeCents > 0 ? ` OTR's fee is closed on each factored invoice as "${factorFeeReason(confirm.draft.feeBps)}".` : ''}
              {confirm.plan.shortCents > 0 ? ` A short pay is closed as "${differenceReason(SHORT_PAY_REASON, confirm.draft.note)}", so no balance stays open.` : ''}
              {confirm.plan.overCents > 0 ? ' An overpay is recorded on the payment and never kept as customer credit.' : ''}
            </p>
          </div>
        </TmsDialog>
      )}
    </div>
  )
}
