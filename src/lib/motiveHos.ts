/**
 * One day of a driver's hours of service, shaped for the Ivan driver app.
 *
 * READ ONLY, deliberately. Duty status is a federal record and the FMCSA requires edits to
 * go through the certified ELD, so this shows a driver what Motive already holds and sends
 * them to the Motive app to change anything. Nothing here writes to Motive.
 *
 * Ivan drivers only — owner operators do not get this.
 *
 * Motive reports durations in SECONDS and times as UTC ISO strings. Both are kept as they
 * arrive; formatting belongs to the screen, not here.
 */

/** A duty status segment as Motive reports it. */
export interface MotiveEvent {
  type?: string | null
  start_time?: string | null
  end_time?: string | null
  location?: string | null
}

/** One day's log as Motive reports it. */
export interface MotiveLog {
  date?: string | null
  driving_duration?: number | null
  on_duty_duration?: number | null
  off_duty_duration?: number | null
  sleeper_duration?: number | null
  total_miles?: number | null
  vehicle_numbers?: unknown
  events?: Array<{ event?: MotiveEvent }> | null
}

export interface HosSegment {
  /** 'off_duty' | 'on_duty' | 'driving' | 'sleeper', as Motive names them. */
  type: string
  startAt: string
  endAt: string | null
  location: string | null
}

export interface HosDay {
  date: string
  drivingSeconds: number
  onDutySeconds: number
  offDutySeconds: number
  sleeperSeconds: number
  /** Driving + on duty — the part of the day that counts as worked. */
  workedSeconds: number
  totalMiles: number | null
  vehicleNumbers: string[]
  /**
   * First moment the driver went anything other than off duty, and the last moment they
   * came off it. This is the pair the office compares a time card against.
   */
  firstOnDutyAt: string | null
  lastOffDutyAt: string | null
  segments: HosSegment[]
}

const WORKING = new Set(['on_duty', 'driving'])

function seconds(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * Motive's day into ours.
 *
 * Segments keep Motive's order, which is chronological. A segment with no end_time is the
 * one still running — kept, with a null end, rather than dropped: "on duty since 06:12 and
 * still going" is exactly what someone looking at today needs to see.
 */
export function toHosDay(log: MotiveLog): HosDay {
  const segments: HosSegment[] = (log.events ?? [])
    .map((e) => e?.event)
    .filter((e): e is MotiveEvent => !!e && !!str(e.start_time))
    .map((e) => ({
      type: (str(e.type) ?? 'unknown').toLowerCase(),
      startAt: str(e.start_time)!,
      endAt: str(e.end_time),
      location: str(e.location),
    }))

  const working = segments.filter((s) => WORKING.has(s.type))
  const driving = seconds(log.driving_duration)
  const onDuty = seconds(log.on_duty_duration)

  const vehicles = Array.isArray(log.vehicle_numbers)
    ? log.vehicle_numbers.map((v) => String(v).trim()).filter(Boolean)
    : []

  return {
    date: str(log.date) ?? '',
    drivingSeconds: driving,
    onDutySeconds: onDuty,
    offDutySeconds: seconds(log.off_duty_duration),
    sleeperSeconds: seconds(log.sleeper_duration),
    // Driving is reported separately from on-duty-not-driving, so the day's work is both.
    workedSeconds: driving + onDuty,
    totalMiles: typeof log.total_miles === 'number' ? log.total_miles : null,
    vehicleNumbers: vehicles,
    firstOnDutyAt: working[0]?.startAt ?? null,
    // The end of the last working segment. Null while that segment is still running, which
    // is the honest answer for a day in progress.
    lastOffDutyAt: working.length ? working[working.length - 1].endAt : null,
    segments,
  }
}

/** "6h 36m" — how a driver reads a duration. Zero is "0h 0m", never blank. */
export function hoursLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** Hours as a decimal, for a time card comparison. Two places is plenty for payroll. */
export function decimalHours(totalSeconds: number): number {
  return Math.round((Math.max(0, totalSeconds) / 3600) * 100) / 100
}
