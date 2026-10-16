/**
 * Odometer-based miles — the fleet's preferred mileage source.
 *
 * The odometer ledger (TruckOdometerDay) holds each truck's end-of-day odometer and the
 * day's miles (end minus the previous reading). It is exact and never lags more than the
 * nightly close. Today's miles come from the live odometer minus the last closed reading.
 * Motive's IFTA trip feed is only the fallback for days the ledger does not cover.
 */

export interface OdometerDayRow {
  truckId:      string
  date:         string           // YYYY-MM-DD (America/Chicago calendar day)
  miles?:       number | null
  endOdometer?: number | null
}

export type OdometerIndex = Map<string, Map<string, OdometerDayRow>>

export function indexOdometerRows(rows: OdometerDayRow[]): OdometerIndex {
  const out: OdometerIndex = new Map()
  for (const r of rows) {
    if (!r.truckId || !r.date) continue
    let m = out.get(r.truckId)
    if (!m) { m = new Map(); out.set(r.truckId, m) }
    m.set(r.date, r)
  }
  return out
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The most recent closed reading strictly before `date`, if any. */
function lastClosedBefore(days: Map<string, OdometerDayRow>, date: string): number | null {
  let best: { date: string; end: number } | null = null
  for (const r of days.values()) {
    const end = num(r.endOdometer)
    if (end == null || r.date >= date) continue
    if (!best || r.date > best.date) best = { date: r.date, end }
  }
  return best?.end ?? null
}

/**
 * Miles for one truck on one day from the ledger, or from the live odometer when the
 * day is today and has not been closed yet. Null when the ledger has nothing to say.
 */
export function dayMilesFromOdometer(
  index: OdometerIndex,
  truckId: string,
  date: string,
  today: string,
  liveOdometer: number | null | undefined,
): number | null {
  const days = index.get(truckId)
  if (!days) return null
  const row = days.get(date)
  const closed = row ? num(row.miles) : null
  if (closed != null) return closed
  if (date === today && liveOdometer != null) {
    const last = lastClosedBefore(days, date)
    if (last != null) return Math.max(0, liveOdometer - last)
  }
  return null
}

/** True when the ledger has a reading for this truck on or before `start` — i.e. it can
 *  account for every day of the range without help from another source. */
export function ledgerCovers(index: OdometerIndex, truckId: string, start: string): boolean {
  const days = index.get(truckId)
  if (!days) return false
  for (const d of days.keys()) if (d <= start) return true
  return false
}

function nextDay(date: string): string {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Sum of odometer miles over [start, end] (capped at today). Null when the ledger does
 * not cover the range start, so the caller can fall back to the IFTA feed.
 */
export function rangeMilesFromOdometer(
  index: OdometerIndex,
  truckId: string,
  start: string,
  end: string,
  today: string,
  liveOdometer: number | null | undefined,
): number | null {
  if (!ledgerCovers(index, truckId, start)) return null
  let total = 0
  const last = end < today ? end : today
  for (let d = start; d <= last; d = nextDay(d)) {
    total += dayMilesFromOdometer(index, truckId, d, today, liveOdometer) ?? 0
  }
  return total
}

/** Split [start, end] into windows of at most `maxDays` days (Motive caps IFTA queries at 3 months). */
export function chunkRange(start: string, end: string, maxDays = 90): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = []
  let s = start
  while (s <= end) {
    const d = new Date(s + 'T12:00:00Z')
    d.setUTCDate(d.getUTCDate() + maxDays - 1)
    const e = d.toISOString().slice(0, 10)
    out.push({ start: s, end: e < end ? e : end })
    s = nextDay(e)
  }
  return out
}
