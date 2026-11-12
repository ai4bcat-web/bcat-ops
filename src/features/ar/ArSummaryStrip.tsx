/** The Invoicing summary above the tabs, as stat cards; a division row filters the list. */
import { TmsBreakdownCard, TmsStatRow } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { divisionRows } from './arDivisionRows'
import { PAY_WINDOW_DAYS, type ArSummary } from './arSummary'

const invoices = (n: number) => `${n} ${n === 1 ? 'invoice' : 'invoices'}`

export function ArSummaryStrip({ summary, division, onDivision }: {
  summary: ArSummary
  division: string | null
  onDivision: (key: string | null) => void
}) {
  const days = (d: number | null) => (d == null ? null : `${d} d`)
  const openCents = summary.byDivision.reduce((n, s) => n + s.cents, 0)
  const rows = divisionRows(summary.byDivision, openCents)
  return (
    <div className="flex flex-col gap-3" aria-label="AR summary" data-testid="ar-summary">
      <TmsStatRow
        columns="auto"
        compact
        caps
        aria-label="Receivables totals"
        items={[
          { key: 'otr', label: 'Pending with OTR', value: formatCents(summary.pendingOtrCents), sub: invoices(summary.pendingOtrCount) },
          { key: 'shippers', label: 'Pending with shippers', value: formatCents(summary.pendingShippersCents), sub: invoices(summary.pendingShippersCount) },
          { key: 'late', label: 'Late', value: formatCents(summary.lateCents), sub: invoices(summary.lateCount), tone: summary.lateCents > 0 ? 'bad' : 'default' },
          { key: 'otr-days', label: 'Days to pay · OTR', value: days(summary.otrDaysToPay), sub: `submitted → funded · last ${PAY_WINDOW_DAYS} days` },
          { key: 'ship-days', label: 'Days to pay · shippers', value: days(summary.shipperDaysToPay), sub: `invoice → paid · last ${PAY_WINDOW_DAYS} days` },
        ]}
      />
      {rows.length > 0 && (
        <TmsBreakdownCard
          title="Open AR by division"
          total={formatCents(openCents)}
          rows={rows}
          selected={division}
          onSelect={onDivision}
        />
      )}
    </div>
  )
}
