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
