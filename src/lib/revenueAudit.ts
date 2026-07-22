// Revenue audit — explains, load by load, why a fleet's monthly revenue is what it is.
// Replicates the EXACT attribution rules in fleetProfitability.ts / useFleetProfitability
// so the buckets here always reconcile with the P&L "Revenue" number.
import type { Equipment, FleetGroup } from '@/types/equipment'
import type { Load, Driver } from '@/types'
import { ORPHAN_UNITS_BY_GROUP, orphanTruckId } from './fleetGroups'
import { isBoxTruckUnit } from './boxTruckProfit'
import type { DateRange } from './fleetProfitability'

export type AuditBucket =
  | 'counted'        // on a member truck of THIS fleet → in the revenue total
  | 'zeroRate'       // on a member truck but rate is null/0 (counts as $0)
  | 'unattributed'   // company driver, no assigned truck at all
  | 'boxTruck'       // on a brokered box truck (#3890) — shown separately in Box Truck P&L
  | 'otherFleet'     // resolved to a truck that isn't in THIS fleet (e.g. Amazon)
  | 'broker'         // broker/3PL covered — intentionally excluded
  | 'outOfRange'     // delivered outside the month (see deliveredElsewhere)

export interface AuditRow {
  id: string
  ref: string            // Pro/Aljex id for display
  route: string          // origin → destination
  customer: string | null
  rate: number           // dollars
  deliveryDate: string   // YYYY-MM-DD
  pickupDate: string     // YYYY-MM-DD
  driverId: string | null
  driverName: string | null
  truckLabel: string | null
  bucket: AuditBucket
}

export interface RevenueAudit {
  countedTotal: number       // == the P&L Revenue number for this fleet+month
  buckets: Record<AuditBucket, { total: number; rows: AuditRow[] }>
  // Loads picked up in this month but delivered in another month (why revenue "moved").
  pickedUpThisMonthDeliveredLater: { total: number; count: number }
}

const emptyBucket = () => ({ total: 0, rows: [] as AuditRow[] })

function ymd(iso: string): string { return iso.slice(0, 10) }

export function auditFleetRevenue(params: {
  loads: Load[]
  drivers: Driver[]
  equipment: Equipment[]
  range: DateRange
  group: FleetGroup
}): RevenueAudit {
  const { loads, drivers, equipment, range, group } = params

  // ── Members of THIS fleet — same rule as useFleetProfitability (box trucks excluded) ──
  const memberIds = new Set<string>()
  const boxTruckIds = new Set<string>()   // equipment ids for #3890 etc. (for bucketing)
  for (const e of equipment) {
    if (e.type !== 'truck') continue
    if (isBoxTruckUnit(e.unitNumber)) { boxTruckIds.add(e.id); continue }
    if (e.fleetGroup === group) memberIds.add(e.id)
  }
  const equipTruckUnits = new Set(equipment.filter((e) => e.type === 'truck').map((e) => e.unitNumber))
  for (const unit of ORPHAN_UNITS_BY_GROUP[group] ?? []) {
    if (!equipTruckUnits.has(unit)) memberIds.add(orphanTruckId(unit))
  }

  // Driver + truck lookup tables (assignment + broker flag mirror the engine).
  const driverById = new Map(drivers.map((d) => [d.id, d]))
  const truckForDriver = new Map<string, string>()
  const brokerDrivers = new Set<string>()
  for (const d of drivers) {
    if (d.assignedTruckId) truckForDriver.set(d.id, d.assignedTruckId)
    if (d.type === 'broker') brokerDrivers.add(d.id)
  }
  const truckById = new Map(equipment.map((e) => [e.id, e]))
  const truckLabelFor = (truckId?: string | null): string | null => {
    if (!truckId) return null
    if (truckId.startsWith('motive:')) return `#${truckId.slice('motive:'.length)}`
    const e = truckById.get(truckId)
    return e ? `#${e.unitNumber}` : truckId
  }

  const buckets: Record<AuditBucket, { total: number; rows: AuditRow[] }> = {
    counted: emptyBucket(), zeroRate: emptyBucket(), unattributed: emptyBucket(),
    boxTruck: emptyBucket(), otherFleet: emptyBucket(), broker: emptyBucket(), outOfRange: emptyBucket(),
  }
  let pickedUpThisMonthDeliveredLater = 0
  let pickedUpThisMonthDeliveredLaterCount = 0

  for (const load of loads) {
    const deliveryDate = ymd(load.deliveryAppt)
    const pickupDate = load.pickupAppt ? ymd(load.pickupAppt) : ''
    const inRange = deliveryDate >= range.start && deliveryDate <= range.end
    const rev = (load.rate ?? 0) / 100
    const driverId = load.deliveryDriverId ?? undefined
    const driverName = driverId ? driverById.get(driverId)?.name ?? null : null
    const resolvedTruck = load.truckId ?? (driverId ? truckForDriver.get(driverId) : undefined)

    // Track loads that will bill NEXT month (picked up now, delivered later) — the
    // most common "where did my revenue go" cause.
    if (!inRange && pickupDate >= range.start && pickupDate <= range.end && deliveryDate > range.end) {
      pickedUpThisMonthDeliveredLater += rev
      pickedUpThisMonthDeliveredLaterCount += 1
    }

    // Branch order MIRRORS calcFleetProfitability so each bucket reconciles with the
    // engine's revenue + leakage figures exactly (including its edge cases).
    let bucket: AuditBucket
    if (!inRange) {
      bucket = 'outOfRange'
    } else if (driverId && brokerDrivers.has(driverId)) {
      bucket = 'broker'
    } else if (resolvedTruck && memberIds.has(resolvedTruck)) {
      bucket = rev === 0 ? 'zeroRate' : 'counted'
    } else if (resolvedTruck && boxTruckIds.has(resolvedTruck)) {
      // Brokered box truck (#3890) — its P&L is the separate Box Truck view.
      bucket = 'boxTruck'
    } else if (driverId && !truckForDriver.has(driverId)) {
      // Company driver with NO assigned truck → engine counts this as unattributed
      // leakage, even if the load carried an explicit (non-member) truckId.
      bucket = 'unattributed'
    } else {
      // Resolved to a truck in another fleet, or driver assigned elsewhere → not ours.
      bucket = 'otherFleet'
    }

    // outOfRange is a huge bucket (every other month); only keep the ones relevant to
    // this month's story (picked up this month) to keep the panel focused.
    if (bucket === 'outOfRange' && !(pickupDate >= range.start && pickupDate <= range.end)) continue

    const row: AuditRow = {
      id: load.id,
      ref: load.aljexId || load.tmsId || load.pickupNumber || load.id.slice(0, 6),
      route: [load.originCity, load.destinationCity].filter(Boolean).join(' → ') || '—',
      customer: load.customer ?? null,
      rate: rev,
      deliveryDate,
      pickupDate,
      driverId: driverId ?? null,
      driverName,
      truckLabel: truckLabelFor(resolvedTruck),
      bucket,
    }
    buckets[bucket].total += rev
    buckets[bucket].rows.push(row)
  }

  // Newest delivery first within each bucket.
  for (const k of Object.keys(buckets) as AuditBucket[]) {
    buckets[k].rows.sort((a, b) => (a.deliveryDate < b.deliveryDate ? 1 : -1))
  }

  return {
    countedTotal: buckets.counted.total + buckets.zeroRate.total,
    buckets,
    pickedUpThisMonthDeliveredLater: { total: pickedUpThisMonthDeliveredLater, count: pickedUpThisMonthDeliveredLaterCount },
  }
}
