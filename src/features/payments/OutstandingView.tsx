/**
 * Payments Received → Outstanding: every open invoice in two sections — Manually invoiced and
 * Factored (OTR) — each grouped by customer. Tick the invoices a payment covers, adjust each amount,
 * enter the check # / OTR reference and date, and "Receive payments" posts one payment per customer
 * (RECORD_PAYMENT) after a read-back.
 *
 * A factored invoice is pre-filled at its balance less OTR's fee (TmsSettings.factorFeeBps, default
 * 2%). After the payment posts, the fee is closed on the invoice as a write-off reasoned
 * "Factoring fee (OTR 2%)", so the invoice ends PAID and the fee is reportable.
 *
 * Manually invoiced: one receive bar per customer (one check is one customer's).
 * Factored: one receive bar for the whole section — one OTR remittance covers many customers' invoices;
 * it still posts one payment per customer, because a payment row belongs to one customer.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsInput, TmsSelect } from '@/features/tms/kit'
import { AR_PAYMENT_METHOD_LABEL, formatDay } from '@/features/ar/arViews'
import { useCustomerPaymentFacts } from '@/hooks/useCustomerPaymentFacts'
import { getTmsSettings, graphqlErrorText, recordPayment, writeOffInvoice } from '@/lib/apiClient'
import { termsVsActualText } from '@/lib/daysToPay'
import { formatCents } from '@/lib/invoiceBuild'
import type { ArPaymentMethod, CustomerRecord, InvoiceRecord } from '@/types/tms'
import {
  DEFAULT_FACTOR_FEE_BPS, allocateOldestFirst, factorFeeReason, filterOutstanding, groupOutstanding, parseDollars, planReceive, prefillCents,
  recordPaymentInput,
  type OutstandingGroup, type OutstandingRow, type OutstandingSection, type ReceiveDraft, type ReceivePlan,
} from './outstanding'

const MANUAL_METHODS: ArPaymentMethod[] = ['CHECK', 'ACH', 'WIRE', 'CARD', 'ZELLE', 'OTHER']
const FACTOR_METHODS: ArPaymentMethod[] = ['FACTOR', 'ACH', 'WIRE', 'CHECK', 'OTHER']

interface BarForm { reference: string; receivedAt: string; method: ArPaymentMethod }

const invoicePath = (id: string) => `/tms/invoicing/invoices/${encodeURIComponent(id)}`
const dollars = (cents: number) => (cents / 100).toFixed(2)
const typedCents = (text: string | undefined) => Math.max(0, Math.round(Number((text ?? '').replace(/[$,\s]/g, '')) * 100) || 0)

export function OutstandingView({ invoices, customers, loading, asOf, onReceived, customerId = null, query = '' }: {
  invoices: InvoiceRecord[]
  customers: Map<string, CustomerRecord>
  loading: boolean
  asOf: string
  onReceived: () => void
  /** Work on one customer: only their invoices, in both sections (Ryne 2026-11-16). */
  customerId?: string | null
  /** A typed search over invoice #, PRO and PO. */
  query?: string
}) {
  const [feeBps, setFeeBps] = useState(DEFAULT_FACTOR_FEE_BPS)
  useEffect(() => {
    let alive = true
    getTmsSettings().then((s) => { if (alive && s?.factorFeeBps != null) setFeeBps(s.factorFeeBps) }).catch(() => { /* default 2% */ })
    return () => { alive = false }
  }, [])

  const sections = useMemo(
    () => groupOutstanding(invoices, (id, fallback) => customers.get(id)?.name ?? fallback, asOf),
    [invoices, customers, asOf],
  )
  const visible = useMemo(() => filterOutstanding(sections, { customerId, query }), [sections, customerId, query])
  // The customer's own open money, whatever is typed in the search.
  const oneCustomer = useMemo(() => {
    if (!customerId) return null
    const mine = filterOutstanding(sections, { customerId })
    return { openCents: mine.reduce((n, sec) => n + sec.openCents, 0), count: mine.reduce((n, sec) => n + sec.count, 0) }
  }, [sections, customerId])
  const manualCustomerIds = useMemo(
    () => sections.filter((s) => s.key === 'manual').flatMap((s) => s.groups.map((g) => g.customerId)),
    [sections],
  )
  const [factsVersion, setFactsVersion] = useState(0)
  const facts = useCustomerPaymentFacts(manualCustomerIds, factsVersion)

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [tickedAll, setTicked] = useState<Record<string, string>>({})
  const [forms, setForms] = useState<Record<string, BarForm>>({})
  const [confirm, setConfirm] = useState<{ barKey: string; title: string; draft: ReceiveDraft; plan: ReceivePlan } | null>(null)
  const [posting, setPosting] = useState(false)
  const [errors, setErrors] = useState<Record<string, string[]>>({})

  // A customer or search change can hide invoices that were ticked: they count as unticked, so no bar can post them.
  const ticked = useMemo(() => {
    const shown = new Set(visible.flatMap((sec) => sec.groups.flatMap((g) => g.rows.map((r) => r.invoiceId))))
    return Object.fromEntries(Object.entries(tickedAll).filter(([id]) => shown.has(id)))
  }, [visible, tickedAll])

  const [checkAmount, setCheckAmount] = useState('')
  const [applyError, setApplyError] = useState<string | null>(null)
  const customerRows = useMemo(() => visible.flatMap((sec) => sec.groups.flatMap((g) => g.rows)), [visible])
  const manualRows = useMemo(() => visible.filter((sec) => sec.key === 'manual').flatMap((sec) => sec.groups.flatMap((g) => g.rows)), [visible])
  const allCustomerTicked = customerRows.length > 0 && customerRows.every((r) => r.invoiceId in ticked)
  const applyOldestFirst = () => {
    const cents = parseDollars(checkAmount)
    if (cents == null || cents <= 0) { setApplyError('Enter the check amount first.'); return }
    setApplyError(null)
    const plan = allocateOldestFirst(manualRows, cents, feeBps)
    setTicked((t) => {
      const next = { ...t }
      for (const r of manualRows) delete next[r.invoiceId]
      for (const [id, c] of plan) next[id] = dollars(c)
      return next
    })
  }

  const formOf = (barKey: string, factored: boolean): BarForm =>
    forms[barKey] ?? { reference: '', receivedAt: asOf, method: factored ? 'FACTOR' : 'CHECK' }
  const setForm = (barKey: string, factored: boolean, patch: Partial<BarForm>) =>
    setForms((f) => ({ ...f, [barKey]: { ...formOf(barKey, factored), ...patch } }))
  const tick = (rows: OutstandingRow[], on: boolean) => setTicked((t) => {
    const next = { ...t }
    for (const r of rows) {
      if (!on) delete next[r.invoiceId]
      else if (!(r.invoiceId in next)) next[r.invoiceId] = dollars(prefillCents(r, feeBps))
    }
    return next
  })
  const toggleRow = (row: OutstandingRow) => tick([row], !(row.invoiceId in ticked))
  const toggleCollapse = (key: string) => setCollapsed((c) => {
    const next = new Set(c)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const pickedIn = (rows: OutstandingRow[]) => rows.filter((r) => r.invoiceId in ticked)

  const startReceive = (barKey: string, title: string, rows: OutstandingRow[], factored: boolean) => {
    const f = formOf(barKey, factored)
    const draft: ReceiveDraft = { lines: pickedIn(rows).map((row) => ({ row, amount: ticked[row.invoiceId] })), feeBps, ...f }
    const plan = planReceive(draft)
    setErrors((e) => ({ ...e, [barKey]: plan.errors }))
    if (plan.ok) setConfirm({ barKey, title, draft, plan })
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
      toast.success(`Received ${formatCents(plan.receivedCents)}${plan.feeCents ? ` · OTR fee ${formatCents(plan.feeCents)} closed` : ''}`)
      setTicked((t) => {
        const next = { ...t }
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

  if (sections.length === 0) return <p className="tms-muted text-sm" style={{ padding: 16 }}>{loading ? 'Loading…' : 'Nothing is outstanding.'}</p>
  const filteredOut = visible.length === 0

  const receiveBar = (barKey: string, title: string, rows: OutstandingRow[], factored: boolean) => {
    const picked = pickedIn(rows)
    if (picked.length === 0) return null
    const f = formOf(barKey, factored)
    const running = picked.reduce((s, r) => s + typedCents(ticked[r.invoiceId]), 0)
    const methods = factored ? FACTOR_METHODS : MANUAL_METHODS
    const refLabel = f.method === 'CHECK' ? 'Check number' : factored ? 'OTR remittance or ACH reference' : 'Reference'
    return (
      <div className="pr-out-bar" data-testid={factored ? 'receive-bar-factored' : 'receive-bar'}>
        <TmsSelect aria-label="Method" value={f.method} onChange={(e) => setForm(barKey, factored, { method: e.target.value as ArPaymentMethod })}>
          {methods.map((m) => <option key={m} value={m}>{m === 'FACTOR' ? 'OTR (factor)' : AR_PAYMENT_METHOD_LABEL[m]}</option>)}
        </TmsSelect>
        <TmsInput aria-label={refLabel} placeholder={f.method === 'CHECK' ? 'Check #' : factored ? 'OTR remittance #' : 'Reference'}
          value={f.reference} onChange={(e) => setForm(barKey, factored, { reference: e.target.value })} />
        <TmsInput type="date" aria-label="Payment date" value={f.receivedAt} onChange={(e) => setForm(barKey, factored, { receivedAt: e.target.value })} />
        <span className="pr-out-total">{picked.length} invoice{picked.length === 1 ? '' : 's'} · <strong>{formatCents(running)}</strong></span>
        <TmsButton variant="primary" size="sm" onClick={() => startReceive(barKey, title, rows, factored)} data-testid="receive-payments">Receive payments</TmsButton>
        {(errors[barKey] ?? []).length > 0 && (
          <ul className="pr-out-errors" role="alert">
            {errors[barKey].map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
      </div>
    )
  }

  const groupBlock = (g: OutstandingGroup) => {
    const isOpen = !collapsed.has(g.key)
    const picked = pickedIn(g.rows)
    const allPicked = g.rows.length > 0 && picked.length === g.rows.length
    const customer = customers.get(g.customerId)
    const d2p = g.factored ? undefined : facts.daysToPayByCustomer.get(g.customerId)
    return (
      <section key={g.key} className="pr-out-group" data-testid="outstanding-group">
        <header className="pr-out-head">
          <button type="button" className="pr-out-twisty" aria-expanded={isOpen} onClick={() => toggleCollapse(g.key)}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${g.label}`}>
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <strong className="pr-out-name">{g.label}</strong>
          <span className="tms-muted text-sm">{g.rows.length} invoice{g.rows.length === 1 ? '' : 's'} · {formatCents(g.openCents)} open</span>
          {g.factored
            ? <span className="pr-out-d2p text-sm">OTR pays · {feeBps / 100}% fee</span>
            : <span className="pr-out-d2p text-sm" data-testid="outstanding-days-to-pay">{termsVsActualText(customer?.paymentTermsDays, d2p)}</span>}
        </header>
        {isOpen && (
          <>
            <div className="pr-out-table-wrap">
              <table className="pr-out-table" aria-label={`${g.label} open invoices`}>
                <thead>
                  <tr>
                    <th scope="col" className="pr-out-check">
                      <input type="checkbox" aria-label={`Select all for ${g.label}`} checked={allPicked} onChange={() => tick(g.rows, !allPicked)} />
                    </th>
                    <th scope="col">Invoice</th>
                    <th scope="col">PO</th>
                    <th scope="col">Invoiced</th>
                    <th scope="col">Due</th>
                    <th scope="col" className="pr-right">Days out</th>
                    <th scope="col" className="pr-right">Amount</th>
                    <th scope="col" className="pr-right">Paid</th>
                    <th scope="col" className="pr-right">Balance</th>
                    <th scope="col" className="pr-right">Amount paid</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => {
                    const on = r.invoiceId in ticked
                    return (
                      <tr key={r.invoiceId} className={on ? 'pr-out-on' : undefined}>
                        <td className="pr-out-check">
                          <input type="checkbox" aria-label={`Select ${r.pro}`} checked={on} onChange={() => toggleRow(r)} />
                        </td>
                        <td>
                          <Link to={invoicePath(r.invoiceId)}>{r.pro}</Link>
                          {r.factored && <TmsBadge tone="blue" className="pr-out-otr-tag">OTR</TmsBadge>}
                        </td>
                        <td>{r.po ?? '—'}</td>
                        <td>{formatDay(r.invoiceDate)}</td>
                        <td>{formatDay(r.dueAt)}</td>
                        <td className="pr-right">{r.daysOutstanding}d</td>
                        <td className="pr-right">{formatCents(r.totalCents)}</td>
                        <td className="pr-right">{r.paidCents ? formatCents(r.paidCents) : '—'}</td>
                        <td className="pr-right"><strong>{formatCents(r.balanceCents)}</strong></td>
                        <td className="pr-right">
                          <TmsInput className="pr-out-amt" inputMode="decimal" aria-label={`Amount paid on ${r.pro}`} disabled={!on}
                            value={on ? ticked[r.invoiceId] : ''} placeholder={on ? '' : '—'}
                            onChange={(e) => setTicked((t) => ({ ...t, [r.invoiceId]: e.target.value }))} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {/* Phones and iPads: the same invoices as cards. */}
            <ul className="pr-out-cards">
              {g.rows.map((r) => {
                const on = r.invoiceId in ticked
                return (
                  <li key={r.invoiceId} className={`pr-out-card${on ? ' pr-out-on' : ''}`}>
                    <div className="pr-out-card-top">
                      <input type="checkbox" aria-label={`Select ${r.pro}`} checked={on} onChange={() => toggleRow(r)} />
                      <Link to={invoicePath(r.invoiceId)}>{r.pro}</Link>
                      {r.factored && <TmsBadge tone="blue">OTR</TmsBadge>}
                      <strong className="pr-out-card-amt">{formatCents(r.balanceCents)}</strong>
                    </div>
                    <div className="tms-muted text-xs">PO {r.po ?? '—'} · Inv {formatDay(r.invoiceDate)} · Due {formatDay(r.dueAt)} · {r.daysOutstanding}d out</div>
                    {on && (
                      <TmsInput inputMode="decimal" aria-label={`Amount paid on ${r.pro}`} value={ticked[r.invoiceId]}
                        onChange={(e) => setTicked((t) => ({ ...t, [r.invoiceId]: e.target.value }))} />
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
        {/* A check is one customer's: manual invoices get a bar per customer. */}
        {!g.factored && receiveBar(g.key, g.label, g.rows, false)}
      </section>
    )
  }

  const sectionBlock = (s: OutstandingSection) => {
    const key = `section:${s.key}`
    const isOpen = !collapsed.has(key)
    const factored = s.key === 'factored'
    return (
      <div key={s.key} className={`pr-out-section${factored ? ' pr-out-section-otr' : ''}`} data-testid={`outstanding-section-${s.key}`}>
        <header className="pr-out-section-head">
          <button type="button" className="pr-out-twisty" aria-expanded={isOpen} onClick={() => toggleCollapse(key)}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${s.label}`}>
            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          <h2>{s.label}</h2>
          <span className="tms-muted text-sm">{s.groups.length} customer{s.groups.length === 1 ? '' : 's'} · {s.count} invoice{s.count === 1 ? '' : 's'} · {formatCents(s.openCents)} open</span>
          {factored && <span className="tms-muted text-sm">Amount paid starts at the balance less OTR&rsquo;s {feeBps / 100}% fee; the fee is closed on the invoice.</span>}
        </header>
        {isOpen && s.groups.map(groupBlock)}
        {/* One OTR remittance covers many customers: the factored section has one bar. */}
        {factored && receiveBar(key, 'OTR', s.groups.flatMap((g) => g.rows), true)}
      </div>
    )
  }

  const customerName = customerId ? customers.get(customerId)?.name ?? visible[0]?.groups[0]?.label ?? 'Customer' : ''
  const oneDays = customerId ? facts.daysToPayByCustomer.get(customerId) : undefined

  return (
    <div className="pr-out" data-testid="payments-outstanding">
      {customerId && oneCustomer && (
        <div className="pr-one" data-testid="one-customer-bar">
          <strong className="pr-one-name">{customerName}</strong>
          <span className="tms-muted text-sm">{oneCustomer.count} open invoice{oneCustomer.count === 1 ? '' : 's'} · {formatCents(oneCustomer.openCents)} open</span>
          <span className="pr-out-d2p text-sm" data-testid="one-customer-days-to-pay">{termsVsActualText(customers.get(customerId)?.paymentTermsDays, oneDays)}</span>
          <div className="pr-one-actions">
            <TmsButton size="sm" onClick={() => tick(customerRows, !allCustomerTicked)} disabled={customerRows.length === 0} data-testid="select-all-customer">
              {allCustomerTicked ? 'Clear selection' : `Select all open (${customerRows.length})`}
            </TmsButton>
            {manualRows.length > 0 && (
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
      {filteredOut
        ? <p className="tms-muted text-sm" style={{ padding: 16 }} data-testid="outstanding-no-match">No open invoices match{customerId ? ` for ${customerName}` : ''}{query.trim() ? ` “${query.trim()}”` : ''}.</p>
        : visible.map(sectionBlock)}

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
            </p>
            <ul className="flex flex-col gap-1">
              {confirm.plan.lines.map((l) => (
                <li key={l.invoiceId} className="flex justify-between gap-3">
                  <span>
                    {l.pro}
                    {l.feeCents > 0 ? <span className="tms-muted"> · fee {formatCents(l.feeCents)}</span> : null}
                    {l.leftCents > 0 ? <span className="tms-muted"> · {formatCents(l.leftCents)} stays open</span> : null}
                  </span>
                  <strong>{formatCents(l.paidCents)}</strong>
                </li>
              ))}
            </ul>
            <p className="tms-muted">
              {confirm.plan.payments.length === 1 ? 'One payment' : `${confirm.plan.payments.length} payments, one per customer,`} with this reference.
              {confirm.plan.feeCents > 0 ? ` OTR's fee is closed on each factored invoice as "${factorFeeReason(confirm.draft.feeBps)}".` : ''}
            </p>
          </div>
        </TmsDialog>
      )}
    </div>
  )
}
