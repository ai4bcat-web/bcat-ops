/** Pay weeks are 7-day Sunday→Saturday windows (matching the Amazon pay sheets). */

export function sundayOf(ref: Date = new Date()): string {
  const x = new Date(Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate()))
  x.setUTCDate(x.getUTCDate() - x.getUTCDay()) // back to Sunday (getUTCDay: 0 = Sun)
  return x.toISOString().slice(0, 10)
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
