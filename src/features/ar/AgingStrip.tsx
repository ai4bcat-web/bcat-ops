/**
 * The five numbers the Aging tab leads with: what is owed, what is late, what has been
 * delivered and never billed, and the two lags either side of the invoice — delivery to
 * invoice, and invoice to cash.
 *
 * A lag with nothing to measure renders as `—`, not `0 days`: no invoice has been paid
 * yet is a different fact from "paid the same day".
 */
import { formatCents } from '@/lib/invoiceBuild'

export interface AgingStripProps {
  openCents: number
  lateCents: number
  deliveredNotInvoicedCents: number
  deliveredNotInvoicedCount: number
  avgDaysToInvoice: number | null
  avgDaysToPay: number | null
  /** Which month `avgDaysToPay` was measured over, so the figure is not read as all-time. */
  paidMonthLabel: string
}

export function AgingStrip({
  openCents,
  lateCents,
  deliveredNotInvoicedCents,
  deliveredNotInvoicedCount,
  avgDaysToInvoice,
  avgDaysToPay,
  paidMonthLabel,
}: AgingStripProps) {
  const cells: { label: string; value: string; hint?: string; tone?: 'late' }[] = [
    { label: 'Open AR', value: formatCents(openCents) },
    { label: 'Late', value: formatCents(lateCents), tone: lateCents > 0 ? 'late' : undefined },
    {
      label: 'Delivered, not invoiced',
      value: formatCents(deliveredNotInvoicedCents),
      hint: `${deliveredNotInvoicedCount} order${deliveredNotInvoicedCount === 1 ? '' : 's'}`,
    },
    {
      label: 'Avg days to invoice',
      value: avgDaysToInvoice === null ? '—' : `${avgDaysToInvoice}`,
      hint: 'delivery → invoice',
    },
    {
      label: 'Avg days to pay',
      value: avgDaysToPay === null ? '—' : `${avgDaysToPay}`,
      hint: paidMonthLabel,
    },
  ]

  return (
    <dl aria-label="AR totals" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {cells.map((c) => (
        <div key={c.label} className="rounded-md border border-border bg-card px-3 py-2">
          <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.label}</dt>
          <dd className={c.tone === 'late' ? 'text-base font-semibold text-destructive' : 'text-base font-semibold'}>
            {c.value}
          </dd>
          {c.hint && <p className="text-[11px] text-muted-foreground">{c.hint}</p>}
        </div>
      ))}
    </dl>
  )
}
