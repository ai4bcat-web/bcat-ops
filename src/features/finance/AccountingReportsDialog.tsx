/**
 * Reports on Receivable / Payable: pick a report, a date range, a customer or carrier and a
 * status, then Run to see the first rows and the count, and Download CSV for the whole file.
 * Internal only (margin and carrier pay appear here).
 */
import { useMemo, useState } from 'react'
import { Download, Play } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsInput, TmsSelect } from '@/features/tms/kit'
import { DateUsInput } from '@/features/shipments/form/DateUsInput'
import { downloadCsv } from '@/lib/directoryCsv'
import { graphqlErrorText } from '@/lib/apiClient'
import {
  buildAccountingReport, reportCsv, reportDef, reportFileName, reportsFor,
  type AccountingReportKind, type ReportFilters, type ReportSide, type ReportTable,
} from './accountingReports'
import { loadAccountingReport } from './loadAccountingReport'

const PREVIEW_ROWS = 25

const TABLE_CSS = `.acct-report-table { border-collapse: collapse; }
.acct-report-table th, .acct-report-table td { padding: 4px 8px; border-bottom: 1px solid var(--tms-border); text-align: left; white-space: nowrap; }
.acct-report-table th { font-weight: 600; color: var(--tms-muted); }
.acct-report-table .text-right { text-align: right; font-variant-numeric: tabular-nums; }`

const monthStart = (asOf: string) => `${asOf.slice(0, 7)}-01`

export function AccountingReportsDialog({ side, asOf, initialKind, onClose }: {
  side: ReportSide
  asOf: string
  /** Open on this report (a card link) instead of the first. */
  initialKind?: AccountingReportKind | null
  onClose: () => void
}) {
  const reports = useMemo(() => reportsFor(side), [side])
  const [kind, setKind] = useState<AccountingReportKind>(() => (initialKind && reports.some((r) => r.kind === initialKind) ? initialKind : reports[0].kind))
  const def = reportDef(kind)
  const [from, setFrom] = useState(() => monthStart(asOf))
  const [to, setTo] = useState(asOf)
  const [party, setParty] = useState('')
  const [status, setStatus] = useState('all')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ table: ReportTable; filters: ReportFilters } | null>(null)

  const filters: ReportFilters = { from: def.dateBasis ? from : '', to: def.dateBasis ? to : '', party, status, asOf }

  const pick = (next: AccountingReportKind) => {
    setKind(next)
    setStatus('all')
    setResult(null)
  }

  const run = (): Promise<ReportTable | null> => {
    setBusy(true)
    const f = filters
    return loadAccountingReport(kind, f)
      .then((data) => {
        const table = buildAccountingReport(kind, data, f)
        setResult({ table, filters: f })
        return table
      })
      .catch((e: unknown) => { toast.error(graphqlErrorText(e) || 'Could not run the report'); return null })
      .finally(() => setBusy(false))
  }

  const download = () => {
    const save = (table: ReportTable, f: ReportFilters) => {
      downloadCsv(reportFileName(kind, f), reportCsv(table))
      toast.success(`Downloaded ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`)
    }
    if (result) { save(result.table, result.filters); return }
    void run().then((table) => { if (table) save(table, filters) })
  }

  const changed = () => setResult(null)

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={side === 'AR' ? 'Receivable reports' : 'Payable reports'}
      description="Internal reports. Download as CSV to open in Excel or Google Sheets."
      className="tms-dialog-xl"
      footer={(
        <span className="flex flex-wrap gap-2">
          <TmsButton variant="ghost" onClick={onClose}>Close</TmsButton>
          <TmsButton variant="secondary" disabled={busy} onClick={() => void run()} data-testid="report-run">
            <Play size={14} aria-hidden="true" /> Run
          </TmsButton>
          <TmsButton disabled={busy} onClick={download} data-testid="report-download">
            <Download size={14} aria-hidden="true" /> Download CSV
          </TmsButton>
        </span>
      )}
    >
      <style>{TABLE_CSS}</style>
      <div className="grid gap-3" data-testid="accounting-reports">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="tms-muted">Report</span>
            <TmsSelect aria-label="Report" value={kind} onChange={(e) => pick(e.target.value as AccountingReportKind)}>
              {reports.map((r) => <option key={r.kind} value={r.kind}>{r.title}</option>)}
            </TmsSelect>
          </label>
          {def.dateBasis ? (
            <>
              <label className="grid gap-1 text-sm">
                <span className="tms-muted">{def.dateBasis} from</span>
                <DateUsInput value={from} onChange={(v) => { setFrom(v); changed() }} inputProps={{ 'aria-label': 'From date' }} />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="tms-muted">to</span>
                <DateUsInput value={to} onChange={(v) => { setTo(v); changed() }} inputProps={{ 'aria-label': 'To date' }} />
              </label>
            </>
          ) : <span className="text-sm tms-muted">As of today</span>}
          <label className="grid gap-1 text-sm">
            <span className="tms-muted">{def.partyLabel}</span>
            <TmsInput aria-label={def.partyLabel} placeholder="Any" value={party} onChange={(e) => { setParty(e.target.value); changed() }} />
          </label>
          {def.statuses.length > 1 && (
            <label className="grid gap-1 text-sm">
              <span className="tms-muted">Status</span>
              <TmsSelect aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); changed() }}>
                {def.statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </TmsSelect>
            </label>
          )}
        </div>
        {busy && <p className="text-sm tms-muted">Running…</p>}
        {result && !busy && (
          <>
            <p className="text-sm" data-testid="report-count">
              {result.table.rows.length} row{result.table.rows.length === 1 ? '' : 's'}
              {result.table.rows.length > PREVIEW_ROWS ? ` · showing the first ${PREVIEW_ROWS}; the CSV has them all` : ''}
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="acct-report-table text-sm" data-testid="report-preview">
                <thead><tr>{result.table.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>
                  {result.table.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                    <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === 'number' ? 'text-right' : undefined}>{v ?? ''}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </TmsDialog>
  )
}
