/**
 * What goes on today's sheet. Pure, so the day can be pinned without a page.
 */
import type { PaperworkLoad, PaperworkStop } from '../driverApi'
import { apptSortKey } from '@/lib/apptOrder'

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
  // Timed appointments first, in time order; a first-come-first-served or date-only stop
  // (stored at midnight) after them, since the driver fits it around the fixed ones.
  return out.sort((a, b) =>
    apptSortKey(a.stop).localeCompare(apptSortKey(b.stop)) || a.stop.sequence - b.stop.sequence)
}

export function isDelivery(stop: PaperworkStop): boolean {
  return stop.type.toLowerCase() === 'delivery'
}
