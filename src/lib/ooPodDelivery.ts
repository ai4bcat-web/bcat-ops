/**
 * An owner operator's POD is the delivery (Ryne 2026-11-16, 20039).
 *
 * Owner operators are not asked to tap Arrived / Departed at each stop; the POD they send is
 * the proof the freight was delivered. So when a POD lands on a load an owner operator is on,
 * every stop time still blank is filled in and the load walks to Delivered through the same
 * stop-time ladder a person typing the times would use. Ivan's local drivers and box trucks
 * are not touched: their app records the stops itself.
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

export function isOwnerOperatorLoad(facts: OoLoadFacts): boolean {
  if (facts.revSubdivision === 'OWNER_OPERATOR') return true
  return facts.driver ? driverOwnershipKind(facts.driver) === 'OWNER_OPERATOR' : false
}

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
