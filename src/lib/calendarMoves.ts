/**
 * Calendar card-move date helpers — shared by the Day/Week planner (PlannerView)
 * and the Month grid (GridCalendarView) so dragging a load onto a day schedules
 * it identically in both.
 */
import { formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import { updateStop } from '@/lib/stops'
import type { Load, Stop } from '@/types'

export type MoveRole = 'pickup' | 'delivery' | 'same-day'

/** Shift an appointment to a new Chicago calendar day, preserving the time-of-day. */
export function shiftApptToDay(isoAppt: string | null | undefined, newDayStr: string): string {
  const fallback = fromDateTimeInput(`${newDayStr}T08:00`)
  if (!isoAppt) return fallback
  const timeStr = formatDateTimeInput(isoAppt).slice(11) // "HH:mm" in Chicago time
  return fromDateTimeInput(`${newDayStr}T${timeStr}`)
}

/** Add/subtract days from a "YYYY-MM-DD" string, returns "YYYY-MM-DD". */
export function offsetDay(dayStr: string, n: number): string {
  const [y, m, d] = dayStr.split('-').map(Number)
  const date = new Date(y, m - 1, d + n)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * New pickupAppt + deliveryAppt for a legacy (non-multi-stop) card moved to targetDayStr.
 *   same-day : both shift to targetDay
 *   pickup   : pickup = targetDay, delivery = targetDay + 1 (next-day delivery)
 *   delivery : delivery = targetDay, pickup = targetDay - 1
 */
export function computeMoveDates(load: Load, role: MoveRole, targetDayStr: string) {
  if (role === 'same-day') {
    return {
      pickupAppt:   shiftApptToDay(load.pickupAppt,   targetDayStr),
      deliveryAppt: shiftApptToDay(load.deliveryAppt, targetDayStr),
    }
  }
  if (role === 'pickup') {
    return {
      pickupAppt:   shiftApptToDay(load.pickupAppt,   targetDayStr),
      deliveryAppt: shiftApptToDay(load.deliveryAppt, offsetDay(targetDayStr, 1)),
    }
  }
  return {
    pickupAppt:   shiftApptToDay(load.pickupAppt,   offsetDay(targetDayStr, -1)),
    deliveryAppt: shiftApptToDay(load.deliveryAppt, targetDayStr),
  }
}

/**
 * Multi-stop: dragging a stop card shifts ONLY that stop's appt to the target day.
 * The store re-derives the legacy pickup / delivery mirror fields from the new stops.
 */
export function computeStopMove(load: Load, stop: Stop, targetDayStr: string): Partial<Load> {
  return { stops: updateStop(load, stop.id, { appt: shiftApptToDay(stop.appt, targetDayStr) }) }
}
