/**
 * Carrier Sales queue logic — pure, shared by the page and the sidebar badge.
 *
 * `needsCoverCount` is the number the sidebar shows; it is `needsCover` applied to the
 * same rows the Needs-cover tab draws, so the badge and the tab cannot disagree.
 */
import type { AssignmentType, LoadWorkflowStatus, QuoteRecord, RateConStatus, ShipmentStatus } from '@/types/tms'

export type CoverageState = 'NEEDS_COVERAGE' | 'COVERED' | 'RATE_CON_SIGNED' | 'DISPATCHED'

export interface ActiveLegSummary {
  assignmentType?: AssignmentType | null
  loadStatus?: LoadWorkflowStatus | null
  carrierId?: string | null
  dispatchedAt?: string | null
  rateConSignedAt?: string | null
}

export function coverageStateOf(summary: ActiveLegSummary): CoverageState {
  if (!summary.assignmentType) return 'NEEDS_COVERAGE'
  if (summary.dispatchedAt || summary.loadStatus === 'DISPATCHED') return 'DISPATCHED'
  if (summary.rateConSignedAt) return 'RATE_CON_SIGNED'
  return 'COVERED'
}

/** The slice of a `ShipmentListRow` this queue reads; passing `ShipmentListRow[]` type-checks. */
export interface CarrierSalesRow {
  id: string
  number: string
  status: ShipmentStatus
  voidedAt?: string | null
  legacyImported?: boolean | null
  buildState?: 'BUILDING' | 'BUILT' | null
  pickupAppt?: string | null
  datPostedAt?: string | null
  customerName?: string | null
  originCity?: string | null
  destinationCity?: string | null
  equipmentType: string | null
  customerRateCents: number | null
  assignmentType: AssignmentType | null
  loadStatus: LoadWorkflowStatus | null
  carrierName: string | null
  carrierMc: string | null
  mcpStatus: string | null
  rateConStatus: RateConStatus | null
  rateConSentAt: string | null
  rateConSignedAt: string | null
  dispatchedAt: string | null
}

const NEEDS_COVER_STATUSES: readonly ShipmentStatus[] = ['OPEN', 'BOOKED', 'PLANNED']

function isLive(row: CarrierSalesRow): boolean {
  return !row.voidedAt && row.status !== 'CANCELED' && row.legacyImported !== true && row.buildState !== 'BUILDING'
}

/** A live, not-yet-hauled load nobody has covered. */
export function needsCover(row: CarrierSalesRow): boolean {
  if (!isLive(row)) return false
  if (!NEEDS_COVER_STATUSES.includes(row.status)) return false
  return row.assignmentType === null || row.assignmentType === 'NEED_TO_COVER'
}

export function needsCoverRows(rows: readonly CarrierSalesRow[]): CarrierSalesRow[] {
  return rows
    .filter(needsCover)
    .sort((a, b) => {
      // Soonest pickup first; a load with no appointment goes last.
      const at = a.pickupAppt ? Date.parse(a.pickupAppt) : Number.POSITIVE_INFINITY
      const bt = b.pickupAppt ? Date.parse(b.pickupAppt) : Number.POSITIVE_INFINITY
      const av = Number.isFinite(at) ? at : Number.POSITIVE_INFINITY
      const bv = Number.isFinite(bt) ? bt : Number.POSITIVE_INFINITY
      if (av !== bv) return av < bv ? -1 : 1
      return a.number.localeCompare(b.number)
    })
}

export function needsCoverCount(rows: readonly CarrierSalesRow[]): number {
  let n = 0
  for (const row of rows) if (needsCover(row)) n += 1
  return n
}

/**
 * Covered by a carrier but not yet picked up: the "rate con out / not signed" follow-up
 * list. `NEED_TO_COVER` is a placeholder assignment, not coverage, so it is excluded
 * even though `coverageStateOf` reads any assignment as covered.
 */
export function coveredRows(rows: readonly CarrierSalesRow[]): CarrierSalesRow[] {
  return rows
    .filter((row) => {
      if (!isLive(row)) return false
      if (!NEEDS_COVER_STATUSES.includes(row.status)) return false
      if (row.assignmentType !== 'CARRIER') return false
      const state = coverageStateOf(row)
      return state === 'COVERED' || state === 'RATE_CON_SIGNED'
    })
    .sort((a, b) => {
      // Unsigned rate cons first: that is what somebody chases.
      const as = a.rateConSignedAt ? 1 : 0
      const bs = b.rateConSignedAt ? 1 : 0
      if (as !== bs) return as - bs
      return (a.pickupAppt ?? '').localeCompare(b.pickupAppt ?? '') || a.number.localeCompare(b.number)
    })
}

/** Open carrier offers (BUY quotes) in the worklist. */
export function openOffers(open: readonly QuoteRecord[]): QuoteRecord[] {
  return open.filter((q) => q.side === 'BUY')
}

/** Open carrier offers per shipment id; offers with no shipment are not counted. */
export function offersByShipment(open: readonly QuoteRecord[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const q of openOffers(open)) {
    if (!q.shipmentId) continue
    out.set(q.shipmentId, (out.get(q.shipmentId) ?? 0) + 1)
  }
  return out
}
