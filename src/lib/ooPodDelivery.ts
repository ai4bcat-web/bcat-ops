/**
 * An own-fleet driver's POD is the delivery (Ryne 2026-11-16, 20039; widened the same day to
 * local drivers and box trucks: "if a pod gets updated for an owner operator or local driver it
 * should automatically move the load all the way to delivered status").
 *
 * Owner operators, Ivan's local drivers and box trucks are covered, however the driver is
 * grouped (Driver.fleetGroup OWNER_OPERATOR / AMAZON / LOCAL / BOX_TRUCK, or the legacy
 * driverType OWNER_OPERATOR / COMPANY when no fleet is set; Shipment.revSubdivision says the
 * same). When a POD lands on such a load, every stop time still blank is filled in and the load
 * walks to Delivered through the same stop-time ladder a person typing the times would use.
 * Real times are never overwritten. A brokerage load on an outside carrier is not covered.
 *
 * Pure and relative-import only: the tmsShipmentActions Lambda bundles this file by path.
 */
import { driverOwnershipKind, type DriverOwnershipInputs } from './driverOwnership'

export interface OoLoadFacts {
  /** Shipment.revSubdivision (OWNER_OPERATOR on owner-operator freight). */
  revSubdivision?: string | null
  /** The load's driver record, when one is assigned. */
  driver?: DriverOwnershipInputs | null
}

/** The groups whose POD delivers the load. */
export const POD_DELIVERS_KINDS: readonly string[] = ['OWNER_OPERATOR', 'LOCAL', 'BOX_TRUCK', 'COMPANY']

export function isPodDeliveredLoad(facts: OoLoadFacts): boolean {
  if (facts.revSubdivision && POD_DELIVERS_KINDS.includes(facts.revSubdivision)) return true
  const kind = facts.driver ? driverOwnershipKind(facts.driver) : null
  return kind != null && POD_DELIVERS_KINDS.includes(kind)
}

/** Which group the rule matched, for the audit note. */
export function podDeliveryGroup(facts: OoLoadFacts): string {
  const kind = facts.driver ? driverOwnershipKind(facts.driver) : null
  const g = kind ?? facts.revSubdivision ?? ''
  return g === 'OWNER_OPERATOR' ? 'owner operator' : g === 'BOX_TRUCK' ? 'box truck' : 'local driver'
}

/** @deprecated kept for old imports; use isPodDeliveredLoad. */
export const isOwnerOperatorLoad = isPodDeliveredLoad

export interface PodStop {
  id: string
  type: 'pickup' | 'delivery'
  sequence?: number | null
  appt?: string | null
  arrivedAt?: string | null
  departedAt?: string | null
}

export interface StopTimesOp {
  stopId: string
  patch: { arrivedAt?: string; departedAt?: string }
}

const has = (v: string | null | undefined): v is string => !!(v ?? '').trim()
const ms = (iso: string): number => Date.parse(iso)

/**
 * The SET_TIMES ops that finish a load at `podAt`. Only blank times are filled:
 * - the last delivery is in and out at the POD time (or its own in time, if that is later);
 * - an earlier stop takes its appointment when that is before the POD, else the POD time,
 *   and leaves when it arrived.
 * Nothing is ever moved earlier or overwritten, and no time lands after the POD.
 */
export function ooPodStopOps(stops: readonly PodStop[], podAt: string): StopTimesOp[] {
  const ordered = [...stops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  const deliveries = ordered.filter((s) => s.type === 'delivery')
  const last = deliveries[deliveries.length - 1]
  if (!last) return []
  const pod = ms(podAt)
  const ops: StopTimesOp[] = []
  for (const stop of ordered) {
    const patch: StopTimesOp['patch'] = {}
    let inAt = has(stop.arrivedAt) ? stop.arrivedAt : null
    if (!inAt) {
      inAt = stop === last
        ? podAt
        : has(stop.appt) && ms(stop.appt) <= pod ? stop.appt : podAt
      patch.arrivedAt = inAt
    }
    if (!has(stop.departedAt)) {
      const out = ms(inAt) > pod ? inAt : stop === last ? podAt : inAt
      patch.departedAt = out
    }
    if (patch.arrivedAt || patch.departedAt) ops.push({ stopId: stop.id, patch })
  }
  return ops
}
