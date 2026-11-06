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
  // A load's stops stay in route order — its pickup always before its delivery — whatever
  // the clock says: a delivery window that opens at 08:00 must not sort ahead of the 09:00
  // pickup that feeds it (Josh was shown "Delivered — send POD" before he had picked up).
  // Loads order by the dispatcher's calendar order first (a number, so 1.5 sits between 1
  // and 2 and 10 after 9), then by each load's earliest appointment (timed before
  // first-come-first-served / date-only, see apptOrder.ts). One the dispatcher never
  // ordered goes after the ordered ones.
  const anchor = new Map<string, string>()
  for (const { load, stop } of out) {
    const key = apptSortKey(stop)
    const cur = anchor.get(load.id)
    if (cur === undefined || key < cur) anchor.set(load.id, key)
  }
  return out.sort((a, b) =>
    compareRank(scheduleRank(a.load), scheduleRank(b.load)) ||
    (anchor.get(a.load.id) ?? '').localeCompare(anchor.get(b.load.id) ?? '') ||
    a.load.id.localeCompare(b.load.id) ||
    a.stop.sequence - b.stop.sequence)
}

/** A load's place on the schedule; one the dispatcher never ordered goes after the ordered ones. */
function scheduleRank(load: Pick<PaperworkLoad, 'sortOrder'>): number {
  return typeof load.sortOrder === 'number' && Number.isFinite(load.sortOrder) ? load.sortOrder : Infinity
}

/** Ascending, with Infinity (unordered) last; plain subtraction would give NaN for two of them. */
function compareRank(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1
}

export function isDelivery(stop: PaperworkStop): boolean {
  return stop.type.toLowerCase() === 'delivery'
}

/**
 * The stop the driver is on site at right now stays at the top until they depart; every
 * other open stop keeps the order stopsForDay gave it, which is the dispatcher's. An earlier
 * version also floated any load with freight on board above loads not started, and that
 * overrode the calendar order whenever a driver had done one pickup early.
 */
export function openStopRank(item: TodayStop): number {
  return item.stop.arrivedAt && !item.stop.departedAt ? 0 : 1
}

/** Open stops in the order to show them: on-site first, then the plan. */
export function orderOpenStops(open: readonly TodayStop[]): TodayStop[] {
  return open
    .map((item, i) => ({ item, i, rank: openStopRank(item) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.item)
}
