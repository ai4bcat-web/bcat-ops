/**
 * The numbers an aging view leads with: what is owed, what is late, what has moved and
 * never been billed, and the lags either side of the bill — delivery to invoice, and
 * invoice to cash.
 *
 * One strip serves both ledgers. AR reads it as money owed to us; AP passes
 * `AP_STRIP_LABELS` and reads the same shapes as money we owe, with no billing lag of
 * our own to report — the carrier sends their invoice when they send it.
 *
 * A lag with nothing to measure renders as `—`, not `0 days`: no invoice has been paid
 * yet is a different fact from "paid the same day".
 *
 * On the MVMNT shell it is one card row: a `TmsCard` whose body is the figures side by
 * side, the same place the dashboard puts its KPI strip.
 */
import { TmsCard, TmsStatRow, type TmsStat } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { AR_STRIP_LABELS, type AgingStripLabels } from './agingStripLabels'

export interface AgingStripProps {
  /** Defaults to the AR wording, so every AR call site reads as it always has. */
  labels?: AgingStripLabels
  openCents: number
  lateCents: number
  deliveredNotInvoicedCents: number
  deliveredNotInvoicedCount: number
  avgDaysToInvoice?: number | null
  avgDaysToPay: number | null
  /** Which month `avgDaysToPay` was measured over, so the figure is not read as all-time. */
  paidMonthLabel: string
}

export function AgingStrip({
  labels = AR_STRIP_LABELS,
  openCents,
  lateCents,
  deliveredNotInvoicedCents,
  deliveredNotInvoicedCount,
  avgDaysToInvoice = null,
  avgDaysToPay,
  paidMonthLabel,
}: AgingStripProps) {
  const cells: TmsStat[] = [
    { label: labels.total, value: formatCents(openCents) },
    { label: labels.late, value: formatCents(lateCents), tone: lateCents > 0 ? 'bad' : 'default' },
    {
      label: labels.pending,
      value: formatCents(deliveredNotInvoicedCents),
      sub: `${deliveredNotInvoicedCount} ${labels.pendingUnit}${deliveredNotInvoicedCount === 1 ? '' : 's'}`,
    },
    ...(labels.lag
      ? [{
        label: labels.lag,
        value: avgDaysToInvoice === null ? '—' : `${avgDaysToInvoice}`,
        sub: 'delivery → invoice',
      }]
      : []),
    {
      label: labels.pay,
      value: avgDaysToPay === null ? '—' : `${avgDaysToPay}`,
      sub: paidMonthLabel,
    },
  ]

  return (
    <TmsCard title={labels.aria}>
      <TmsStatRow
        aria-label={labels.aria}
        columns={cells.length as 4 | 5}
        items={cells}
      />
    </TmsCard>
  )
}
