/**
 * Stop ↔ form conversion, and the two derivations that hang off it.
 *
 * Pure, and apart from the components in `legForm.tsx` on purpose: both the leg editor and
 * the new-shipment form need these, and so does any test that wants to pin the tender
 * prefill rules without rendering a dialog.
 */
import {
  apptHasTime, formatDateInput, formatDateTimeInput, fromDateInput, fromDateTimeInput,
} from '@/lib/date'
import { apptLadderAfterEdit } from '@/lib/apptStatus'
import { apptTypeAfterEdit } from '@/lib/apptQueue'
import { matchStopLocation } from '@/lib/locationAutoSave'
import { getStops, makeStop } from '@/lib/stops'
import { locationAddress } from '@/lib/tmsDirectory'
import type { StopFormValue } from '@/lib/schemas'
import type { TenderPrefill } from '@/lib/intakeTender'
import type { Load, Stop } from '@/types'
import type { LocationRecord } from '@/types/tms'

// ── Stop ↔ form conversion ───────────────────────────────────────────────────
// Form stores appt as a datetime-local / date string; the stored Stop uses ISO UTC.

// A stored UTC-midnight value means no time was set — true for NEED without a desired
// time, for FCFS, and now for an `exact` appt nobody has scheduled yet ("Pending").

export function stopToForm(stop: Stop): StopFormValue {
  const isDateOnly =
    stop.apptType === 'fcfs' ||
    ((stop.apptType === 'tbd' || stop.apptType === 'exact' || !stop.apptType) && !apptHasTime(stop.appt))
  return {
    id: stop.id,
    type: stop.type,
    name: stop.name ?? '',
    city: stop.city ?? '',
    locationId: stop.locationId ?? null,
    address: stop.address ?? null,
    arrivedAt: stop.arrivedAt ?? null,
    departedAt: stop.departedAt ?? null,
    appt: stop.appt ? (isDateOnly ? formatDateInput(stop.appt) : formatDateTimeInput(stop.appt)) : '',
    apptType: stop.apptType ?? 'exact',
    apptEnd: stop.apptEnd ? formatDateTimeInput(stop.apptEnd) : '',
    driverId: stop.driverId,
    sequence: stop.sequence,
  }
}

export function loadToStopForms(load: Load): StopFormValue[] {
  return getStops(load).map(stopToForm)
}

// Default stops for a brand-new leg: one pickup + one delivery.
export function emptyStopForms(preDate?: string, driverId?: string | null): StopFormValue[] {
  const pu = makeStop({ type: 'pickup', driverId: driverId ?? null }, 0)
  const de = makeStop({ type: 'delivery', driverId: driverId ?? null }, 1)
  // Date only — deliberately no default time. An 8:00/17:00 guess reads as a confirmed
  // appointment nobody actually made; the stops show "Pending" until a real time is set.
  return [
    { ...stopToForm(pu), appt: preDate ?? '' },
    { ...stopToForm(de), appt: preDate ?? '' },
  ]
}

/** The tender's facility instructions, labelled by which end they belong to. */
export function tenderNotes(tender: TenderPrefill | null | undefined): string {
  if (!tender) return ''
  const seen = new Set<string>()
  return tender.stops
    .filter((st) => st.instructions)
    .map((st) => `${st.type === 'pickup' ? 'Pickup' : 'Delivery'}: ${st.instructions}`)
    // The same instruction often repeats across stops of a multi-stop run; say it once.
    .filter((line) => !seen.has(line) && seen.add(line))
    .join('\n')
}

/**
 * Stop forms seeded from a parsed tender email.
 *
 * One form per stop the tender described, in the order it described them, so a multi-stop
 * route arrives as a multi-stop leg. Falls back to the plain empty pair when the tender
 * turned out to carry no stops — a prefill that produced one lonely pickup would leave the
 * form invalid for a reason the dispatcher cannot see.
 *
 * `appt` takes the stop's own planned date, so pickup and delivery are not both stamped
 * with the pickup date. Date only, never a time, for the reason in emptyStopForms: an
 * invented time reads as an appointment somebody booked.
 */
export function tenderStopForms(
  tender: TenderPrefill,
  preDate?: string,
  driverId?: string | null,
  /*
   * Batory appointments are never prefilled.
   *
   * Their loads go through the request-and-confirm ladder — a time is asked for, granted,
   * and evidenced with screenshots — so a date carried over from the tender is a time
   * nobody agreed, sitting in the very field the workflow exists to fill, and the load
   * reads as booked. The rest of the stop — name, city, street, zip — still prefills, as
   * it did before appointment prefill existed; only the appointment is left for a person.
   */
  skipAppointments = false,
  /** The directory, so a facility seen before arrives already linked — hours, notes and all. */
  locations: LocationRecord[] = [],
): StopFormValue[] {
  const ordered = [
    ...tender.stops.filter((s) => s.type === 'pickup'),
    ...tender.stops.filter((s) => s.type === 'delivery'),
  ]
  if (!ordered.some((s) => s.type === 'pickup') || !ordered.some((s) => s.type === 'delivery')) {
    return emptyStopForms(preDate, driverId)
  }
  return ordered.map((st, i) => {
    const base = stopToForm(makeStop({ type: st.type, driverId: driverId ?? null }, i))
    const cityState = [st.city, st.state].filter(Boolean).join(', ')
    /*
     * A booked time makes this a real appointment; a date alone does not.
     *
     * The form's `appt` is a datetime-local string when there is a time and a plain date
     * when there is not, which is the same distinction the stops themselves draw: a date at
     * midnight means "this day, time still to be agreed" and must not read as 00:00 booked.
     */
    const when = skipAppointments ? '' : (st.dateStr ?? preDate ?? '')
    const time = skipAppointments ? undefined : st.time
    const address = {
      ...base.address,
      street: st.street ?? null,
      city: st.city ?? null,
      state: st.state ?? null,
      zip: st.zip ?? null,
    }
    // A place we have filed before is linked at prefill, so the stop opens with the record
    // the office already keeps — the point of filing it the first time.
    const known = matchStopLocation({ type: st.type, name: st.name, city: cityState, address }, locations)
    return {
      ...base,
      sequence: i,
      appt: when && time ? `${when}T${time}` : when,
      apptType: time ? ('exact' as const) : base.apptType,
      ...(st.name ? { name: st.name } : {}),
      ...(cityState ? { city: cityState } : {}),
      address: known ? bookedAddressSnapshot(known) : address,
      ...(known ? { locationId: known.id } : {}),
    }
  })
}

// "Split" = the delivery is run by a different driver than the pickup. A load is
// split when any delivery stop has a driver assigned that differs from the first
// pickup's driver. New / single-driver loads are not split.
export function deriveSplitFromStops(stops: StopFormValue[]): boolean {
  const pickupDriver = stops.find((s) => s.type === 'pickup')?.driverId ?? null
  return stops.some(
    (s) => s.type === 'delivery' && (s.driverId ?? null) !== null && (s.driverId ?? null) !== pickupDriver,
  )
}

// Form stop → stored Stop, with the Batory ladder reopened when the appointment changed
// (see apptLadderAfterEdit): a confirmed stop given a new time is Dennis's work again.
export function stopFormToStop(s: StopFormValue, sequence: number, prev?: { type?: Stop['apptType']; value?: string }, was?: Stop): Stop {
  const next = stopFormToStopRaw(s, sequence, prev, was)
  return was ? { ...next, ...apptLadderAfterEdit(was, next) } : next
}

// Form stop → stored Stop (appt form string → ISO UTC, mirrors the legacy toIso()).
function stopFormToStopRaw(
  s: StopFormValue,
  sequence: number,
  prev?: { type?: Stop['apptType']; value?: string },
  was?: Stop,
): Stop {
  // FCFS is always date-only. NEED and Exact are date-only until someone types a time —
  // that's what makes an appointment read "Pending" instead of inventing midnight.
  const dateOnly =
    s.apptType === 'fcfs' || ((s.apptType === 'tbd' || s.apptType === 'exact') && s.appt.length <= 10)
  return {
    // Carry through everything the form doesn't edit — linked facility + booked snapshot,
    // actual arrival/departure, booking-proof screenshots, Batory ladder state, etc.
    ...(was ? {
      colorKey: was.colorKey, apptThreadTs: was.apptThreadTs, apptProofs: was.apptProofs,
      apptMoveRequested: was.apptMoveRequested, apptMoveTaskId: was.apptMoveTaskId,
      apptStatus: was.apptStatus, apptChangeTo: was.apptChangeTo,
      apptRequestedFor: was.apptRequestedFor, apptCleared: was.apptCleared,
      arrivedAt: was.arrivedAt, departedAt: was.departedAt,
    } : {}),
    id: s.id,
    type: s.type,
    name: s.name?.trim() || undefined,
    city: s.city?.trim() || undefined,
    locationId: s.locationId?.trim() || (was?.locationId ?? null),
    address: s.address ?? (was?.address ?? null),
    appt: dateOnly ? fromDateInput(s.appt.slice(0, 10)) : fromDateTimeInput(s.appt),
    // Same rule as the calendar and the Appts queue: the status saved is the status
    // picked — a NEED stop with a time stays NEED until someone chooses Exact.
    apptType: apptTypeAfterEdit(s.apptType, s.appt, prev),
    apptEnd: s.apptType === 'range' && s.apptEnd ? fromDateTimeInput(s.apptEnd) : undefined,
    driverId: s.driverId,
    sequence,
  }
}

// ── Miles calculator (Nominatim geocoding + OSRM routing) ────────────────────

async function geocode(query: string): Promise<[number, number] | null> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us,ca`
  const res = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'bcat-ops/1.0' } })
  if (!res.ok) return null
  const data = await res.json() as Array<{ lat: string; lon: string }>
  if (!data[0]) return null
  return [parseFloat(data[0].lon), parseFloat(data[0].lat)]
}

export async function calculateDrivingMiles(origin: string, destination: string): Promise<number> {
  const [from, to] = await Promise.all([geocode(origin), geocode(destination)])
  if (!from || !to) throw new Error('Could not find one or both locations')
  const url = `https://router.project-osrm.org/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=false`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Routing service unavailable')
  const data = await res.json() as { routes?: Array<{ distance: number }> }
  const meters = data.routes?.[0]?.distance
  if (!meters) throw new Error('No route found')
  return Math.round(meters * 0.000621371)
}

// ── Booked address snapshot ──────────────────────────────────────────────────

/**
 * Booked snapshot: what the facility's address was when this stop was booked. A later
 * directory edit does not rewrite history on the load. Coordinates ride along only while
 * Google's result is still fresh; an expired pin is not frozen into the stop.
 */
export function bookedAddressSnapshot(loc: LocationRecord): NonNullable<Stop['address']> {
  const fresh = !!loc.geocodeExpiresAt && Date.parse(loc.geocodeExpiresAt) > Date.now()
  return {
    ...locationAddress(loc),
    ...(fresh ? { lat: loc.lat ?? null, lng: loc.lng ?? null, timezone: loc.timezone ?? null, geocodeExpiresAt: loc.geocodeExpiresAt ?? null } : {}),
  }
}

