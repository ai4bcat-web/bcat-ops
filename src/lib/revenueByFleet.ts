/**
 * Whose revenue is it — owner operators, Ivan's own drivers, or the box trucks?
 *
 * One revenue number answers "how did we do" and nothing else. These three fleets are paid
 * on entirely different terms — owner operators settle a percentage off brokerage loads,
 * Ivan's drivers are on the payroll, box trucks are their own line — so a single total
 * cannot tell you which part of the business moved.
 *
 * Two rules keep the breakdown honest.
 *
 * It RECONCILES. Broker-covered and driverless loads get their own buckets rather than
 * being dropped, so the parts always add up to the headline. A breakdown that silently
 * omits a category is one somebody eventually tries to subtract and cannot.
 *
 * It attributes to the PICKUP driver, falling back to the delivery driver — the same
 * attribution loadsPerDriver already uses on this page. On a split load that is a choice
 * rather than a truth, and it is made the same way everywhere so two charts on one screen
 * cannot disagree about whose load it was.
 *
 * Pure: no store, no clock.
 */
import type { Driver, Load } from '../types'

export type FleetBucket = 'OWNER_OP' | 'IVAN' | 'BOX_TRUCK' | 'BROKER' | 'UNASSIGNED'

export const FLEET_BUCKET_LABEL: Record<FleetBucket, string> = {
  OWNER_OP: 'Owner operators',
  IVAN: 'Ivan drivers',
  BOX_TRUCK: 'Box trucks',
  BROKER: 'Broker covered',
  UNASSIGNED: 'No driver',
}

/** Enough of a driver to place them in a fleet. */
export type FleetDriver = Pick<Driver, 'id' | 'fleetGroup' | 'driverType' | 'type'>

/**
 * Which fleet one driver belongs to.
 *
 * Box trucks come out BEFORE the owner-operator test. They are their own line of business
 * and the whole reason this breakdown exists; folding them into either neighbour would
 * leave the question that was asked unanswered.
 *
 * Otherwise this matches driverGroupOf in driverFilter.ts: `fleetGroup: 'AMAZON'` OR
 * `driverType: 'OWNER_OPERATOR'` means owner operator. Either is enough — they are meant
 * to agree, and one driver on file today says AMAZON and COMPANY at once.
 */
export function fleetBucketOf(driver: FleetDriver | undefined): FleetBucket {
  if (!driver) return 'UNASSIGNED'
  if (driver.type === 'broker') return 'BROKER'
  if (driver.fleetGroup === 'BOX_TRUCK') return 'BOX_TRUCK'
  if (driver.fleetGroup === 'AMAZON' || driver.driverType === 'OWNER_OPERATOR') return 'OWNER_OP'
  return 'IVAN'
}

export interface FleetRevenue {
  bucket: FleetBucket
  label: string
  /** Cents. */
  revenue: number
  loads: number
}

export interface RevenueSplit {
  byBucket: FleetRevenue[]
  total: number
  /** Loads carrying no rate at all — excluded from every figure above, and said so. */
  unrated: number
}

/** The bucket a load's revenue belongs to. */
export function loadFleetBucket(
  load: Pick<Load, 'pickupDriverId' | 'deliveryDriverId'>,
  driversById: Map<string, FleetDriver>,
): FleetBucket {
  const id = load.pickupDriverId ?? load.deliveryDriverId
  return fleetBucketOf(id ? driversById.get(id) : undefined)
}

/** The order the card lists them in: the three that were asked for, then the remainder. */
const ORDER: FleetBucket[] = ['OWNER_OP', 'IVAN', 'BOX_TRUCK', 'BROKER', 'UNASSIGNED']

export function revenueByFleet(
  loads: Pick<Load, 'rate' | 'pickupDriverId' | 'deliveryDriverId'>[],
  drivers: FleetDriver[],
): RevenueSplit {
  const byId = new Map(drivers.map((d) => [d.id, d]))
  const revenue = new Map<FleetBucket, { revenue: number; loads: number }>()
  let total = 0
  let unrated = 0

  for (const load of loads) {
    const rate = load.rate ?? 0
    if (!rate) { unrated++; continue }
    const bucket = loadFleetBucket(load, byId)
    const cur = revenue.get(bucket) ?? { revenue: 0, loads: 0 }
    cur.revenue += rate
    cur.loads++
    revenue.set(bucket, cur)
    total += rate
  }

  return {
    // Empty buckets are kept so the list does not change shape as work moves between
    // fleets — a row of figures that reorders itself is one people stop being able to scan.
    byBucket: ORDER.map((bucket) => ({
      bucket,
      label: FLEET_BUCKET_LABEL[bucket],
      revenue: revenue.get(bucket)?.revenue ?? 0,
      loads: revenue.get(bucket)?.loads ?? 0,
    })),
    total,
    unrated,
  }
}
