/** The Invoicing summary as two list cards beside the tabs; a division row filters the list. */
import { TmsListCard, breakdownListRows } from '@/features/tms/kit'
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
    <>
      <TmsListCard
        title="Receivables"
        aria-label="Receivables totals"
        testId="ar-summary"
        rows={[
          { key: 'open', label: 'Open AR', value: formatCents(summary.openCents), sub: invoices(summary.openCount) },
          { key: 'otr', label: 'Pending with OTR', value: formatCents(summary.pendingOtrCents), sub: invoices(summary.pendingOtrCount) },
          { key: 'shippers', label: 'Pending with shippers', value: formatCents(summary.pendingShippersCents), sub: invoices(summary.pendingShippersCount) },
          { key: 'late', label: 'Late', value: formatCents(summary.lateCents), sub: invoices(summary.lateCount), tone: summary.lateCents > 0 ? 'bad' : 'default' },
          { key: 'week', label: 'Collected this week', value: formatCents(summary.collectedWeekCents), sub: invoices(summary.collectedWeekCount), title: 'Invoices paid in full this week, by paid date' },
          { key: 'month', label: 'Collected this month', value: formatCents(summary.collectedMonthCents), sub: invoices(summary.collectedMonthCount), title: 'Invoices paid in full this month, by paid date' },
          { key: 'otr-days', label: 'Days to pay · OTR', value: days(summary.otrDaysToPay), sub: `last ${PAY_WINDOW_DAYS} d`, title: `Submitted → funded, last ${PAY_WINDOW_DAYS} days` },
          { key: 'ship-days', label: 'Days to pay · shippers', value: days(summary.shipperDaysToPay), sub: `last ${PAY_WINDOW_DAYS} d`, title: `Invoice → paid, last ${PAY_WINDOW_DAYS} days` },
        ]}
      />
      {rows.length > 0 && (
        <TmsListCard
          title="Open AR by division"
          total={formatCents(openCents)}
          testId="ar-division-card"
          rows={breakdownListRows(rows, division, onDivision)}
        />
      )}
    </>
  )
}
