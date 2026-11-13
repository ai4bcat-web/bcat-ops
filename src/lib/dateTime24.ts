/**
 * Typed date and 24-hour time entry for the shipment form (Ryne, 2026-11-13: no picker,
 * always military time). Pure parsers over the form's local wall-clock value
 * `YYYY-MM-DDTHH:mm` (America/Chicago, the same string a datetime-local input held), so
 * nothing about how stops are stored changes.
 */

const pad = (n: number): string => String(n).padStart(2, '0')

function validYmd(y: number, m: number, d: number): boolean {
  if (!(m >= 1 && m <= 12 && d >= 1 && y >= 1900 && y <= 2999)) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * US date text → `YYYY-MM-DD`, or null. Accepts M/D, MM/DD, M/D/YY, MM/DD/YYYY (slash, dash
 * or dot), MMDD / MMDDYY / MMDDYYYY digits, and an ISO `YYYY-MM-DD`. With no year it picks
 * this year, or next year when that date is more than 60 days back (12/30 typed in January).
 */
export function parseUsDate(text: string, today: Date = new Date()): string | null {
  const t = text.trim()
  if (!t) return null
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    return validYmd(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null
  }
  let m: number, d: number, y: number | null = null
  const parts = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(t)
  const digits = /^\d+$/.test(t) ? t : null
  if (parts) {
    m = Number(parts[1]); d = Number(parts[2])
    if (parts[3]) y = parts[3].length === 2 ? 2000 + Number(parts[3]) : Number(parts[3])
  } else if (digits && [4, 6, 8].includes(digits.length)) {
    m = Number(digits.slice(0, 2)); d = Number(digits.slice(2, 4))
    if (digits.length === 6) y = 2000 + Number(digits.slice(4))
    if (digits.length === 8) y = Number(digits.slice(4))
  } else {
    return null
  }
  if (y === null) {
    y = today.getFullYear()
    const candidate = Date.UTC(y, m - 1, d)
    const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
    if (validYmd(y, m, d) && now - candidate > 60 * 86_400_000) y += 1
  }
  return validYmd(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null
}

/** 24-hour time text → `HH:MM`, or null. Accepts 0700, 700, 07:00, 7:00, 7 (an hour), 7.30. */
export function parse24Time(text: string): string | null {
  const t = text.trim()
  if (!t) return null
  let h: number, min: number
  const sep = /^(\d{1,2})[:.h](\d{2})$/i.exec(t)
  if (sep) {
    h = Number(sep[1]); min = Number(sep[2])
  } else if (/^\d{1,4}$/.test(t)) {
    if (t.length <= 2) { h = Number(t); min = 0 } else { h = Number(t.slice(0, -2)); min = Number(t.slice(-2)) }
  } else {
    return null
  }
  return h >= 0 && h <= 23 && min >= 0 && min <= 59 ? `${pad(h)}:${pad(min)}` : null
}

/** `YYYY-MM-DD` → `MM/DD/YYYY`. */
export function formatUsDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ''
}

/** Split a local `YYYY-MM-DDTHH:mm` value into its date and time halves ('' when absent). */
export function splitLocal(value: string): { date: string; time: string } {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(value ?? '')
  return m ? { date: m[1], time: m[2] ?? '' } : { date: '', time: '' }
}

/**
 * A window out of a location's hours text: "FCFS 06:00 TO 15:00", "0700-1600", "7am - 6pm".
 * Returns the first two times found, or null when there aren't two.
 */
export function parseHoursRange(hours: string): { from: string; to: string } | null {
  const found: string[] = []
  const re = /(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?\b/gi
  for (const m of (hours ?? '').matchAll(re)) {
    const raw = m[0].trim()
    const hasMinutes = m[2] !== undefined
    const ampm = (m[3] ?? '').toLowerCase()
    // A lone number without minutes or am/pm (e.g. the "7" in "7 days") is not a time.
    if (!hasMinutes && !ampm && !/^\d{3,4}$/.test(raw)) continue
    let h = Number(m[1])
    const min = hasMinutes ? Number(m[2]) : 0
    if (ampm.startsWith('p') && h < 12) h += 12
    if (ampm.startsWith('a') && h === 12) h = 0
    if (h > 23 || min > 59) continue
    found.push(`${pad(h)}:${pad(min)}`)
    if (found.length === 2) break
  }
  return found.length === 2 ? { from: found[0], to: found[1] } : null
}
