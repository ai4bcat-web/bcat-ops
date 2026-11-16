/** The Invoicing summary as two list cards beside the tabs; a division row filters the list. */
import { TmsListCard, breakdownListRows } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { divisionRows } from './arDivisionRows'
import { FACTORED_BUCKET_LABEL, FACTORED_BUCKET_ORDER, FACTORED_BUCKET_TITLE } from '@/lib/factoredOpen'
import { PAY_WINDOW_DAYS, type ArSummary } from './arSummary'

const invoices = (n: number) => `${n} ${n === 1 ? 'invoice' : 'invoices'}`

export function ArSummaryStrip({ summary, division, onDivision, onCollected }: {
  summary: ArSummary
  division: string | null
  onDivision: (key: string | null) => void
  /** "Collected this week / month" open Payments Received on that period (there is no Paid tab). */
  onCollected?: (period: 'week' | 'month') => void
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
          { key: 'otr', label: 'Factored, open', value: formatCents(summary.pendingOtrCents), sub: invoices(summary.pendingOtrCount), title: 'Every factored invoice not marked paid yet' },
          ...FACTORED_BUCKET_ORDER.filter((b) => summary.factored[b].count > 0).map((b) => ({
            key: `otr-${b}`, kind: 'sub' as const, label: FACTORED_BUCKET_LABEL[b], title: FACTORED_BUCKET_TITLE[b],
            value: formatCents(summary.factored[b].cents), sub: invoices(summary.factored[b].count),
          })),
          { key: 'shippers', label: 'Pending with shippers', value: formatCents(summary.pendingShippersCents), sub: invoices(summary.pendingShippersCount) },
          { key: 'late', label: 'Late', value: formatCents(summary.lateCents), sub: invoices(summary.lateCount), tone: summary.lateCents > 0 ? 'bad' : 'default' },
          { key: 'week', label: 'Collected this week', value: formatCents(summary.collectedWeekCents), sub: invoices(summary.collectedWeekCount), title: 'Invoices paid in full this week, by paid date. Opens Payments Received.', onClick: onCollected ? () => onCollected('week') : undefined },
          { key: 'month', label: 'Collected this month', value: formatCents(summary.collectedMonthCents), sub: invoices(summary.collectedMonthCount), title: 'Invoices paid in full this month, by paid date. Opens Payments Received.', onClick: onCollected ? () => onCollected('month') : undefined },
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
