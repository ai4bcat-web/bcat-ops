/**
 * The Aging tab's body: one row per customer, a twisty that opens that customer's open invoices,
 * Expand all / Collapse all, sortable columns and a totals row that equals Open AR. Phones and
 * iPads get the same report as expandable cards.
 */
import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, Mail } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit'
import { AR_AGING_BUCKETS, AR_AGING_BUCKET_LABEL } from '@/lib/arAging'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDay } from '../arViews'
import {
  sortAgingCustomers,
  type AgingReport,
  type AgingReportCustomer,
  type AgingReportInvoice,
  type AgingSortKey,
} from '../agingReport'
import './agingReport.css'

const money = (cents: number) => (cents ? formatCents(cents) : '—')
const terms = (days: number | null) => (days == null ? '—' : `Net ${days}`)

export function AgingReportTable({
  report, onOpenInvoice, onPreview, onStatement, selected, onSelect, busy,
}: {
  report: AgingReport
  onOpenInvoice: (invoiceId: string) => void
  onPreview: (customerId: string, customerName: string) => void
  onStatement: (customerId: string, customerName: string) => void
  selected: string[]
  onSelect: (ids: string[]) => void
  busy: boolean
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [sort, setSort] = useState<{ key: AgingSortKey; dir: 'asc' | 'desc' }>({ key: 'total', dir: 'desc' })
  const rows = useMemo(() => sortAgingCustomers(report.customers, sort.key, sort.dir), [report.customers, sort])

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const allOpen = rows.length > 0 && rows.every((r) => open.has(r.customerId))
  const setAll = (on: boolean) => setOpen(on ? new Set(rows.map((r) => r.customerId)) : new Set())
  const pick = (id: string) => onSelect(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  const onSort = (key: AgingSortKey) => setSort((s) => (s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'customer' ? 'asc' : 'desc' }))

  const head = (key: AgingSortKey, label: string, right = true) => (
    <th scope="col" className={right ? 'tms-dg-right' : undefined} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="tms-aging-sort" onClick={() => onSort(key)} title={`Sort by ${label}`}>
        {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  )

  if (rows.length === 0) return <p className="tms-muted text-sm" style={{ padding: 16 }}>Nothing is owed.</p>

  return (
    <div className="tms-aging" data-testid="aging-report">
      <div className="tms-aging-bar">
        <TmsButton size="sm" variant="ghost" onClick={() => setAll(!allOpen)} aria-label={allOpen ? 'Collapse all customers' : 'Expand all customers'}>
          {allOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {allOpen ? 'Collapse all' : 'Expand all'}
        </TmsButton>
        <span className="tms-muted text-sm">{rows.length} customer{rows.length === 1 ? '' : 's'} · {report.count} open invoice{report.count === 1 ? '' : 's'} · {formatCents(report.totalCents)}</span>
      </div>

      {/* Desktop: the report as a table. */}
      <div className="tms-aging-table-wrap">
        <table className="tms-aging-table" aria-label="Aging by customer">
          <thead>
            <tr>
              <th scope="col" className="tms-aging-twisty-col"><span className="sr-only">Expand</span></th>
              <th scope="col" className="tms-aging-check-col"><span className="sr-only">Select</span></th>
              {head('customer', 'Customer', false)}
              {head('terms', 'Terms', false)}
              {AR_AGING_BUCKETS.map((b) => <Fragment key={b}>{head(b, AR_AGING_BUCKET_LABEL[b])}</Fragment>)}
              {head('total', 'Total open')}
              {head('pastDue', 'Past due')}
              {head('count', 'Invoices')}
              {head('oldest', 'Oldest')}
              {head('lastPaid', 'Last paid', false)}
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const isOpen = open.has(c.customerId)
              return (
                <Fragment key={c.customerId}>
                  <tr className={`tms-aging-cust${isOpen ? ' tms-open' : ''}`} data-testid="aging-customer-row">
                    <td className="tms-aging-twisty-col">
                      <button type="button" className="tms-aging-twisty" aria-expanded={isOpen}
                        aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${c.customerName}`} onClick={() => toggle(c.customerId)}>
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td className="tms-aging-check-col">
                      <input type="checkbox" aria-label={`Select ${c.customerName}`} checked={selected.includes(c.customerId)} onChange={() => pick(c.customerId)} />
                    </td>
                    <td><button type="button" className="tms-aging-name" onClick={() => toggle(c.customerId)}>{c.customerName}</button></td>
                    <td>{terms(c.termsDays)}</td>
                    {AR_AGING_BUCKETS.map((b) => <td key={b} className="tms-dg-right">{money(c.byBucket[b])}</td>)}
                    <td className="tms-dg-right"><strong>{formatCents(c.totalCents)}</strong></td>
                    <td className="tms-dg-right">{c.pastDueCents ? <span className="tms-aging-late">{formatCents(c.pastDueCents)}</span> : '—'}</td>
                    <td className="tms-dg-right">{c.count}</td>
                    <td className="tms-dg-right">{c.oldestDays}d</td>
                    <td>{formatDay(c.lastPaidAt) || '—'}</td>
                    <td className="tms-aging-actions">
                      <CustomerActions c={c} onPreview={onPreview} onStatement={onStatement} busy={busy} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="tms-aging-detail-row">
                      <td colSpan={14}>
                        <InvoiceTable invoices={c.invoices} onOpenInvoice={onOpenInvoice} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="tms-aging-total" data-testid="aging-total-row">
              <td colSpan={2} />
              <th scope="row">Total ({report.count} invoices)</th>
              <td />
              {AR_AGING_BUCKETS.map((b) => <td key={b} className="tms-dg-right">{money(report.byBucket[b])}</td>)}
              <td className="tms-dg-right"><strong>{formatCents(report.totalCents)}</strong></td>
              <td className="tms-dg-right">{money(report.pastDueCents)}</td>
              <td className="tms-dg-right">{report.count}</td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Phones and iPads: the same report as expandable cards. */}
      <ul className="tms-aging-cards" aria-label="Aging by customer (cards)">
        {rows.map((c) => {
          const isOpen = open.has(c.customerId)
          return (
            <li key={c.customerId} className="tms-aging-card">
              <button type="button" className="tms-aging-card-head" aria-expanded={isOpen} onClick={() => toggle(c.customerId)}>
                {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <span className="tms-aging-card-name">{c.customerName}</span>
                <span className="tms-aging-card-amt">{formatCents(c.totalCents)}</span>
              </button>
              <dl className="tms-aging-card-buckets">
                {AR_AGING_BUCKETS.map((b) => (
                  <div key={b}><dt>{AR_AGING_BUCKET_LABEL[b]}</dt><dd>{money(c.byBucket[b])}</dd></div>
                ))}
                <div><dt>Past due</dt><dd>{money(c.pastDueCents)}</dd></div>
                <div><dt>Terms</dt><dd>{terms(c.termsDays)}</dd></div>
                <div><dt>Oldest</dt><dd>{c.oldestDays}d</dd></div>
                <div><dt>Last paid</dt><dd>{formatDay(c.lastPaidAt) || '—'}</dd></div>
              </dl>
              <div className="tms-aging-card-actions">
                <label className="tms-aging-card-check">
                  <input type="checkbox" checked={selected.includes(c.customerId)} onChange={() => pick(c.customerId)} /> Select
                </label>
                <CustomerActions c={c} onPreview={onPreview} onStatement={onStatement} busy={busy} />
              </div>
              {isOpen && (
                <ul className="tms-aging-card-invoices">
                  {c.invoices.map((inv) => (
                    <li key={inv.id}>
                      <div className="tms-aging-card-inv-top">
                        <button type="button" className="tms-link" onClick={() => onOpenInvoice(inv.id)}>{inv.pro || inv.number}</button>
                        {inv.factored && <span className="tms-aging-otr">OTR</span>}
                        <span className="tms-aging-card-amt">{formatCents(inv.balanceCents)}</span>
                      </div>
                      <div className="tms-muted text-xs">
                        PO {inv.customerRef ?? '—'} · Inv {formatDay(inv.invoiceDate)} · Due {formatDay(inv.dueAt)}
                        {inv.daysPastDue > 0 ? ` · ${inv.daysPastDue}d past due` : ''} · {AR_AGING_BUCKET_LABEL[inv.bucket]}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
        <li className="tms-aging-card tms-aging-card-total">
          <div className="tms-aging-card-head"><span className="tms-aging-card-name">Total ({report.count} invoices)</span><span className="tms-aging-card-amt">{formatCents(report.totalCents)}</span></div>
        </li>
      </ul>
    </div>
  )
}

function CustomerActions({ c, onPreview, onStatement, busy }: {
  c: AgingReportCustomer
  onPreview: (customerId: string, customerName: string) => void
  onStatement: (customerId: string, customerName: string) => void
  busy: boolean
}) {
  return (
    <span className="tms-aging-btns">
      <TmsButton size="sm" variant="ghost" aria-label={`Preview aging email for ${c.customerName}`} onClick={() => onPreview(c.customerId, c.customerName)}>
        <Eye size={12} /> Preview email
      </TmsButton>
      <TmsButton size="sm" aria-label={`Email aging report to ${c.customerName}`} disabled={busy} onClick={() => onStatement(c.customerId, c.customerName)}>
        <Mail size={12} /> Email aging report
      </TmsButton>
    </span>
  )
}

function InvoiceTable({ invoices, onOpenInvoice }: { invoices: AgingReportInvoice[]; onOpenInvoice: (id: string) => void }) {
  return (
    <table className="tms-aging-inv" aria-label="Open invoices">
      <thead>
        <tr>
          <th scope="col">PRO</th>
          <th scope="col">Invoice #</th>
          <th scope="col">Customer ref (PO)</th>
          <th scope="col">Invoice date</th>
          <th scope="col">Due</th>
          <th scope="col" className="tms-dg-right">Age</th>
          <th scope="col" className="tms-dg-right">Past due</th>
          <th scope="col" className="tms-dg-right">Amount</th>
          <th scope="col" className="tms-dg-right">Paid</th>
          <th scope="col" className="tms-dg-right">Balance</th>
          <th scope="col">Bucket</th>
          <th scope="col">Billed</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((inv) => (
          <tr key={inv.id} data-testid="aging-invoice-row">
            <td><button type="button" className="tms-link" aria-label={`Open invoice for PRO ${inv.pro || inv.number}`} onClick={() => onOpenInvoice(inv.id)}>{inv.pro || '—'}</button></td>
            <td><button type="button" className="tms-link" aria-label={`Open invoice ${inv.number}`} onClick={() => onOpenInvoice(inv.id)}>{inv.number}</button></td>
            <td>{inv.customerRef ?? '—'}</td>
            <td>{formatDay(inv.invoiceDate)}</td>
            <td>{formatDay(inv.dueAt)}</td>
            <td className="tms-dg-right">{inv.ageDays}d</td>
            <td className="tms-dg-right">{inv.daysPastDue > 0 ? <span className="tms-aging-late">{inv.daysPastDue}d</span> : '—'}</td>
            <td className="tms-dg-right">{formatCents(inv.totalCents)}</td>
            <td className="tms-dg-right">{money(inv.paidCents)}</td>
            <td className="tms-dg-right"><strong>{formatCents(inv.balanceCents)}</strong></td>
            <td>{AR_AGING_BUCKET_LABEL[inv.bucket]}</td>
            <td>{inv.factored ? <span className="tms-aging-otr" title="Factored: OTR collects it; left off the customer's statement">OTR</span> : 'Manual'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
