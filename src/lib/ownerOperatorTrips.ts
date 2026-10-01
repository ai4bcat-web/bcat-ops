import type { OtrReadiness } from '@/lib/otrInvoice'

/**
 * First owner-operator pay week: Sep 27 – Oct 3, 2026.
 *
 * This ONE date is the changeover for both halves of a settlement. Brokerage loads
 * delivered from this week on settle as owner-operator work, and so do that week's
 * charges — fixed expenses, the fuel card, one-off deductions. They are per driver-week
 * and belong to exactly one statement.
 *
 * It is deliberately a fixed date rather than "whichever page has trips this week": the
 * data-dependent version silently moved money, since importing the 9/27 Relay export
 * would have jumped a driver's owner-operator check by the full expense amount with
 * nobody touching that page.
 */
export const OWNER_OP_FIRST_PERIOD = '2026-09-27'

/**
 * Whether the owner-operator statement carries that week's charges. Earlier weeks are
 * Amazon's, where they were already paid.
 */
export function ownerOpCarriesWeeklyCharges(periodStart: string): boolean {
  return periodStart >= OWNER_OP_FIRST_PERIOD
}

/**
 * Every Amazon driver is an owner operator — `classificationForFleet` in src/lib/fileHub.ts
 * already treats the AMAZON fleet that way, since they run under a lease rather than as
 * employees. They therefore appear here on their brokerage loads WITHOUT changing their pay
 * group: the group still drives the Amazon page, and flipping it would have hidden every
 * already-paid Amazon week (5/31–9/13) from that page while the trips sat untouched.
 */
export const OWNER_OPERATOR_PAY_GROUPS = ['AMAZON', 'OWNER_OPERATOR'] as const

/** Null/missing groups default to AMAZON, matching the staff Amazon page. */
export function isOwnerOperatorGroup(payGroup: string | null | undefined): boolean {
  return (OWNER_OPERATOR_PAY_GROUPS as readonly string[]).includes(payGroup ?? 'AMAZON')
}

export interface OwnerOpLoadLike {
  id: string
  tmsId?: string | null
  aljexId?: string | null
  customer?: string | null
  miles?: number | null
  rate?: number | null
  deliveryAppt?: string | null
  deliveryDriverId?: string | null
  originCity?: string | null
  destinationCity?: string | null
  originName?: string | null
  destinationName?: string | null
}

export interface OwnerOpTrip {
  id: string
  loadId: string
  customer: string
  origin: string
  destination: string
  miles: number | null
  freightAmount: number // dollars = rate / 100
  deliveredAt: string
  /** Factoring readiness, computed after trips are built by the hook. */
  readiness?: OtrReadiness
}

/** If the requested period is before the first owner-operator week, clamp to it. */
export function ownerOpWeekAtOrAfterFirst(periodStart: string): string {
  if (periodStart >= OWNER_OP_FIRST_PERIOD) return periodStart
  return OWNER_OP_FIRST_PERIOD
}

function addDays(periodStart: string, days: number): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Load ids arrive dirty from the TMS import: 53 production loads carry the literal
 * string 'N/A' in `tmsId` rather than null, and `aljexId` is padded ("14452  ").
 * Treating 'N/A' as a real id would label every one of those loads identically on a
 * settlement, so a sentinel is no id at all.
 */
function cleanId(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  if (!v) return null
  return v.toUpperCase() === 'N/A' ? null : v
}

const firstText = (...values: (string | null | undefined)[]): string =>
  values.map((v) => (v ?? '').trim()).find((v) => v.length > 0) ?? ''

/** Loads this driver DELIVERED inside [periodStart, periodStart+6d], oldest first. */
export function ownerOpTripsFor(
  loads: OwnerOpLoadLike[],
  driverId: string,
  periodStart: string,
): OwnerOpTrip[] {
  const periodEnd = addDays(periodStart, 6)
  const out: OwnerOpTrip[] = []

  for (const load of loads) {
    if (load.deliveryDriverId !== driverId || !load.deliveryAppt || load.rate == null) continue

    const date = load.deliveryAppt.slice(0, 10)
    if (!date || date < periodStart || date > periodEnd) continue

    out.push({
      id: load.id,
      loadId: cleanId(load.tmsId) ?? cleanId(load.aljexId) ?? load.id,
      customer: firstText(load.customer),
      origin: firstText(load.originCity, load.originName),
      destination: firstText(load.destinationCity, load.destinationName),
      miles: load.miles ?? null,
      freightAmount: round2(load.rate / 100),
      deliveredAt: load.deliveryAppt,
    })
  }

  return out.sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt))
}
