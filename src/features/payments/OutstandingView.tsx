/**
 * Payments received → Outstanding: every open invoice grouped by customer. Tick the invoices a check
 * pays, adjust each amount, enter the check # and date, and "Receive payments" posts ONE payment for
 * that customer (RECORD_PAYMENT, through a read-back first). Factored invoices sit in their own group
 * with no tick boxes: OTR collects those.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsInput, TmsSelect } from '@/features/tms/kit'
import { AR_PAYMENT_METHOD_LABEL, formatDay } from '@/features/ar/arViews'
import { useCustomerPaymentFacts } from '@/hooks/useCustomerPaymentFacts'
import { graphqlErrorText, recordPayment } from '@/lib/apiClient'
import { termsVsActualText } from '@/lib/daysToPay'
import { formatCents } from '@/lib/invoiceBuild'
import type { ArPaymentMethod, CustomerRecord, InvoiceRecord } from '@/types/tms'
import {
  FACTORED_GROUP, groupOutstanding, planReceive, recordPaymentInput,
  type OutstandingGroup, type OutstandingRow, type ReceiveDraft, type ReceivePlan,
} from './outstanding'

const METHODS: ArPaymentMethod[] = ['CHECK', 'ACH', 'WIRE', 'CARD', 'ZELLE', 'OTHER']

interface GroupForm { reference: string; receivedAt: string; method: ArPaymentMethod }

const invoicePath = (id: string) => `/tms/invoicing/invoices/${encodeURIComponent(id)}`
const dollars = (cents: number) => (cents / 100).toFixed(2)

export function OutstandingView({ invoices, customers, loading, asOf, onReceived }: {
  invoices: InvoiceRecord[]
  customers: Map<string, CustomerRecord>
  loading: boolean
  asOf: string
  onReceived: () => void
}) {
  const groups = useMemo(
    () => groupOutstanding(invoices, (id, fallback) => customers.get(id)?.name ?? fallback, asOf),
    [invoices, customers, asOf],
  )
  const customerIds = useMemo(() => groups.filter((g) => g.receivable).map((g) => g.key), [groups])
  const [factsVersion, setFactsVersion] = useState(0)
  const facts = useCustomerPaymentFacts(customerIds, factsVersion)

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [ticked, setTicked] = useState<Record<string, string>>({})
  const [forms, setForms] = useState<Record<string, GroupForm>>({})
  const [confirm, setConfirm] = useState<{ group: OutstandingGroup; draft: ReceiveDraft; plan: ReceivePlan } | null>(null)
  const [posting, setPosting] = useState(false)
  const [errors, setErrors] = useState<Record<string, string[]>>({})

  const formOf = (key: string): GroupForm => forms[key] ?? { reference: '', receivedAt: asOf, method: 'CHECK' }
  const setForm = (key: string, patch: Partial<GroupForm>) => setForms((f) => ({ ...f, [key]: { ...formOf(key), ...patch } }))
  const toggleRow = (row: OutstandingRow) => setTicked((t) => {
    const next = { ...t }
    if (row.invoiceId in next) delete next[row.invoiceId]
    else next[row.invoiceId] = dollars(row.balanceCents)
    return next
  })
  const tickedIn = (g: OutstandingGroup) => g.rows.filter((r) => r.invoiceId in ticked)
  const toggleAll = (g: OutstandingGroup) => setTicked((t) => {
    const next = { ...t }
    const all = g.rows.every((r) => r.invoiceId in next)
    for (const r of g.rows) {
      if (all) delete next[r.invoiceId]
      else if (!(r.invoiceId in next)) next[r.invoiceId] = dollars(r.balanceCents)
    }
    return next
  })
  const toggleGroup = (key: string) => setCollapsed((c) => {
    const next = new Set(c)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const draftOf = (g: OutstandingGroup): ReceiveDraft => {
    const f = formOf(g.key)
    return { customerId: g.key, lines: tickedIn(g).map((row) => ({ row, amount: ticked[row.invoiceId] })), ...f }
  }
  const startReceive = (g: OutstandingGroup) => {
    const draft = draftOf(g)
    const plan = planReceive(draft)
    setErrors((e) => ({ ...e, [g.key]: plan.errors }))
    if (plan.ok) setConfirm({ group: g, draft, plan })
  }
  const post = () => {
    if (!confirm) return
    setPosting(true)
    recordPayment(recordPaymentInput(confirm.draft, confirm.plan, crypto.randomUUID()))
      .then((res) => {
        toast.success(res.duplicate ? 'That payment was already posted' : `Received ${formatCents(res.payment.amountCents)} from ${confirm.group.label}`)
        setTicked((t) => {
          const next = { ...t }
          for (const a of confirm.plan.applications) delete next[a.invoiceId]
          return next
        })
        setForms((f) => { const next = { ...f }; delete next[confirm.group.key]; return next })
        setConfirm(null)
        setFactsVersion((v) => v + 1)
        onReceived()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'The payment could not be posted'))
      .finally(() => setPosting(false))
  }

  if (groups.length === 0) return <p className="tms-muted text-sm" style={{ padding: 16 }}>{loading ? 'Loading…' : 'Nothing is outstanding.'}</p>

  const totalOpen = groups.reduce((s, g) => s + g.openCents, 0)
  const totalCount = groups.reduce((s, g) => s + g.rows.length, 0)

  return (
    <div className="pr-out" data-testid="payments-outstanding">
      <p className="tms-muted text-sm pr-out-sum">
        {groups.filter((g) => g.receivable).length} customers · {totalCount} open invoices · {formatCents(totalOpen)}
      </p>
      {groups.map((g) => {
        const isOpen = !collapsed.has(g.key)
        const picked = tickedIn(g)
        const f = formOf(g.key)
        const runningCents = picked.reduce((s, r) => s + Math.max(0, Math.round(Number((ticked[r.invoiceId] ?? '').replace(/[$,\s]/g, '')) * 100) || 0), 0)
        const allPicked = g.rows.length > 0 && picked.length === g.rows.length
        const customer = g.receivable ? customers.get(g.key) : undefined
        const d2p = g.receivable ? facts.daysToPayByCustomer.get(g.key) : undefined
        return (
          <section key={g.key} className={`pr-out-group${g.receivable ? '' : ' pr-out-otr'}`} data-testid="outstanding-group">
            <header className="pr-out-head">
              <button type="button" className="pr-out-twisty" aria-expanded={isOpen} onClick={() => toggleGroup(g.key)}
                aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${g.label}`}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <strong className="pr-out-name">{g.label}</strong>
              <span className="tms-muted text-sm">{g.rows.length} invoice{g.rows.length === 1 ? '' : 's'} · {formatCents(g.openCents)} open</span>
              {g.receivable
                ? <span className="pr-out-d2p text-sm" data-testid="outstanding-days-to-pay">{termsVsActualText(customer?.paymentTermsDays, d2p)}</span>
                : <span className="tms-muted text-sm">OTR collects these; they can't be received here.</span>}
            </header>
            {isOpen && (
              <>
                <div className="pr-out-table-wrap">
                  <table className="pr-out-table" aria-label={`${g.label} open invoices`}>
                    <thead>
                      <tr>
                        <th scope="col" className="pr-out-check">
                          {g.receivable && <input type="checkbox" aria-label={`Select all for ${g.label}`} checked={allPicked} onChange={() => toggleAll(g)} />}
                        </th>
                        <th scope="col">Invoice</th>
                        {g.key === FACTORED_GROUP && <th scope="col">Customer</th>}
                        <th scope="col">PO</th>
                        <th scope="col">Invoiced</th>
                        <th scope="col">Due</th>
                        <th scope="col" className="pr-right">Days out</th>
                        <th scope="col" className="pr-right">Amount</th>
                        <th scope="col" className="pr-right">Paid</th>
                        <th scope="col" className="pr-right">Balance</th>
                        {g.receivable && <th scope="col" className="pr-right">Amount paid</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map((r) => {
                        const on = r.invoiceId in ticked
                        return (
                          <tr key={r.invoiceId} className={on ? 'pr-out-on' : undefined}>
                            <td className="pr-out-check">
                              {g.receivable && <input type="checkbox" aria-label={`Select ${r.pro}`} checked={on} onChange={() => toggleRow(r)} />}
                            </td>
                            <td>
                              <Link to={invoicePath(r.invoiceId)}>{r.pro}</Link>
                              {r.factored && <TmsBadge tone="blue" className="pr-out-otr-tag">OTR</TmsBadge>}
                            </td>
                            {g.key === FACTORED_GROUP && <td>{customers.get(r.customerId)?.name ?? r.customerId}</td>}
                            <td>{r.po ?? '—'}</td>
                            <td>{formatDay(r.invoiceDate)}</td>
                            <td>{formatDay(r.dueAt)}</td>
                            <td className="pr-right">{r.daysOutstanding}d</td>
                            <td className="pr-right">{formatCents(r.totalCents)}</td>
                            <td className="pr-right">{r.paidCents ? formatCents(r.paidCents) : '—'}</td>
                            <td className="pr-right"><strong>{formatCents(r.balanceCents)}</strong></td>
                            {g.receivable && (
                              <td className="pr-right">
                                <TmsInput className="pr-out-amt" inputMode="decimal" aria-label={`Amount paid on ${r.pro}`} disabled={!on}
                                  value={on ? ticked[r.invoiceId] : ''} placeholder={on ? '' : '—'}
                                  onChange={(e) => setTicked((t) => ({ ...t, [r.invoiceId]: e.target.value }))} />
                              </td>
                            )}
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
                          {g.receivable && <input type="checkbox" aria-label={`Select ${r.pro}`} checked={on} onChange={() => toggleRow(r)} />}
                          <Link to={invoicePath(r.invoiceId)}>{r.pro}</Link>
                          {r.factored && <TmsBadge tone="blue">OTR</TmsBadge>}
                          <strong className="pr-out-card-amt">{formatCents(r.balanceCents)}</strong>
                        </div>
                        <div className="tms-muted text-xs">PO {r.po ?? '—'} · Inv {formatDay(r.invoiceDate)} · Due {formatDay(r.dueAt)} · {r.daysOutstanding}d out</div>
                        {g.receivable && on && (
                          <TmsInput inputMode="decimal" aria-label={`Amount paid on ${r.pro}`} value={ticked[r.invoiceId]}
                            onChange={(e) => setTicked((t) => ({ ...t, [r.invoiceId]: e.target.value }))} />
                        )}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
            {g.receivable && picked.length > 0 && (
              <div className="pr-out-bar" data-testid="receive-bar">
                <TmsSelect aria-label="Method" value={f.method} onChange={(e) => setForm(g.key, { method: e.target.value as ArPaymentMethod })}>
                  {METHODS.map((m) => <option key={m} value={m}>{AR_PAYMENT_METHOD_LABEL[m]}</option>)}
                </TmsSelect>
                <TmsInput aria-label={f.method === 'CHECK' ? 'Check number' : 'Reference'} placeholder={f.method === 'CHECK' ? 'Check #' : 'Reference'}
                  value={f.reference} onChange={(e) => setForm(g.key, { reference: e.target.value })} />
                <TmsInput type="date" aria-label="Payment date" value={f.receivedAt} onChange={(e) => setForm(g.key, { receivedAt: e.target.value })} />
                <span className="pr-out-total">{picked.length} invoice{picked.length === 1 ? '' : 's'} · <strong>{formatCents(runningCents)}</strong></span>
                <TmsButton variant="primary" size="sm" onClick={() => startReceive(g)} data-testid="receive-payments">Receive payments</TmsButton>
                {(errors[g.key] ?? []).length > 0 && (
                  <ul className="pr-out-errors" role="alert">
                    {errors[g.key].map((e) => <li key={e}>{e}</li>)}
                  </ul>
                )}
              </div>
            )}
          </section>
        )
      })}

      {confirm && (
        <TmsDialog
          open
          onOpenChange={(open) => { if (!open && !posting) setConfirm(null) }}
          title={`Receive ${formatCents(confirm.plan.amountCents)} from ${confirm.group.label}`}
          footer={
            <>
              <TmsButton variant="ghost" disabled={posting} onClick={() => setConfirm(null)}>Back</TmsButton>
              <TmsButton variant="primary" disabled={posting} onClick={post} data-testid="receive-confirm">
                {posting ? 'Posting…' : 'Receive payments'}
              </TmsButton>
            </>
          }
        >
          <div className="flex flex-col gap-2 text-sm" data-testid="receive-readback">
            <p>
              {AR_PAYMENT_METHOD_LABEL[confirm.draft.method]}
              {confirm.draft.reference.trim() ? <> #<strong>{confirm.draft.reference.trim()}</strong></> : null}
              {' '}· received {formatDay(confirm.draft.receivedAt)}
            </p>
            <ul className="flex flex-col gap-1">
              {confirm.plan.applications.map((a) => {
                const row = confirm.draft.lines.find((l) => l.row.invoiceId === a.invoiceId)?.row
                const partial = row && a.amountCents < row.balanceCents
                return (
                  <li key={a.invoiceId} className="flex justify-between gap-3">
                    <span>{row?.pro ?? a.invoiceId}{partial ? <span className="tms-muted"> · partial, {formatCents((row?.balanceCents ?? 0) - a.amountCents)} left</span> : null}</span>
                    <strong>{formatCents(a.amountCents)}</strong>
                  </li>
                )
              })}
            </ul>
            <p className="tms-muted">One payment for this customer. Each invoice above is marked paid (or partly paid) by it.</p>
          </div>
        </TmsDialog>
      )}
    </div>
  )
}

