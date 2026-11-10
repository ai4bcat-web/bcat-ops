/**
 * One shipment, two places to edit it: the calendar's load drawer and the Shipments page. A change made on the calendar
 * must land on the shipment too (its dates, its driver), so for a load that belongs to a shipment the date and driver changes
 * go through the shipment actions (UPDATE_STOP / ASSIGN_ASSET), which keep the Shipment, Order, LoadCarrier and Load in step, and
 * need no client write permission on the driver fields. Pure helpers here; the store runs them.
 */
import type { Load, Stop } from '@/types'

export interface ApptChange { stopId: string; appt: string; apptEnd?: string | null; apptType?: string | null }

/** Stops whose appointment (start, end or type) differs from what the load held. New stops and removed stops are not appointment changes. */
export function changedApptStops(before: readonly Stop[], next: readonly Stop[] | null | undefined): ApptChange[] {
  if (!next) return []
  const byId = new Map(before.map((s) => [s.id, s]))
  const out: ApptChange[] = []
  for (const s of next) {
    const was = byId.get(s.id)
    if (!was || !s.appt) continue
    if (was.appt !== s.appt || (was.apptEnd ?? null) !== (s.apptEnd ?? null) || (was.apptType ?? null) !== (s.apptType ?? null)) {
      out.push({ stopId: s.id, appt: s.appt, apptEnd: s.apptEnd ?? null, apptType: s.apptType ?? null })
    }
  }
  return out
}

/**
 * Every appointment this write changes, whichever way it was written: a `stops` array, or only the legacy pickup/delivery mirrors
 * (the calendar's date editor writes just those), which land on the first pickup and the last delivery, like the driver mirrors.
 */
export function apptChangesOfWrite(beforeStops: readonly Stop[], next: Partial<Load>): ApptChange[] {
  if (next.stops) return changedApptStops(beforeStops, next.stops)
  const ordered = [...beforeStops].sort((a, b) => a.sequence - b.sequence)
  const first = ordered.find((s) => s.type === 'pickup') ?? ordered[0]
  const last = [...ordered].reverse().find((s) => s.type === 'delivery') ?? ordered[ordered.length - 1]
  const out: ApptChange[] = []
  const edit = (stop: Stop | undefined, kind: 'pickup' | 'delivery') => {
    if (!stop) return
    const rec = next as Record<string, unknown>
    const hasAppt = `${kind}Appt` in rec
    const hasType = `${kind}ApptType` in rec
    const hasEnd = `${kind}ApptEnd` in rec
    if (!hasAppt && !hasType && !hasEnd) return
    const appt = (hasAppt ? (rec[`${kind}Appt`] as string | null | undefined) : stop.appt) ?? stop.appt
    if (!appt) return
    const apptEnd = hasEnd ? ((rec[`${kind}ApptEnd`] as string | null | undefined) ?? null) : (stop.apptEnd ?? null)
    const apptType = hasType ? ((rec[`${kind}ApptType`] as string | null | undefined) ?? null) : (stop.apptType ?? null)
    if (stop.appt !== appt || (stop.apptEnd ?? null) !== apptEnd || (stop.apptType ?? null) !== apptType) out.push({ stopId: stop.id, appt, apptEnd, apptType })
  }
  edit(first, 'pickup')
  if (last && last.id !== first?.id) edit(last, 'delivery')
  return out
}

/** Stops whose driver differs from what the load held (a driver put on, changed or taken off). New and removed stops are not driver changes. */
export function changedStopDrivers(before: readonly Stop[], next: readonly Stop[] | null | undefined): { stopId: string; driverId: string | null }[] {
  if (!next) return []
  const byId = new Map(before.map((s) => [s.id, s]))
  const out: { stopId: string; driverId: string | null }[] = []
  for (const s of next) {
    const was = byId.get(s.id)
    if (!was) continue
    if ((was.driverId ?? null) !== (s.driverId ?? null)) out.push({ stopId: s.id, driverId: s.driverId ?? null })
  }
  return out
}

/**
 * Every stop driver this write changes, whichever way it was written: a `stops` array, or only the two pickup/delivery mirrors
 * (the calendar's context menu and drag), which land on the first pickup and the last delivery.
 */
export function driverChangesOfWrite(beforeStops: readonly Stop[], next: Partial<Load>): { stopId: string; driverId: string | null }[] {
  if (next.stops) return changedStopDrivers(beforeStops, next.stops)
  const ordered = [...beforeStops].sort((a, b) => a.sequence - b.sequence)
  const first = ordered.find((s) => s.type === 'pickup') ?? ordered[0]
  const last = [...ordered].reverse().find((s) => s.type === 'delivery') ?? ordered[ordered.length - 1]
  const out: { stopId: string; driverId: string | null }[] = []
  if (first && 'pickupDriverId' in next && (next.pickupDriverId ?? null) !== (first.driverId ?? null)) out.push({ stopId: first.id, driverId: next.pickupDriverId ?? null })
  if (last && 'deliveryDriverId' in next && (next.deliveryDriverId ?? null) !== (last.driverId ?? null) && !out.some((o) => o.stopId === last.id)) out.push({ stopId: last.id, driverId: next.deliveryDriverId ?? null })
  return out
}

/** The driver this write puts on the whole load, or null when the driver did not change (or pickup and delivery differ). */
export function loadWideDriverChange(before: Partial<Load>, next: Partial<Load>): string | null {
  const p = next.pickupDriverId
  const d = next.deliveryDriverId
  if (!p || !d || p !== d) return null
  if ((before.pickupDriverId ?? null) === p && (before.deliveryDriverId ?? null) === d) return null
  return p
}

/** Only an own-fleet (or not yet assigned) load takes a roster driver; a brokered load's driver is the carrier's. */
export const takesRosterDriver = (load: Partial<Load>): boolean =>
  load.assignmentType == null || load.assignmentType === 'OWN_ASSET' || load.assignmentType === 'NEED_TO_COVER'
