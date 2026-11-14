// Relative: reached from a Lambda bundle, where the '@/' alias does not resolve.
import type { OtrReadiness } from './otrInvoice'

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
  /**
   * When this load's POD arrived, ISO, or null. Attached by the hook from the POD index.
   * A tick alone says a POD exists; this says whether it came in time to invoice on.
   */
  podUploadedAt?: string | null
  /** Pickup and delivery dates from the shipment (`settlementStopDates`), attached by the hook. */
  dates?: SettlementStopDates
}

/** A date on a settlement row, and whether it happened (`actual`) or is only the appointment. */
export interface SettlementDate { at: string | null; actual: boolean }
export interface SettlementStopDates { pickup: SettlementDate; delivery: SettlementDate }

interface DatedStop { type?: string; sequence?: number; appt?: string | null; arrivedAt?: string | null; departedAt?: string | null }

/**
 * Pickup: the first pickup's actual departure (else arrival), otherwise its appointment.
 * Delivery: the load's delivered time, else the last delivery's actual arrival (else departure),
 * otherwise its appointment. ISO strings; `actual` false means it is the appointment.
 */
export function settlementStopDates(stops: readonly DatedStop[], deliveredAt?: string | null): SettlementStopDates {
  const sorted = [...stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  const pu = sorted.find((s) => s.type === 'pickup')
  const de = [...sorted].reverse().find((s) => s.type === 'delivery')
  const puActual = pu?.departedAt || pu?.arrivedAt || null
  const deActual = deliveredAt || de?.arrivedAt || de?.departedAt || null
  return {
    pickup: puActual ? { at: puActual, actual: true } : { at: pu?.appt || null, actual: false },
    delivery: deActual ? { at: deActual, actual: true } : { at: de?.appt || null, actual: false },
  }
}

/** "11/12" in Central time, or "" — the office reads dates the way the dispatch board does. */
export function settlementDateLabel(d: SettlementDate | undefined): string {
  if (!d?.at) return ''
  const t = new Date(d.at)
  if (Number.isNaN(t.getTime())) return ''
  return t.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit' })
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
 * Dollars per mile for one load, or null when it cannot be said.
 *
 * ONE definition, used by the staff pay page and the driver app's settlement API, so the
 * figure an owner operator sees on their phone is the figure the office sees on the
 * desktop. Null rather than 0 or Infinity when miles are missing or zero: "$0.00/mi" reads
 * as a load that paid nothing, and that is a claim, not an absence.
 */
export function ratePerMile(freight: number | null | undefined, miles: number | null | undefined): number | null {
  if (freight == null || miles == null) return null
  if (!Number.isFinite(freight) || !Number.isFinite(miles) || miles <= 0) return null
  return round2(freight / miles)
}

/**
 * The week's rate per mile: freight over miles across the loads that HAVE miles. A load
 * with no miles is left out of both sides rather than counted as zero miles, which would
 * inflate the rate. Null when no load has miles. Display only; pay never reads it.
 */
export function totalRatePerMile(trips: ReadonlyArray<{ freightAmount: number | null | undefined; miles: number | null | undefined }>): { miles: number; rate: number | null } {
  let miles = 0
  let freight = 0
  for (const t of trips) {
    if (t.miles == null || !Number.isFinite(t.miles) || t.miles <= 0 || t.freightAmount == null) continue
    miles += t.miles
    freight += t.freightAmount
  }
  return { miles, rate: ratePerMile(freight, miles) }
}

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
