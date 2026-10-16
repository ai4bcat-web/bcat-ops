/**
 * Loaded vs empty miles from a driver's day.
 *
 * A day is a chain of odometer readings: clock in at the yard, arrive/depart at each stop,
 * clock out at the yard. Every pair of consecutive readings is a leg. A leg is LOADED when
 * the truck has freight on board when it starts — a load is on board from the moment the
 * driver departs its pickup until the moment they arrive at its delivery — and EMPTY
 * otherwise (yard to first pickup, delivery to next pickup, last delivery back to the yard,
 * trailer moves). A load picked up but not delivered by clock out stays on board overnight,
 * so the next morning's yard-to-delivery leg is loaded.
 *
 * Readings are taken from the truck's odometer at the moment of each tap, so a missing
 * reading (an office-side status change, a tap with no truck on file) breaks the chain:
 * that leg's miles are UNKNOWN rather than guessed.
 */

export type DayEventKind = 'CLOCK_IN' | 'ARRIVED' | 'DEPARTED' | 'CLOCK_OUT'

export interface DayEvent {
  at:        string               // ISO
  kind:      DayEventKind
  odometer:  number | null
  stopType?: 'pickup' | 'delivery'
  loadId?:   string
  /** Short place name for the leg labels (facility, or "Yard"). */
  place?:    string
  /** Customer on the load, so empty miles can be charged to the lane that caused them. */
  customer?: string | null
}

export interface Leg {
  from:     string
  to:       string
  startAt:  string
  endAt:    string
  miles:    number | null        // null = a reading was missing
  loaded:   boolean
  /** Loads on board during the leg. */
  loadIds:  string[]
  /** For an empty leg, the load the truck was heading to pick up (whose lane caused the deadhead). */
  towardLoadId?: string
  towardCustomer?: string | null
}

export interface DaySummary {
  legs:        Leg[]
  loadedMiles: number
  emptyMiles:  number
  /** Legs with no miles because a reading was missing. */
  unknownLegs: number
  /** Loads still on board at the last reading (ending the day loaded). */
  onboardAtEnd: string[]
}

/** Walk the day's readings and classify each leg. `onboardAtStart` = loads picked up on an earlier day and not yet delivered. */
export function buildDayLegs(events: DayEvent[], onboardAtStart: string[] = []): DaySummary {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at))
  const onboard = new Set(onboardAtStart)
  const legs: Leg[] = []
  let prev: DayEvent | null = null
  let loadedMiles = 0, emptyMiles = 0, unknownLegs = 0

  for (const ev of sorted) {
    if (prev) {
      const loaded = onboard.size > 0
      const miles = prev.odometer != null && ev.odometer != null ? Math.max(0, ev.odometer - prev.odometer) : null
      // Zero-mile hops (arrive → depart at the same dock) add nothing and only clutter the day.
      if (miles !== 0) {
        const leg: Leg = {
          from: prev.place ?? prev.kind, to: ev.place ?? ev.kind, startAt: prev.at, endAt: ev.at,
          miles, loaded, loadIds: [...onboard],
        }
        if (!loaded && ev.kind === 'ARRIVED' && ev.stopType === 'pickup' && ev.loadId) {
          leg.towardLoadId = ev.loadId
          leg.towardCustomer = ev.customer ?? null
        }
        legs.push(leg)
        if (miles == null) unknownLegs += 1
        else if (loaded) loadedMiles += miles
        else emptyMiles += miles
      }
    }
    if (ev.kind === 'DEPARTED' && ev.stopType === 'pickup' && ev.loadId) onboard.add(ev.loadId)
    if (ev.kind === 'ARRIVED' && ev.stopType === 'delivery' && ev.loadId) onboard.delete(ev.loadId)
    prev = ev
  }
  return { legs, loadedMiles, emptyMiles, unknownLegs, onboardAtEnd: [...onboard] }
}

export interface DeadheadTotals {
  loadedMiles: number
  emptyMiles:  number
  unknownLegs: number
  /** Empty miles as a share of all measured miles. */
  emptyShare:  number | null
}

export function totals(days: DaySummary[]): DeadheadTotals {
  const loadedMiles = days.reduce((s, d) => s + d.loadedMiles, 0)
  const emptyMiles = days.reduce((s, d) => s + d.emptyMiles, 0)
  const unknownLegs = days.reduce((s, d) => s + d.unknownLegs, 0)
  const all = loadedMiles + emptyMiles
  return { loadedMiles, emptyMiles, unknownLegs, emptyShare: all > 0 ? emptyMiles / all : null }
}

/** Empty miles charged to the customer whose pickup the truck was driving to. */
export function emptyMilesByCustomer(days: DaySummary[]): Array<{ customer: string; emptyMiles: number; legs: number }> {
  const by = new Map<string, { emptyMiles: number; legs: number }>()
  for (const d of days) for (const l of d.legs) {
    if (l.loaded || l.miles == null || !l.towardLoadId) continue
    const key = (l.towardCustomer ?? '').trim().toUpperCase() || 'UNKNOWN'
    const row = by.get(key) ?? { emptyMiles: 0, legs: 0 }
    row.emptyMiles += l.miles; row.legs += 1
    by.set(key, row)
  }
  return [...by.entries()].map(([customer, v]) => ({ customer, ...v })).sort((a, b) => b.emptyMiles - a.emptyMiles)
}

/** Where a driver's day starts and ends, by fleet: the Ivan yard, or the box truck's base. */
export function baseLabelFor(fleetGroup: string | null | undefined): string {
  return fleetGroup === 'BOX_TRUCK' ? 'Base · 1193 E Higgins Rd, Elk Grove Village' : 'Yard · Pleasant Prairie'
}
