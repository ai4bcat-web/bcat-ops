/**
 * Weekly odometer / miles math — pure, no I/O.
 *
 * The motive-odometer-sync Lambda writes one TruckOdometerDay row per truck per
 * America/Chicago calendar day. This module turns those rows into the Sun–Sat
 * grid the Fleet Miles page renders, and computes the truck's weekly revenue the
 * same way the fleet P&L does: `Load.rate` (CENTS) attributed to the load's
 * DELIVERY day and to the delivery driver's assigned truck.
 *
 * Money in → dollars out; miles are Motive odometer miles.
 */

export interface TruckOdometerDay {
  truckId:        string
  date:           string        // YYYY-MM-DD, the day measured
  unitNumber:     string
  weekStart:      string        // YYYY-MM-DD Sunday opening the week
  startOdometer?: number | null
  endOdometer?:   number | null
  miles?:         number | null
  fuelGallons?:   number | null
  mpg?:           number | null
  source?:        string
  syncedAt?:      string
}

/** One calendar cell of the week grid. Null means "Motive had no reading". */
export interface OdometerDayCell {
  date:           string
  label:          string        // 'Sun' … 'Sat'
  startOdometer:  number | null
  endOdometer:    number | null
  miles:          number | null
  fuelGallons:    number | null
  mpg:            number | null
}

export interface OdometerWeekSummary {
  days:             OdometerDayCell[]
  totalMiles:       number
  totalFuelGallons: number | null
  /** Week MPG = total miles ÷ total fuel; null when either side is unknown/zero. */
  mpg:              number | null
}

/** Minimal Load shape needed for the revenue attribution. */
export interface LoadWeekInput {
  truckId?:          string | null
  deliveryDriverId?: string | null
  rate?:             number | null   // CENTS
  deliveryAppt:      string          // ISO datetime or YYYY-MM-DD
}

export interface DriverTruckAssignment {
  driverId:        string
  assignedTruckId?: string | null
  isBroker?:       boolean
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** YYYY-MM-DD `n` days after `date` (calendar arithmetic at UTC noon). */
export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The seven dates of the week starting at `weekStart` (Sun–Sat). */
export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
}

/** Sunday that opens the week containing `date` (weeks run Sun–Sat). */
export function sundayOf(date: string): string {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.toISOString().slice(0, 10)
}

/** The `count` most recent Sundays at or before `from`, newest first. */
export function recentWeekStarts(count: number, from: string): string[] {
  const newest = sundayOf(from)
  return Array.from({ length: count }, (_, i) => addDays(newest, -7 * i))
}

/**
 * Miles between two odometer readings, floored at zero. A backwards reading is a
 * bad read (or a meter swap), not negative distance; null when either side is
 * unknown so a gap stays a gap instead of becoming an invented zero.
 */
export function milesBetween(previous: number | null | undefined, end: number | null | undefined): number | null {
  if (previous == null || end == null) return null
  return Math.max(0, end - previous)
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Build the Sun–Sat grid for one truck's week. `rows` may contain any subset of
 * days (missing days are gaps); rows outside `weekStart` are ignored by date.
 */
export function buildOdometerWeek(weekStart: string, rows: TruckOdometerDay[]): OdometerWeekSummary {
  const byDate = new Map<string, TruckOdometerDay>()
  for (const row of rows) byDate.set(row.date, row)

  const days: OdometerDayCell[] = weekDays(weekStart).map((date) => {
    const row = byDate.get(date)
    if (!row) {
      return { date, label: DAY_LABELS[new Date(date + 'T12:00:00Z').getUTCDay()], startOdometer: null, endOdometer: null, miles: null, fuelGallons: null, mpg: null }
    }
    const start = finite(row.startOdometer)
    const end   = finite(row.endOdometer)
    const stored = finite(row.miles)
    // Trust the stored figure but never let a bad row surface negative miles;
    // fall back to the readings when the sync didn't persist miles.
    const miles = stored != null ? Math.max(0, stored) : milesBetween(start, end)
    const fuelGallons = finite(row.fuelGallons)
    const mpg = finite(row.mpg) ?? (miles != null && fuelGallons != null && fuelGallons > 0 ? miles / fuelGallons : null)
    return { date, label: DAY_LABELS[new Date(date + 'T12:00:00Z').getUTCDay()], startOdometer: start, endOdometer: end, miles, fuelGallons, mpg }
  })

  let totalMiles = 0
  let totalFuelGallons: number | null = null
  for (const d of days) {
    if (d.miles != null) totalMiles += d.miles
    if (d.fuelGallons != null) totalFuelGallons = (totalFuelGallons ?? 0) + d.fuelGallons
  }
  const mpg = totalFuelGallons != null && totalFuelGallons > 0 && totalMiles > 0
    ? totalMiles / totalFuelGallons
    : null

  return { days, totalMiles, totalFuelGallons, mpg }
}

/** A load's delivery DATE (YYYY-MM-DD), tolerant of full ISO datetimes. */
export function deliveryDate(load: LoadWeekInput): string {
  return load.deliveryAppt.slice(0, 10)
}

/**
 * Revenue (dollars) for one truck over the Sun–Sat week, matching
 * calcFleetProfitability's attribution: full rate, delivery day in range, and
 * the truck either set on the load or the delivery driver's assigned truck.
 * Broker-covered loads never count toward a truck.
 */
export function truckWeekRevenue(
  truckId: string,
  weekStart: string,
  loads: LoadWeekInput[],
  assignments: DriverTruckAssignment[],
): number {
  const weekEnd = addDays(weekStart, 6)
  const truckForDriver = new Map<string, string>()
  const brokerDrivers = new Set<string>()
  for (const a of assignments) {
    if (a.assignedTruckId) truckForDriver.set(a.driverId, a.assignedTruckId)
    if (a.isBroker) brokerDrivers.add(a.driverId)
  }

  let revenue = 0
  for (const load of loads) {
    const d = deliveryDate(load)
    if (d < weekStart || d > weekEnd) continue
    const driverId = load.deliveryDriverId ?? undefined
    if (driverId && brokerDrivers.has(driverId)) continue
    const onTruck = load.truckId ?? (driverId ? truckForDriver.get(driverId) : undefined)
    if (onTruck !== truckId) continue
    revenue += (load.rate ?? 0) / 100
  }
  return revenue
}

/** Revenue per mile; null (never Infinity/NaN) when the truck drove no miles. */
export function revenuePerMile(revenue: number, miles: number): number | null {
  return miles > 0 ? revenue / miles : null
}
