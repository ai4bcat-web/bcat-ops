/** Pay weeks are 7-day Sunday→Saturday windows (matching the Amazon pay sheets). */

export function sundayOf(ref: Date = new Date()): string {
  const x = new Date(Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate()))
  x.setUTCDate(x.getUTCDate() - x.getUTCDay()) // back to Sunday (getUTCDay: 0 = Sun)
  return x.toISOString().slice(0, 10)
}

/** Pay-week start (Sunday) for a YYYY-MM-DD date string. */
export function weekStartOfISO(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.toISOString().slice(0, 10)
}

/** Most common value in a list (first-seen wins ties); null if empty. */
export function modeOf(values: string[]): string | null {
  const counts = new Map<string, number>()
  let best: string | null = null
  let bestN = 0
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1
    counts.set(v, n)
    if (n > bestN) { bestN = n; best = v }
  }
  return best
}

export function shiftWeek(periodStart: string, weeks: number): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + weeks * 7)
  return d.toISOString().slice(0, 10)
}

export function weekLabel(periodStart: string): string {
  const s = new Date(`${periodStart}T12:00:00Z`)
  const e = new Date(s); e.setUTCDate(e.getUTCDate() + 6)
  const fmt = (x: Date) => x.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
  return `${fmt(s)} – ${fmt(e)}`
}

export function weekLabelLong(periodStart: string): string {
  const s = new Date(`${periodStart}T12:00:00Z`)
  const e = new Date(s); e.setUTCDate(e.getUTCDate() + 6)
  const fmt = (x: Date) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  return `${fmt(s)} – ${fmt(e)}`
}
