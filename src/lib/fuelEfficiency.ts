/**
 * Miles and miles-per-gallon for the fuel page.
 *
 * Fuel transactions tell us gallons; the Motive sync tells us miles (per truck, per
 * day). Neither alone answers the question that actually matters — "is this truck
 * burning more fuel than it should?" — so this pairs them.
 *
 * Kept separate from the fleet-profitability engine on purpose: that one allocates
 * cost (insurance, maintenance, driver pay) and needs a fleet group. MPG needs only
 * miles ÷ gallons, and the fuel page shows every truck regardless of fleet.
 */
import type { TruckMileage } from '@/lib/apiClient'

/** Local calendar day as YYYY-MM-DD — never toISOString(), which shifts to UTC. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Inclusive day-range test against a YYYY-MM-DD string.
 *
 * Compares calendar days rather than instants, so a range whose end is midnight on
 * the last day (rather than 23:59:59) still includes that day's miles — otherwise
 * the final day of every period would silently vanish from the totals.
 */
function withinRange(day: string, [start, end]: [Date, Date]): boolean {
  return day >= dayKey(start) && day <= dayKey(end)
}

/**
 * Miles per truck id over a date range.
 *
 * DAY rows accumulate per (truck, day), so summing them is the range total. Trucks
 * with no mileage rows are simply absent — the caller decides what to show, since a
 * truck that ran no miles and one whose ELD feed is missing look the same here.
 */
export function milesByTruck(rows: TruckMileage[], range: [Date, Date]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    if (!withinRange(r.periodStart, range)) continue
    out.set(r.truckId, (out.get(r.truckId) ?? 0) + (r.miles || 0))
  }
  return out
}

/**
 * Miles per gallon, or null when it can't be computed.
 *
 * Null rather than 0 because they mean different things: a truck with no gallons
 * logged has UNKNOWN efficiency, and showing "0.0 MPG" would read as catastrophic
 * rather than absent. The table renders null as an em dash.
 */
export function mpg(miles: number, gallons: number): number | null {
  if (!(gallons > 0) || !(miles > 0)) return null
  return miles / gallons
}

/** Display form — one decimal is the precision fleet managers actually use. */
export function formatMpg(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(1)}`
}

/** Whole miles with thousands separators. */
export function formatMiles(value: number): string {
  return value > 0 ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value) : '—'
}

// ── Weekly breakdown ───────────────────────────────────────────────────────────

/** A Sunday→Saturday week. Both bounds are inclusive YYYY-MM-DD calendar days. */
export interface WeekBucket { start: string; end: string; label: string }

/** M/D with no leading zeros — "5/31 – 6/6", how the office refers to a week. */
function shortDay(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * The `count` most recent whole weeks ending with the week containing `today`,
 * newest first.
 *
 * Weeks run Sunday→Saturday to match the rest of the fuel page (and the settlement
 * week the office already works in), so 5/31–6/6 is one week.
 */
export function recentWeeks(count: number, today: Date): WeekBucket[] {
  const out: WeekBucket[] = []
  // Back up to the Sunday of the current week, then walk backwards a week at a time.
  const sunday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay())
  for (let i = 0; i < count; i++) {
    const s = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() - i * 7)
    const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6)
    out.push({ start: dayKey(s), end: dayKey(e), label: `${shortDay(s)} – ${shortDay(e)}` })
  }
  return out
}

/** A fuel purchase reduced to what the weekly rollup needs. */
export interface FuelEntry { day: string; amount: number; gallons: number; truckId?: string }

export interface WeekTotals {
  week: WeekBucket
  spend: number
  gallons: number
  miles: number
  mpg: number | null
}

/**
 * Fuel spend, gallons, miles and MPG for each week — for one truck, or the whole
 * fleet when `truckId` is null.
 *
 * Weeks with no activity are still returned. A gap is information: it means the
 * truck sat, or the ELD/fuel feed missed a week, and dropping the row would hide
 * that rather than show it.
 */
export function weeklyTotals(
  entries: FuelEntry[],
  mileage: TruckMileage[],
  weeks: WeekBucket[],
  truckId: string | null,
): WeekTotals[] {
  return weeks.map((week) => {
    const inWeek = (day: string) => day >= week.start && day <= week.end
    let spend = 0, gallons = 0, miles = 0
    for (const e of entries) {
      if (truckId && e.truckId !== truckId) continue
      if (!inWeek(e.day)) continue
      spend += e.amount || 0
      gallons += e.gallons || 0
    }
    for (const m of mileage) {
      if (truckId && m.truckId !== truckId) continue
      if (!inWeek(m.periodStart)) continue
      miles += m.miles || 0
    }
    return { week, spend, gallons, miles, mpg: mpg(miles, gallons) }
  })
}

/**
 * How an MPG reading should be coloured. Class-8 diesel tractors run ~5.5–7.5 MPG;
 * below 5 is worth a look (idling, a heavy lane, or a mechanical problem), above 8
 * is usually a light/box truck rather than a tractor doing something remarkable.
 */
export function mpgTone(value: number | null): 'good' | 'ok' | 'poor' | 'none' {
  if (value == null) return 'none'
  if (value < 5) return 'poor'
  if (value < 6.5) return 'ok'
  return 'good'
}
