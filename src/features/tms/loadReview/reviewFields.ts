import type { ShipmentListRow } from '@/hooks/useShipments'
import { docCellOf } from '@/features/shipments/shipmentViews'
import { formatCents } from '@/lib/invoiceBuild'
import { failingReasons, isOwnFleetReviewLoad, loadReviewFieldReasons, loadReviewNeeds, type LoadReviewFieldKey, type LoadReviewVerdict } from '@/lib/loadReview'
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

/**
 * What the POD / RC cell says, honestly: "On file" only when the document cache confirms the file. When the review check
 * passes without that confirmation, it names what it trusted: the documents were signed off by hand, the customer does
 * not require this document, or the order's document check found nothing missing.
 */
export function docBasisText(row: ShipmentListRow, docType: 'POD' | 'RATE_CON'): string {
  if (row.docsNotRequired?.includes(docType) && docCellOf(row, docType) !== 'PRESENT') return 'Not required'
  const cell = docCellOf(row, docType)
  if (cell === 'PRESENT') return 'On file'
  if (cell === 'NA') return 'N/A'
  if (row.docsOverrideAt) return 'Signed off (no file seen)'
  if (Array.isArray(row.docsMissing) && !row.docsMissing.includes(docType)) return 'Doc check OK (file not seen)'
  return ''
}

function carrierNames(row: ShipmentListRow): string {
  const names = (row.carriers ?? []).map((c) => c.name).filter((n): n is string => Boolean(n && n.trim()))
  return names.length > 0 ? names.join(', ') : (row.carrierName ?? '')
}

/** What a review column shows for a load: the actual value, or '' when there is none. */
export function reviewFieldText(row: ShipmentListRow, key: LoadReviewFieldKey): string {
  switch (key) {
    case 'customerRef': return row.customerReference ?? row.reference ?? ''
    case 'pod': return docBasisText(row, 'POD')
    case 'rateCon': return docBasisText(row, 'RATE_CON')
    case 'customerRate': { const c = customerRateCents(row); return c == null ? '' : formatCents(c) }
    // Own fleet (Ivan Cartage) has no carrier rate to enter, so neither it nor profit is checked (Ryne 2026-11-15).
    case 'carrierRate': return isOwnFleetReviewLoad(row) ? 'N/A (asset)' : row.costCents == null ? '' : formatCents(row.costCents)
    case 'profit': { if (isOwnFleetReviewLoad(row)) return 'N/A (asset)'; const p = profitOf(row); return p == null ? '' : formatCents(p.cents) } // dollars only (Ryne 2026-11-15: no GP %)
    case 'salesRep': return row.salesRepName ?? ''
    case 'revDivision': return row.revDivision?.replace(/_/g, ' ') ?? ''
    case 'delivered': { const t = deliveredText(row); return t === '—' ? '' : t }
    case 'carrier': return carrierNames(row)
    case 'customer': return [row.customerName, row.customerBillingSummary].filter(Boolean).join(' · ')
    case 'stops': return row.originCity || row.destinationCity ? `${row.originCity ?? '—'} → ${row.destinationCity ?? '—'}` : ''
    case 'other': return ''
  }
}

/** One review cell: its value, whether the check passes, and the reasons when it does not. */
export function reviewFieldCell(row: ShipmentListRow, verdict: LoadReviewVerdict | undefined, key: LoadReviewFieldKey): { text: string; ok: boolean | null; reasons: string[] } {
  const text = reviewFieldText(row, key)
  if (!verdict) return { text, ok: null, reasons: [] }
  const reasons = loadReviewFieldReasons(verdict)[key].map((r) => r.message)
  // A failing document has nothing on file to vouch for: the basis text would contradict the NEED.
  return { text: reasons.length > 0 && (key === 'pod' || key === 'rateCon') ? '' : text, ok: reasons.length === 0, reasons }
}

/** The Ready column: "Ready" when every field passes, else "N to fix: <the columns that need something>". */
export function reviewReadyText(verdict: LoadReviewVerdict | undefined): string {
  if (!verdict) return ''
  if (verdict.ok) return 'Ready'
  const needs = loadReviewNeeds(verdict)
  return `${needs.length} to fix: ${needs.join(', ')}`
}

/** What to fix, in plain words: each failing check's own sentence, once, in checklist order (the same reasons as the NEED marks). */
export function whatToFixItems(verdict: LoadReviewVerdict): string[] {
  return [...new Set(failingReasons(verdict).map((r) => r.message))]
}

export function whatToFixText(verdict: LoadReviewVerdict | undefined): string {
  if (!verdict) return '—'
  const items = whatToFixItems(verdict)
  return items.length === 0 ? 'Nothing' : items.join(' · ')
}
