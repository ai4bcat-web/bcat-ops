import type { ShipmentListRow } from '@/hooks/useShipments'
import { docCellOf } from '@/features/shipments/shipmentViews'
import { formatCents } from '@/lib/invoiceBuild'
import { loadReviewFieldReasons, loadReviewNeeds, type LoadReviewFieldKey, type LoadReviewVerdict } from '@/lib/loadReview'
import { deliveredText } from './reviewStatus'

/** The customer's rate as the review check reads it (order revenue, else the shipment's). */
export function customerRateCents(row: ShipmentListRow): number | null {
  return row.orderRevenueCents ?? row.revenueCents ?? null
}

/** Profit and margin from the same two numbers the check uses; null when either is unknown. */
export function profitOf(row: ShipmentListRow): { cents: number; pct: number | null } | null {
  const revenue = customerRateCents(row)
  const cost = row.costCents ?? null
  if (revenue == null || cost == null) return null
  return { cents: revenue - cost, pct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null }
}

function carrierNames(row: ShipmentListRow): string {
  const names = (row.carriers ?? []).map((c) => c.name).filter((n): n is string => Boolean(n && n.trim()))
  return names.length > 0 ? names.join(', ') : (row.carrierName ?? '')
}

/** What a review column shows for a load: the actual value, or '' when there is none. */
export function reviewFieldText(row: ShipmentListRow, key: LoadReviewFieldKey): string {
  switch (key) {
    case 'customerRef': return row.customerReference ?? row.reference ?? ''
    case 'pod': return docCellOf(row, 'POD') === 'PRESENT' ? 'On file' : docCellOf(row, 'POD') === 'NA' ? 'N/A' : ''
    case 'rateCon': return docCellOf(row, 'RATE_CON') === 'PRESENT' ? 'On file' : docCellOf(row, 'RATE_CON') === 'NA' ? 'N/A' : ''
    case 'customerRate': { const c = customerRateCents(row); return c == null ? '' : formatCents(c) }
    case 'carrierRate': return row.costCents == null ? '' : formatCents(row.costCents)
    case 'profit': { const p = profitOf(row); return p == null ? '' : `${formatCents(p.cents)}${p.pct == null ? '' : ` (${p.pct}%)`}` }
    case 'salesRep': return row.salesRepName ?? ''
    case 'revDivision': return row.revDivision?.replace(/_/g, ' ') ?? ''
    case 'delivered': { const t = deliveredText(row); return t === '—' ? '' : t }
    case 'carrier': return carrierNames(row)
    case 'customer': return row.customerName ?? ''
    case 'stops': return row.originCity || row.destinationCity ? `${row.originCity ?? '—'} → ${row.destinationCity ?? '—'}` : ''
    case 'other': return ''
  }
}

/** One review cell: its value, whether the check passes, and the reasons when it does not. */
export function reviewFieldCell(row: ShipmentListRow, verdict: LoadReviewVerdict | undefined, key: LoadReviewFieldKey): { text: string; ok: boolean | null; reasons: string[] } {
  const text = reviewFieldText(row, key)
  if (!verdict) return { text, ok: null, reasons: [] }
  const reasons = loadReviewFieldReasons(verdict)[key].map((r) => r.message)
  return { text, ok: reasons.length === 0, reasons }
}

/** The Ready column: a check when every field passes, else what it needs. */
export function reviewReadyText(verdict: LoadReviewVerdict | undefined): string {
  if (!verdict) return ''
  return verdict.ok ? 'Ready' : `NEED ${loadReviewNeeds(verdict).join(', ')}`
}
