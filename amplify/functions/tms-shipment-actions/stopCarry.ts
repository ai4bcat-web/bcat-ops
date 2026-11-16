import { apptHasTime } from '../../../src/lib/date'
import type { StopShape } from '../_shared/shipmentStore'

/**
 * The order form rebuilds every stop through validateStop, which only knows the fields
 * the form edits. Everything else on a stop is written by other screens and Lambdas:
 * the Appts page's screenshots and status (apptProofs, apptStatus, apptRequestedFor,
 * apptThreadTs, apptMove*), the tracking projector's ETA, the driver app's odometers.
 * Saving the form used to drop all of it, which is why the Appts screenshots vanished
 * every time someone saved the shipment.
 *
 * For each saved stop that matches a previous stop by id, copy back any field the form
 * did not produce. Fields the form does produce (even as null) always win, so clearing
 * one in the form still clears it. A stop the form added has nothing to carry.
 *
 * One exception, the same rule the load drawer applies (apptLadderAfterEdit in
 * src/lib/apptStatus.ts): a REQUESTED or CONFIRMED appointment whose date, time, window
 * or type the form changed is a new booking, so its ladder restarts and the old
 * screenshots are cleared rather than carried.
 *
 * The address is never lost to a save that did not carry it (Ryne 2026-11-16: what Build captured stays
 * for the life of the load): at the same place, a missing address keeps the stored one, and an address
 * that leaves a field out keeps that field. A field sent as null or "" is the user clearing it.
 */
export function carryStopState(next: StopShape[], previous: StopShape[]): StopShape[] {
  const byId = new Map(previous.filter((s) => s.id).map((s) => [s.id as string, s]))
  return next.map((stop) => {
    const prev = stop.id ? byId.get(stop.id) : undefined
    if (!prev) return stop
    const carried: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(prev)) {
      if (!(key in stop) && value !== undefined) carried[key] = value
    }
    const address = keptAddress(prev, stop)
    return { ...carried, ...stop, ...(address !== undefined ? { address } : {}), ...ladderAfterReschedule(prev, stop) }
  })
}

type AddressRow = Record<string, unknown>
const isAddress = (v: unknown): v is AddressRow => !!v && typeof v === 'object' && !Array.isArray(v)
const hasValue = (a: AddressRow): boolean => Object.values(a).some((v) => v != null && v !== '')

/** The address to keep when a save sends a thinner one for the same place; undefined = take the save as is. */
function keptAddress(prev: StopShape, next: StopShape): AddressRow | undefined {
  const was = (prev as { address?: unknown }).address
  if (!isAddress(was) || !hasValue(was)) return undefined
  const samePlace = ((prev as { locationId?: unknown }).locationId ?? null) === ((next as { locationId?: unknown }).locationId ?? null)
  if (!samePlace) return undefined
  const sent = (next as { address?: unknown }).address
  if (!isAddress(sent)) return was
  return { ...was, ...sent }
}

function ladderAfterReschedule(was: StopShape, next: StopShape): Record<string, unknown> {
  const changed =
    (was.appt ?? null) !== (next.appt ?? null) ||
    (was.apptType ?? 'exact') !== (next.apptType ?? 'exact') ||
    (was.apptEnd ?? null) !== (next.apptEnd ?? null)
  if (!changed) return {}
  if (was.apptStatus !== 'requested' && was.apptStatus !== 'confirmed') return {}
  return {
    apptStatus: next.type === 'delivery' && !apptHasTime(next.appt) ? 'need_book' : 'need_request',
    apptChangeTo: null,
    apptMoveRequested: false,
    apptRequestedFor: null,
    apptProofs: { request: null, e2open: null, email: null },
  }
}
