/**
 * Bridge between a Load (as shown on the owner-operator settlement) and the OTR
 * factoring-readiness rules in src/lib/otrInvoice.ts.
 *
 * The settlement page needs the same eleven fields the factoring queue requires so
 * a driver can see which loads are blocking dollars. This module keeps that
 * derivation pure and reusable, and it reuses assembleOtrInvoice rather than
 * duplicating its precedence logic.
 */

import { assembleOtrInvoice, type LoadSlice, type ManualOverrides, type OtrReadiness } from '@/lib/otrInvoice'
import { loadHasPod, loadHasRatecon, type PodIndex } from '@/lib/podPresence'
import { getStops } from '@/lib/stops'
import type { Load } from '@/types'
import type { CustomerRecord, LocationRecord } from '@/types/tms'

export interface OtrSettlementInput {
  load: Load
  customersById: Map<string, CustomerRecord>
  locationsById: Map<string, LocationRecord>
  /**
   * Every document store, already indexed. A POD counts whether it came from JobsDone
   * or from a driver scanning one in the PWA, and a rate confirmation counts whether
   * it is a key on the Load row or a driver scan — see src/lib/podPresence.ts.
   */
  podIndex: PodIndex
  /**
   * Values a human typed on the factoring queue row, highest precedence. Passing them
   * here is what makes a queue correction show up on the settlement: without it the
   * two pages disagree about the same load.
   */
  manual?: ManualOverrides | null
  /** Defaults to the load's delivery date, which is the invoice date for settlement purposes. */
  submissionDate?: string | null
}

/** Resolve the first pickup stop and last delivery stop from canonical stops. */
function originAndDestinationStops(load: Load) {
  const stops = getStops(load)
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence)
  const origin = ordered.find((s) => s.type === 'pickup') ?? ordered[0]
  const destination = [...ordered].reverse().find((s) => s.type === 'delivery') ?? ordered[ordered.length - 1]
  return { origin, destination }
}

/** Pick city/state/ZIP out of a LocationRecord for assembleOtrInvoice. */
function locationSlice(loc: LocationRecord | undefined) {
  return loc ? { city: loc.city, state: loc.state, zip: loc.zip } : undefined
}

/**
 * Compute OTR readiness for one load, resolving Broker MC from the linked Customer
 * and city/state/ZIP from the linked Locations, with the same fallback precedence
 * assembleOtrInvoice uses for city/state split from originCity/destinationCity.
 */
export function otrSettlementReadiness(input: OtrSettlementInput): OtrReadiness {
  const { load, customersById, locationsById, podIndex, manual, submissionDate } = input
  const { origin, destination } = originAndDestinationStops(load)

  const loadSlice: LoadSlice = {
    aljexId: load.aljexId,
    pickupNumber: load.pickupNumber,
    rate: load.rate,
    originCity: load.originCity,
    destinationCity: load.destinationCity,
    customerId: load.customerId,
    customer: load.customer,
    rateConfirmKey: load.rateConfirmKey,
  }

  const customer = load.customerId ? customersById.get(load.customerId) : undefined
  const originLocation = origin?.locationId ? locationsById.get(origin.locationId) : undefined
  const destinationLocation = destination?.locationId ? locationsById.get(destination.locationId) : undefined

  return assembleOtrInvoice({
    load: loadSlice,
    customerMcNumber: customer?.mcNumber,
    originLocation: locationSlice(originLocation),
    destinationLocation: locationSlice(destinationLocation),
    manual,
    submissionDate: submissionDate ?? load.deliveryAppt.slice(0, 10),
    hasPod: loadHasPod(podIndex, load),
    hasRateConfirmation: Boolean(load.rateConfirmKey) || loadHasRatecon(podIndex, load),
  })
}
