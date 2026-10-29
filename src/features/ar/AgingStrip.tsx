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
import { TmsCard } from '@/features/tms/kit'
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
  const cells: { label: string; value: string; hint?: string; tone?: 'late' }[] = [
    { label: labels.total, value: formatCents(openCents) },
    { label: labels.late, value: formatCents(lateCents), tone: lateCents > 0 ? 'late' : undefined },
    {
      label: labels.pending,
      value: formatCents(deliveredNotInvoicedCents),
      hint: `${deliveredNotInvoicedCount} ${labels.pendingUnit}${deliveredNotInvoicedCount === 1 ? '' : 's'}`,
    },
    ...(labels.lag
      ? [{
        label: labels.lag,
        value: avgDaysToInvoice === null ? '—' : `${avgDaysToInvoice}`,
        hint: 'delivery → invoice',
      }]
      : []),
    {
      label: labels.pay,
      value: avgDaysToPay === null ? '—' : `${avgDaysToPay}`,
      hint: paidMonthLabel,
    },
  ]

  return (
    <TmsCard title={labels.aria}>
      <dl aria-label={labels.aria} className="flex flex-wrap gap-3">
        {cells.map((c) => (
          <div key={c.label} className="min-w-[150px] flex-1">
            <dt className="text-[11px] font-semibold uppercase tracking-wider tms-muted">{c.label}</dt>
            <dd
              className="text-lg font-semibold"
              style={c.tone === 'late' ? { color: 'var(--tms-badge-red)' } : undefined}
            >
              {c.value}
            </dd>
            {c.hint && <p className="text-[11px] tms-muted">{c.hint}</p>}
          </div>
        ))}
      </dl>
    </TmsCard>
  )
}
