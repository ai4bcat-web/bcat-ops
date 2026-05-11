export const TZ = 'America/Chicago'

// ── Display formatters (all output in Chicago time) ──────────────────────────

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso))
}

export function formatDateShort(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso))
}

export function formatDayHeader(iso: string): { weekday: string; date: string } {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
  }).format(new Date(iso))
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso))
  return { weekday, date }
}

export function formatDelivery(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso))
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso))
}

export function formatDateTimeInput(iso: string): string {
  // Returns "YYYY-MM-DDTHH:mm" in Chicago time for datetime-local input
  const d = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

export function fromDateTimeInput(localStr: string): string {
  // "YYYY-MM-DDTHH:mm" in Chicago time → ISO UTC string
  if (!localStr) return ''
  const [datePart, timePart] = localStr.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  const [h, min] = (timePart ?? '00:00').split(':').map(Number)

  // Use Intl to find the UTC offset for Chicago at this local time
  // Build a reference date in Chicago to derive UTC
  const approx = new Date(`${datePart}T${timePart ?? '00:00'}:00Z`)
  const chiStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(approx)
    .reduce(
      (acc, p) => ({ ...acc, [p.type]: p.value }),
      {} as Record<string, string>
    )

  const chiEpoch = Date.UTC(
    Number(chiStr.year),
    Number(chiStr.month) - 1,
    Number(chiStr.day),
    Number(chiStr.hour),
    Number(chiStr.minute)
  )
  const localEpoch = Date.UTC(y, m - 1, d, h, min)
  return new Date(localEpoch - (chiEpoch - approx.getTime())).toISOString()
}

// ── Date math ────────────────────────────────────────────────────────────────

/** YYYY-MM-DD in Chicago timezone */
export function chicagoDateStr(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d)
}

/** Get the Monday of the week containing `date` (using system timezone for calendar navigation) */
export function getMondayOf(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

/** Add N days to a date */
export function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

/** Return ISO dates for Mon–Fri of the week (for work-week view) */
export function getWorkWeek(monday: Date): Date[] {
  return Array.from({ length: 5 }, (_, i) => addDays(monday, i))
}

/** Return ISO dates for all 7 days of the week */
export function getFullWeek(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}

/** Return 14 days starting from monday */
export function getTwoWeeks(monday: Date): Date[] {
  return Array.from({ length: 14 }, (_, i) => addDays(monday, i))
}

/** Is this date "today" in Chicago time? */
export function isToday(date: Date): boolean {
  return chicagoDateStr(date) === chicagoDateStr(new Date())
}

/** Do two ISO datetimes fall on the same calendar day in Chicago? */
export function isSameChicagoDay(a: string, b: string): boolean {
  return chicagoDateStr(a) === chicagoDateStr(b)
}

/** Format an appointment time respecting its type (exact / range / FCFS) */
export function formatApptTime(
  appt: string,
  type?: string,
  apptEnd?: string,
): string {
  if (type === 'fcfs') return 'FCFS'
  if (type === 'range' && apptEnd) return `${formatTime(appt)}–${formatTime(apptEnd)}`
  return formatTime(appt)
}

/** "YYYY-MM-DD" in Chicago timezone for <input type="date"> */
export function formatDateInput(iso: string): string {
  return chicagoDateStr(iso)
}

/** "YYYY-MM-DD" → ISO UTC at midnight Chicago time */
export function fromDateInput(dateStr: string): string {
  return fromDateTimeInput(`${dateStr}T00:00`)
}

/** Duration between pickup and delivery in whole days */
export function spanDays(pickupIso: string, deliveryIso: string): number {
  const p = chicagoDateStr(pickupIso)
  const d = chicagoDateStr(deliveryIso)
  if (p === d) return 1
  const ms = new Date(d).getTime() - new Date(p).getTime()
  return Math.max(1, Math.round(ms / 86_400_000) + 1)
}
