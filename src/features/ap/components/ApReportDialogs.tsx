/**
 * The Payables reports: a list report for Expected, Aging or Selected (rows plus totals by carrier),
 * and the cash-requirements report (what is due over the next 30 days, week by week). Each one
 * downloads as CSV and prints from the browser; printing hides everything but the report.
 */
import { Fragment, useMemo, useState } from 'react'
import { Download, Printer } from 'lucide-react'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { saveBlob } from '@/lib/download'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDay } from '@/features/ar/arViews'
import type { CarrierPaymentInfo } from '@/lib/apiClient'
import type { CarrierBillRecord } from '@/types/tms'
import {
  AP_REPORT_TITLE, apReportCsv, apReportRows, apReportTotals, cashRequirements, cashRequirementsCsv,
  type ApReportKind, type BillFactsIndex,
} from '../apQueue'

const KINDS: ApReportKind[] = ['expected', 'aging', 'selected']

function printReport(): void {
  document.body.classList.add('ap-printing')
  const done = () => { document.body.classList.remove('ap-printing'); window.removeEventListener('afterprint', done) }
  window.addEventListener('afterprint', done)
  window.print()
}

const PRINT_CSS = `.ap-report-table { border-collapse: collapse; }
.ap-report-table th, .ap-report-table td { padding: 4px 8px; border-bottom: 1px solid var(--tms-border, #e5e7eb); text-align: left; white-space: nowrap; }
.ap-report-table th { font-weight: 600; color: var(--tms-muted, #6b7280); }
.ap-report-table .text-right { text-align: right; }
@media print {
  body.ap-printing > *:not(.tms-portal) { display: none !important; }
  body.ap-printing .tms-dialog-overlay { display: none !important; }
  body.ap-printing .ap-report-noprint { display: none !important; }
  body.ap-printing .tms-portal { position: static !important; max-height: none !important; overflow: visible !important; box-shadow: none !important; }
}`

export function ApReportDialog({ kind, bills, facts, infos, asOf, onKind, onClose }: {
  kind: ApReportKind
  bills: readonly CarrierBillRecord[]
  facts: BillFactsIndex
  infos: readonly CarrierPaymentInfo[]
  asOf: string
  onKind: (kind: ApReportKind) => void
  onClose: () => void
}) {
  const rows = useMemo(() => apReportRows(bills, facts, infos, asOf), [bills, facts, infos, asOf])
  const { byCarrier, total } = useMemo(() => apReportTotals(rows), [rows])
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`${AP_REPORT_TITLE[kind]} — as of ${formatDay(asOf)}`}
      className="tms-dialog-xl"
      footer={(
        <span className="ap-report-noprint flex gap-2">
          <TmsButton variant="ghost" onClick={() => saveBlob(new Blob([apReportCsv(rows)], { type: 'text/csv' }), `ap-${kind}-${asOf}.csv`)}>
            <Download size={14} aria-hidden="true" /> CSV
          </TmsButton>
          <TmsButton variant="ghost" onClick={printReport}><Printer size={14} aria-hidden="true" /> Print / PDF</TmsButton>
          <TmsButton variant="ghost" onClick={onClose}>Close</TmsButton>
        </span>
      )}
    >
      <style>{PRINT_CSS}</style>
      <div className="ap-report-noprint mb-2 flex gap-1" role="tablist" aria-label="Report">
        {KINDS.map((k) => (
          <TmsButton key={k} size="sm" variant={k === kind ? 'primary' : 'secondary'} role="tab" aria-selected={k === kind} onClick={() => onKind(k)}>
            {AP_REPORT_TITLE[k]}
          </TmsButton>
        ))}
      </div>
      {rows.length === 0 ? <p className="tms-muted">No bills in this report.</p> : (
        <div className="overflow-x-auto">
          <table className="ap-report-table w-full text-xs tabular-nums">
            <thead>
              <tr>
                <th>PRO</th><th>PO</th><th>Carrier</th><th>Pay to</th><th>Invoice date</th><th>Due</th>
                <th className="text-right">Carrier pay</th><th className="text-right">QP fee</th><th className="text-right">Net</th><th className="text-right">Balance</th><th className="text-right">Days</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.billId}>
                  <td>{r.pro}</td><td>{r.po || '—'}</td><td>{r.carrier}</td><td>{r.payTo}</td>
                  <td>{r.invoiceDate ? formatDay(r.invoiceDate) : 'Pending'}</td>
                  <td>{r.dueAt ? `${r.dueEstimated ? '~' : ''}${formatDay(r.dueAt)}` : '—'}</td>
                  <td className="text-right">{formatCents(r.grossCents)}</td>
                  <td className="text-right">{r.feeCents ? formatCents(r.feeCents) : '—'}</td>
                  <td className="text-right">{formatCents(r.netCents)}</td>
                  <td className="text-right">{formatCents(r.balanceCents)}</td>
                  <td className="text-right">{r.daysAging ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="mt-4 mb-1 text-sm font-medium">Totals by carrier</h3>
          <table className="ap-report-table w-full text-xs tabular-nums">
            <thead><tr><th>Carrier</th><th className="text-right">Bills</th><th className="text-right">Carrier pay</th><th className="text-right">QP fees</th><th className="text-right">Net</th><th className="text-right">Balance</th></tr></thead>
            <tbody>
              {[...byCarrier, total].map((t) => (
                <tr key={t.carrier} className={t === total ? 'font-medium' : undefined}>
                  <td>{t.carrier}</td><td className="text-right">{t.count}</td><td className="text-right">{formatCents(t.grossCents)}</td>
                  <td className="text-right">{formatCents(t.feeCents)}</td><td className="text-right">{formatCents(t.netCents)}</td><td className="text-right">{formatCents(t.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.some((r) => r.dueEstimated) && <p className="mt-2 text-xs tms-muted">~ Estimated: the carrier's invoice date is not in yet; due = delivery date + terms.</p>}
        </div>
      )}
    </TmsDialog>
  )
}

export function CashRequirementsDialog({ bills, facts, infos, asOf, onClose }: {
  bills: readonly CarrierBillRecord[]
  facts: BillFactsIndex
  infos: readonly CarrierPaymentInfo[]
  asOf: string
  onClose: () => void
}) {
  const cash = useMemo(() => cashRequirements(apReportRows(bills, facts, infos, asOf), asOf), [bills, facts, infos, asOf])
  const [open, setOpen] = useState<string | null>(null)
  const buckets = [cash.pastDue, ...cash.weeks]
  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title={`Cash requirements — next 30 days from ${formatDay(asOf)}`}
      className="tms-dialog-xl"
      footer={(
        <span className="ap-report-noprint flex gap-2">
          <TmsButton variant="ghost" onClick={() => saveBlob(new Blob([cashRequirementsCsv(cash)], { type: 'text/csv' }), `ap-cash-requirements-${asOf}.csv`)}>
            <Download size={14} aria-hidden="true" /> CSV
          </TmsButton>
          <TmsButton variant="ghost" onClick={printReport}><Printer size={14} aria-hidden="true" /> Print / PDF</TmsButton>
          <TmsButton variant="ghost" onClick={onClose}>Close</TmsButton>
        </span>
      )}
    >
      <style>{PRINT_CSS}</style>
      <p className="mb-2 text-sm tms-muted">
        Every open payable (Expected, Aging and Selected) by due date, at what we still owe after quick-pay fees.
        Bills still waiting on the carrier's invoice date are placed by an estimated due date (delivery date + terms).
      </p>
      <table className="ap-report-table w-full text-sm tabular-nums">
        <thead><tr><th>Period</th><th className="text-right">Bills</th><th className="text-right">Amount</th><th className="text-right">Of which estimated</th></tr></thead>
        <tbody>
          {buckets.map((b) => (
            <Fragment key={b.key}>
              <tr>
                <td>
                  <button type="button" className="tms-link" aria-expanded={open === b.key} onClick={() => setOpen(open === b.key ? null : b.key)} disabled={b.count === 0}>
                    {b.label}
                  </button>
                </td>
                <td className="text-right">{b.count}</td>
                <td className="text-right" style={b.key === 'past-due' && b.cents > 0 ? { color: 'var(--tms-badge-red)' } : undefined}>{formatCents(b.cents)}</td>
                <td className="text-right tms-muted">{b.estimatedCents ? formatCents(b.estimatedCents) : '—'}</td>
              </tr>
              {open === b.key && b.rows.map((r) => (
                <tr key={`${b.key}-${r.billId}`} className="text-xs">
                  <td className="pl-6">PRO {r.pro} · {r.carrier} · {r.payTo} · due {r.dueAt ? `${r.dueEstimated ? '~' : ''}${formatDay(r.dueAt)}` : '—'}</td>
                  <td /><td className="text-right">{formatCents(r.balanceCents)}</td><td />
                </tr>
              ))}
            </Fragment>
          ))}
          <tr className="font-medium">
            <td>Next 30 days</td><td className="text-right">{cash.totalCount}</td><td className="text-right">{formatCents(cash.totalCents)}</td>
            <td className="text-right tms-muted">{cash.estimatedCents ? formatCents(cash.estimatedCents) : '—'}</td>
          </tr>
        </tbody>
      </table>
      {cash.laterCount > 0 && (
        <p className="mt-2 text-xs tms-muted">Not included: {cash.laterCount} bill{cash.laterCount === 1 ? '' : 's'} due after the 30 days ({formatCents(cash.laterCents)}).</p>
      )}
    </TmsDialog>
  )
}
