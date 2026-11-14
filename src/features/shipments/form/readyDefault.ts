/**
 * Ready follows the appointment (Ryne 2026-11-14): the appointment (or the FCFS window's opening) is the
 * date a person types; a pickup's Ready copies it until someone types a different Ready. Ready "follows"
 * while it is blank or still equal to the appointment it was copied from, so moving the appointment moves
 * it too; once it differs it was typed on purpose and stays. Deliveries show Must Deliver, not Ready.
 */
import type { FormStop } from './model'

/** True while this stop's Ready is a copy of its appointment (blank counts). */
export function readyFollowsAppt(stop: Pick<FormStop, 'type' | 'ready' | 'appt'>): boolean {
  if (stop.type === 'delivery') return false
  return !stop.ready || stop.ready === stop.appt
}

/** The stop after its appointment (or FCFS window opening) becomes `appt`. */
export function withAppt(prev: FormStop, appt: string): FormStop {
  return readyFollowsAppt(prev) ? { ...prev, appt, ready: appt } : { ...prev, appt }
}

/** Apply a whole-stop change (FCFS toggle and the like) and carry Ready along when the appointment moved. */
export function followAppt(prev: FormStop, next: FormStop): FormStop {
  if (next.appt === prev.appt || !readyFollowsAppt(prev)) return next
  return { ...next, ready: next.appt }
}
