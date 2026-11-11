/**
 * The steps of an ASSETS (Ivan Cartage) load, which are not the brokerage ladder: there is no carrier to set up and no rate confirmation.
 * Ryne 2026-11-11: "the progress should just be the status updates from the driver app for ivan local drivers, or the progress should just
 * be the motive location for owner operators."
 *
 * Pure. Evidence only, nothing inferred from an appointment: a step is done when somebody or something recorded it (a stop's actual
 * arrived / departed clock, the leg's dispatch time, the last Motive fix) or when the shipment is already delivered, in which case every
 * earlier step is done even if nobody recorded when. Relative imports only (this file may be bundled by a Lambda).
 */
import type { DriverType, Stop } from '../types'
import type { LoadCarrierRecord, LoadCheckCallRecord, ShipmentBundle } from '../types/tms'

/** One head row before the shared state pass gives it done / next / todo. */
export interface RawStep {
  key: string
  label: string
  done: boolean
  carrier: string | null
  by: string | null
  at: string | null
  action: string
  waiting?: string | null
  short: string
}

export interface AssetContext {
  bundle: ShipmentBundle
  /** The active leg. */
  lc: LoadCarrierRecord | null
  /** The driver's type when the directory knows it. */
  driverType: DriverType | null | undefined
  /** Check calls of the shipment's loads, when they were read: they say who and when the driver app tapped. */
  checkCalls: readonly Pick<LoadCheckCallRecord, 'stopId' | 'type' | 'source' | 'at' | 'createdBy' | 'personName'>[]
  /** The shipment is delivered (or later): earlier steps are implied done. */
  delivered: boolean
}

export const isAssetShipment = (bundle: ShipmentBundle | null): boolean => bundle?.shipment.revDivision === 'ASSETS'

/** Owner operators are followed by Motive only; every other own-fleet driver reports through the driver app. */
export function assetModeOf(driverType: DriverType | null | undefined, bundle: ShipmentBundle): 'DRIVER_APP' | 'MOTIVE' {
  if (driverType === 'OWNER_OPERATOR') return 'MOTIVE'
  if (driverType === 'COMPANY') return 'DRIVER_APP'
  // Unknown driver: a load whose only position source is Motive reads as a Motive load.
  const loads = bundle.loads
  return loads.some((l) => l.lastKnownSource === 'MOTIVE') && !loads.some((l) => l.lastKnownSource === 'DRIVER_APP') ? 'MOTIVE' : 'DRIVER_APP'
}

function stopsOf(bundle: ShipmentBundle): Stop[] {
  return bundle.loads.flatMap((l) => (l.stops ?? []) as Stop[])
}

export function assetStepRows(ctx: AssetContext): RawStep[] {
  const { bundle, lc, delivered } = ctx
  const mode = assetModeOf(ctx.driverType, bundle)
  const stops = stopsOf(bundle)
  const pickups = stops.filter((s) => s.type === 'pickup')
  const deliveries = stops.filter((s) => s.type === 'delivery')
  const firstPickup = pickups[0] ?? null
  const lastDelivery = deliveries[deliveries.length - 1] ?? null
  const driver = lc?.driverName || null
  const truck = lc?.truckNumber ? `Truck ${lc.truckNumber}` : null
  const who = driver ?? truck
  const via = mode === 'MOTIVE' ? 'Motive' : 'driver app'

  /** The driver-app tap behind a stop clock: its person, else the leg's driver. */
  const tapBy = (stop: Stop | null, type: 'ARRIVED' | 'DEPARTED'): string | null => {
    if (!stop) return null
    const call = ctx.checkCalls.find((c) => c.stopId === stop.id && c.type === type && c.source === 'DRIVER_APP')
    return call ? (call.personName || driver) : null
  }

  const located = bundle.loads.map((l) => ({ at: l.lastKnownSource === 'MOTIVE' ? l.lastKnownAt : null })).find((x) => x.at)?.at ?? null
  const dispatchedAt = lc?.dispatchedAt ?? null
  const started = !!dispatchedAt || bundle.loads.some((l) => ['DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED'].includes(String(l.status)))

  const rows: RawStep[] = [
    {
      key: 'assetAssigned', label: mode === 'MOTIVE' ? 'Owner operator assigned' : 'Driver assigned', done: !!lc, carrier: who,
      by: null, at: lc?.bookedAt ?? lc?.createdAt ?? null, short: 'Assign driver',
      action: 'Assign the driver (Book Ivan Cartage and pick the driver or owner operator)',
    },
  ]
  if (mode === 'MOTIVE') {
    rows.push({
      key: 'assetLocated', label: 'Truck located by Motive', done: !!located, carrier: truck, by: 'Motive', at: located, short: 'Truck location',
      action: 'Waiting for the first Motive location of the truck', waiting: 'No Motive fix has come in yet',
    })
  } else {
    rows.push({
      key: 'assetStarted', label: 'Dispatched to the driver', done: started, carrier: driver, by: null, at: dispatchedAt, short: 'Dispatch',
      action: 'Dispatch the load so it shows in the driver app',
    })
  }
  rows.push(
    {
      key: 'assetArrivedPickup', label: 'Arrived at pickup', done: !!firstPickup?.arrivedAt, carrier: who, by: tapBy(firstPickup, 'ARRIVED') ?? (firstPickup?.arrivedAt ? via : null),
      at: firstPickup?.arrivedAt ?? null, short: 'Arrive at pickup', action: `Waiting for the arrival at pickup (${via})`,
    },
    {
      key: 'assetLeftPickup', label: 'Loaded, left pickup', done: !!firstPickup?.departedAt, carrier: who, by: tapBy(firstPickup, 'DEPARTED') ?? (firstPickup?.departedAt ? via : null),
      at: firstPickup?.departedAt ?? null, short: 'Leave pickup', action: `Waiting for the truck to leave pickup (${via})`,
    },
    {
      key: 'assetArrivedDelivery', label: 'Arrived at delivery', done: !!lastDelivery?.arrivedAt, carrier: who, by: tapBy(lastDelivery, 'ARRIVED') ?? (lastDelivery?.arrivedAt ? via : null),
      at: lastDelivery?.arrivedAt ?? null, short: 'Arrive at delivery', action: `Waiting for the arrival at delivery (${via})`,
    },
  )
  // A delivered shipment did every earlier step, recorded or not.
  return delivered ? rows.map((r) => ({ ...r, done: true })) : rows
}
