/**
 * Work that runs after a shipment exists, shared by NewShipmentDialog and the Aljex form
 * pipelines (extracted unchanged from the dialog; Step AH).
 */
import { toast } from 'sonner'
import { bookedAddressSnapshot } from '@/features/loads/legFields'
import {
  createApptTask, notifySlackStatusChange, updateIntakeItem, updateLoad,
} from '@/lib/apiClient'
import { locationInputForStop, matchStopLocation } from '@/lib/locationAutoSave'
import { sendApptNotices } from '@/lib/sendApptNotices'
import { withDerivedLegacy } from '@/lib/stops'
import type { apptNotices } from '@/lib/apptNotify'
import type { Load, Stop } from '@/types'
import type { LocationRecord, ShipmentBundle } from '@/types/tms'

/**
 * The work that used to hang off `addLoad` and the drawer's create branch, run once the
 * bundle is back. None of it may fail the create — the shipment and its number already
 * exist by the time any of this starts.
 */
export async function applyNewShipmentEffects({
  bundle, stops, prevNotices, isBatory, intakeItemId, rateConKey, actorName,
}: {
  bundle: ShipmentBundle
  /** The stops as written, so the Slack notices describe the saved state. */
  stops: Stop[]
  /** Appointment notices decided before the save, against an empty previous state. */
  prevNotices: ReturnType<typeof apptNotices>
  isBatory: boolean
  intakeItemId?: string
  rateConKey?: string
  actorName: string
}): Promise<void> {
  const load = bundle.loads[0]
  if (!load) return

  /*
   * Every load write below goes straight at the API, never through the store's
   * `updateLoad`.
   *
   * That action opens with `const before = get().loads.find(l => l.id === id)` and
   * returns silently when the row is missing. The leg is created server-side inside
   * CREATE_SHIPMENT and only reaches the store when the `onCreateLoad` subscription
   * delivers it — a race this code normally loses, because it runs the instant the
   * mutation resolves. Routed through the store the tender PDF would never attach and
   * the #appts-ivan thread ts would never be remembered, both without an error. The
   * deleted `addLoad` hid this by pushing the created row into the store itself.
   *
   * Kept from the store's write path: `updatedBy` attribution and the stops→legacy
   * dual-write, so the canonical array and its mirrors still cannot disagree. Left
   * behind: the optimistic copy and the audit diff, neither of which can be computed
   * without a `before` row — and the subscription delivers this update too, so the
   * store converges on its own.
   */
  const writeLoad = (id: string, patch: Partial<Load>) =>
    updateLoad(id, withDerivedLegacy({ ...patch, updatedBy: actorName }))

  if (isBatory) {
    /*
     * A Batory shipment enters the appointment ladder immediately: pickup NEED TO DENNIS
     * (the standing 12pm rule) and delivery NEED RUBEN, who picks the time. The stop
     * statuses rode in on the leg bag; these are the two tasks that chase them.
     *
     * Fire-and-forget — a task hiccup must not read as a failed shipment.
     */
    const ref = [load.aljexId ? `Pro# ${load.aljexId}` : null, bundle.shipment.customerName].filter(Boolean).join(' · ')
    const puDate = load.pickupAppt ? load.pickupAppt.slice(0, 10) : 'the pickup date'
    void createApptTask({
      loadId: load.id, kind: 'request_pickup', assignee: 'dennis@bcatcorp.com',
      subject: `Request pickup appt for 12:00 PM — ${ref || 'Batory load'}`,
      bodyText: `New Batory load built. Email the pickup facility to request a 12:00 PM appointment for ${puDate}, then upload the request-email screenshot to move it to REQUESTED.`,
      aljexId: load.aljexId ?? null,
    }).catch((err) => console.error('[newShipmentEffects] pickup task failed', err))
    void createApptTask({
      loadId: load.id, kind: 'pick_delivery_time', assignee: 'ruben@bcatcorp.com',
      subject: `Pick delivery appt time — ${ref || 'Batory load'}`,
      bodyText: `New Batory load built. Choose the delivery time you want booked (set it on the delivery stop); Dennis is then tasked to book it.`,
      aljexId: load.aljexId ?? null,
    }).catch((err) => console.error('[newShipmentEffects] delivery task failed', err))
  }

  if (intakeItemId) {
    try {
      /*
       * Attach the tender's own document, when it came with one.
       *
       * The key is pointed at rather than copied: it is already in the same bucket and
       * readable, and duplicating the bytes would leave two copies to keep in step.
       */
      if (rateConKey) {
        await writeLoad(load.id, { rateConfirmKey: rateConKey })
      }
      /*
       * DONE, not BUILT. Building the shipment IS the work the intake item was asking for,
       * so a separate "Mark as done" click was pure bookkeeping — and an item left at BUILT
       * reads as outstanding on a page whose whole job is showing what still needs doing.
       */
      await updateIntakeItem(intakeItemId, {
        builtLoadId: load.id,
        status: 'DONE',
        ...(load.aljexId ? { proNumber: load.aljexId } : {}),
      })
      notifySlackStatusChange({
        intakeItemId,
        oldStatus: 'IN_PROGRESS',
        newStatus: 'DONE',
        actorName,
        proNumber: load.aljexId || null,
      })
    } catch (linkErr) {
      console.error('[newShipmentEffects] failed to link intake item', linkErr)
    }
  }

  if (prevNotices.length > 0) {
    // Fire-and-forget, but never unhandled: the shipment already exists, so a Slack
    // outage is a logged warning, not a rejection that surfaces as an app-level error.
    void sendApptNotices({
      load: { ...load, stops } as unknown as Load,
      next: stops,
      prev: [],
      actorName,
      updateLoad: writeLoad,
    }).catch((err) => console.error('[newShipmentEffects] appointment notices failed', err))
    const needed = prevNotices.filter((n) => n.kind === 'needed').length
    toast.message(needed > 0
      ? `Posted to #appts-ivan — ${needed} appt needed`
      : 'Updated the #appts-ivan thread')
  }
}

/**
 * Every stop leaves with a directory location on it.
 *
 * A stop the dispatcher linked keeps its link. One they only typed is matched to the
 * directory (same name in the same city, or the same street) and, when nothing matches,
 * filed as a new location. Filing is best-effort: a directory hiccup must never stop a
 * shipment from being recorded.
 */
export async function linkStopsToDirectory(
  stops: Stop[],
  locations: LocationRecord[],
  o: {
    createLocation: (input: NonNullable<ReturnType<typeof locationInputForStop>>) => Promise<LocationRecord>
    refresh?: () => void
    notify?: (message: string) => void
  },
): Promise<Stop[]> {
  let filed = 0
  let known = locations
  const out: Stop[] = []
  for (const stop of stops) {
    if (stop.locationId || !(stop.name ?? '').trim()) { out.push(stop); continue }
    const hit = matchStopLocation(stop, known)
    if (hit) { out.push({ ...stop, locationId: hit.id, address: stop.address ?? bookedAddressSnapshot(hit) }); continue }
    const input = locationInputForStop(stop)
    if (!input) { out.push(stop); continue }
    try {
      const created = await o.createLocation(input)
      known = [...known, created]
      filed++
      out.push({ ...stop, locationId: created.id })
    } catch (err) {
      console.warn('[newShipmentEffects] could not file the stop as a location', { name: stop.name, err })
      out.push(stop)
    }
  }
  if (filed > 0) {
    o.refresh?.()
    o.notify?.(`${filed} new location${filed === 1 ? '' : 's'} filed in the directory`)
  }
  return out
}
