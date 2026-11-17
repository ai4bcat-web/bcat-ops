/**
 * The Aging by carrier tab's body, drawn like the receivables Aging report: one row per carrier, a twisty that opens
 * that carrier's open bills, Expand all / Collapse all, a search, and a totals row that equals the open AP total.
 * Phones and iPads get the same report as expandable cards. It reuses the AR report's styles on purpose.
 */
import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { TmsButton } from '@/features/tms/kit'
import { AGING_BUCKETS, AGING_BUCKET_LABEL } from '@/lib/arAging'
import { formatCents } from '@/lib/invoiceBuild'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import { formatDay } from '@/features/ar/arViews'
import type { ApAgingCarrier, ApAgingReport } from '../apAgingReport'
import { BILL_STATUS_LABEL } from '../apViews'
import '@/features/ar/components/agingReport.css'

const money = (cents: number) => (cents ? formatCents(cents) : '—')

export function ApAgingReportTable({ report }: { report: ApAgingReport }) {
  const [search, setSearch] = useState('')
  const [pastDueOnly, setPastDueOnly] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return report.carriers.filter((c) => {
      if (pastDueOnly && c.pastDueCents === 0) return false
      if (!q) return true
      return c.carrierName.toLowerCase().includes(q)
        || c.bills.some((b) => b.pro.toLowerCase().includes(q) || (b.billNumber ?? '').toLowerCase().includes(q) || b.payTo.toLowerCase().includes(q))
    })
  }, [report, search, pastDueOnly])

  const shown = useMemo(() => {
    const out = { count: 0, totalCents: 0, pastDueCents: 0, byBucket: Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<(typeof AGING_BUCKETS)[number], number> }
    for (const c of rows) {
      out.count += c.count
      out.totalCents += c.totalCents
      out.pastDueCents += c.pastDueCents
      for (const b of AGING_BUCKETS) out.byBucket[b] += c.byBucket[b]
    }
    return out
  }, [rows])
  const isFiltered = rows.length !== report.carriers.length

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allOpen = rows.length > 0 && rows.every((r) => open.has(r.carrierId))
  const setAll = (on: boolean) => setOpen(on ? new Set(rows.map((r) => r.carrierId)) : new Set())

  if (report.carriers.length === 0) return <p className="tms-muted text-sm" style={{ padding: 16 }}>We owe nothing.</p>

  return (
    <div className="tms-aging" data-testid="ap-aging-report">
      <div className="tms-aging-filters" role="group" aria-label="Filter the aging report">
        <label className="tms-aging-search">
          <Search size={13} aria-hidden="true" />
          <input id="ap-aging-search" type="search" placeholder="Search carrier, PRO, bill, pay to" value={search}
            onChange={(e) => setSearch(e.target.value)} aria-label="Search the aging report" />
        </label>
        <button type="button" className={`tms-aging-chip${pastDueOnly ? ' tms-on' : ''}`} aria-pressed={pastDueOnly} onClick={() => setPastDueOnly((v) => !v)}>
          Past due only
        </button>
      </div>
      <div className="tms-aging-bar">
        <TmsButton size="sm" variant="ghost" onClick={() => setAll(!allOpen)} aria-label={allOpen ? 'Collapse all carriers' : 'Expand all carriers'}>
          {allOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {allOpen ? 'Collapse all' : 'Expand all'}
        </TmsButton>
        <span className="tms-muted text-sm">
          {rows.length} carrier{rows.length === 1 ? '' : 's'} · {shown.count} open bill{shown.count === 1 ? '' : 's'} · {formatCents(shown.totalCents)}
          {isFiltered && <> · filtered (open AP {formatCents(report.totalCents)})</>}
        </span>
      </div>
      {rows.length === 0 && <p className="tms-muted text-sm" style={{ padding: 16 }}>No carriers match these filters.</p>}

      <div className="tms-aging-table-wrap">
        <table className="tms-aging-table" aria-label="Aging by carrier">
          <thead>
            <tr>
              <th scope="col" className="tms-aging-twisty-col"><span className="sr-only">Expand</span></th>
              <th scope="col">Carrier</th>
              {AGING_BUCKETS.map((b) => <th key={b} scope="col" className="tms-dg-right">{AGING_BUCKET_LABEL[b]}</th>)}
              <th scope="col" className="tms-dg-right">Total owed</th>
              <th scope="col" className="tms-dg-right">Past due</th>
              <th scope="col" className="tms-dg-right">Bills</th>
              <th scope="col" className="tms-dg-right">Oldest</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const isOpen = open.has(c.carrierId)
              return (
                <Fragment key={c.carrierId}>
                  <tr className={`tms-aging-cust${isOpen ? ' tms-open' : ''}`} data-testid="ap-aging-carrier-row">
                    <td className="tms-aging-twisty-col">
                      <button type="button" className="tms-aging-twisty" aria-expanded={isOpen}
                        aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${c.carrierName}`} onClick={() => toggle(c.carrierId)}>
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td><button type="button" className="tms-aging-name" onClick={() => toggle(c.carrierId)}>{c.carrierName || c.carrierId}</button></td>
                    {AGING_BUCKETS.map((b) => <td key={b} className="tms-dg-right">{money(c.byBucket[b])}</td>)}
                    <td className="tms-dg-right"><strong>{formatCents(c.totalCents)}</strong></td>
                    <td className="tms-dg-right">{c.pastDueCents ? <span className="tms-aging-late">{formatCents(c.pastDueCents)}</span> : '—'}</td>
                    <td className="tms-dg-right">{c.count}</td>
                    <td className="tms-dg-right">{c.oldestDays ? `${c.oldestDays}d` : '—'}</td>
                  </tr>
                  {isOpen && (
                    <tr className="tms-aging-detail-row">
                      <td colSpan={11}><BillTable carrier={c} /></td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="tms-aging-total" data-testid="ap-aging-total-row">
              <td />
              <th scope="row">{isFiltered ? 'Filtered total' : 'Total'} ({shown.count} bills)</th>
              {AGING_BUCKETS.map((b) => <td key={b} className="tms-dg-right">{money(shown.byBucket[b])}</td>)}
              <td className="tms-dg-right"><strong>{formatCents(shown.totalCents)}</strong></td>
              <td className="tms-dg-right">{money(shown.pastDueCents)}</td>
              <td className="tms-dg-right">{shown.count}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <ul className="tms-aging-cards" aria-label="Aging by carrier (cards)">
        {rows.map((c) => {
          const isOpen = open.has(c.carrierId)
          return (
            <li key={c.carrierId} className="tms-aging-card">
              <button type="button" className="tms-aging-card-head" aria-expanded={isOpen} onClick={() => toggle(c.carrierId)}>
                {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <span className="tms-aging-card-name">{c.carrierName || c.carrierId}</span>
                <span className="tms-aging-card-amt">{formatCents(c.totalCents)}</span>
              </button>
              <dl className="tms-aging-card-buckets">
                {AGING_BUCKETS.map((b) => <div key={b}><dt>{AGING_BUCKET_LABEL[b]}</dt><dd>{money(c.byBucket[b])}</dd></div>)}
                <div><dt>Past due</dt><dd>{money(c.pastDueCents)}</dd></div>
                <div><dt>Oldest</dt><dd>{c.oldestDays ? `${c.oldestDays}d` : '—'}</dd></div>
              </dl>
              {isOpen && (
                <ul className="tms-aging-card-invoices">
                  {c.bills.map((b) => (
                    <li key={b.id}>
                      <div className="tms-aging-card-inv-top">
                        <Link className="tms-link" to={shipmentEditorPath(b.shipmentId)}>{b.pro}</Link>
                        <span className="tms-aging-card-amt">{formatCents(b.balanceCents)}</span>
                      </div>
                      <div className="tms-muted text-xs">
                        Pay to {b.payTo} · Due {formatDay(b.dueAt)}{b.daysPastDue > 0 ? ` · ${b.daysPastDue}d past due` : ''} · {AGING_BUCKET_LABEL[b.bucket]}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
        <li className="tms-aging-card tms-aging-card-total">
          <div className="tms-aging-card-head"><span className="tms-aging-card-name">{isFiltered ? 'Filtered total' : 'Total'} ({shown.count} bills)</span><span className="tms-aging-card-amt">{formatCents(shown.totalCents)}</span></div>
        </li>
      </ul>
    </div>
  )
}

function BillTable({ carrier }: { carrier: ApAgingCarrier }) {
  return (
    <table className="tms-aging-inv" aria-label="Open bills">
      <thead>
        <tr>
          <th scope="col">PRO</th>
          <th scope="col">Bill #</th>
          <th scope="col">Pay to</th>
          <th scope="col">Due</th>
          <th scope="col" className="tms-dg-right">Past due</th>
          <th scope="col" className="tms-dg-right">Amount</th>
          <th scope="col">Bucket</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {carrier.bills.map((b) => (
          <tr key={b.id} data-testid="ap-aging-bill-row">
            <td><Link className="tms-link" to={shipmentEditorPath(b.shipmentId)} aria-label={`Open PRO ${b.pro}`}>{b.pro}</Link></td>
            <td>{b.billNumber ?? '—'}</td>
            <td>{b.payTo}</td>
            <td>{formatDay(b.dueAt)}</td>
            <td className="tms-dg-right">{b.daysPastDue > 0 ? <span className="tms-aging-late">{b.daysPastDue}d</span> : '—'}</td>
            <td className="tms-dg-right"><strong>{formatCents(b.balanceCents)}</strong>{b.quickPay ? ' · quick pay' : ''}</td>
            <td>{AGING_BUCKET_LABEL[b.bucket]}</td>
            <td>{BILL_STATUS_LABEL[b.status]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
