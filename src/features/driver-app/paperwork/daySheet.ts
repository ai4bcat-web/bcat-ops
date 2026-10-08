/**
 * What goes on today's sheet. Pure, so the day can be pinned without a page.
 */
import type { PaperworkLoad, PaperworkStop } from '../driverApi'

/** Matches DETENTION_FREE_HOURS on the server: two hours past the appointment. */
export const DETENTION_HOURS = 2

export interface TodayStop {
  load: PaperworkLoad
  stop: PaperworkStop
}

/**
 * Every stop on today's sheet, in appointment order — pickups and deliveries alike.
 * Only the driver's own: on a load where somebody else delivers, their delivery is not
 * this driver's to mark.
 */
export function stopsForDay(loads: PaperworkLoad[], today: string): TodayStop[] {
  const out: TodayStop[] = []
  for (const load of loads) {
    for (const stop of load.stops) {
      if (stop.date === today && stop.yours) out.push({ load, stop })
    }
  }
  return out.sort((a, b) =>
    String(a.stop.appt ?? '').localeCompare(String(b.stop.appt ?? '')) || a.stop.sequence - b.stop.sequence)
}

export function isDelivery(stop: PaperworkStop): boolean {
  return stop.type.toLowerCase() === 'delivery'
}
