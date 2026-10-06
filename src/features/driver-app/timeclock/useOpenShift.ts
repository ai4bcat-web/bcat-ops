/**
 * The shift this driver currently has running, if any — for the clock in the app header.
 *
 * Shared at module level so the header, the Hours tab and anything else asking show the
 * same shift and the app does not fetch /timeclock once per screen. Cleared on sign-out
 * with the rest of the cached profile, so the next driver on a shared phone never sees the
 * last one's shift.
 *
 * The elapsed figure is derived from the clock-in timestamp on every tick rather than
 * counted up, so a phone that slept for an hour shows an hour more when it wakes instead of
 * however many ticks it managed to fire.
 */
import { useEffect, useState } from 'react'
import { fetchTimeClock, type TimeClockRow } from '../driverApi'

/** How often the app re-asks the server whether the shift is still open. */
const REFRESH_MS = 60_000

let cached: TimeClockRow | null = null
let cachedAt = 0

export function clearCachedShift(): void {
  cached = null
  cachedAt = 0
}

/** Seconds between a clock-in and now. Never negative, for a clock skewed ahead. */
export function elapsedSeconds(clockInAt: string | null | undefined, now = Date.now()): number {
  if (!clockInAt) return 0
  const started = Date.parse(clockInAt)
  if (!Number.isFinite(started)) return 0
  return Math.max(0, Math.floor((now - started) / 1000))
}

/** "7:04:31" — a running clock reads as hours:minutes:seconds, not "7h 4m". */
export function elapsedLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export interface OpenShift {
  shift: TimeClockRow | null
  /** Seconds since clock-in, recomputed each tick. */
  seconds: number
}

export function useOpenShift(enabled: boolean): OpenShift {
  const [shift, setShift] = useState<TimeClockRow | null>(cached)
  /*
   * The tick stores NOW, and the elapsed figure is derived from it in render.
   *
   * Storing the seconds instead would mean writing state from inside the effect that starts
   * the timer, which cascades renders (react-hooks/set-state-in-effect) — and it would also
   * be a second copy of something already implied by the clock-in time and the current time.
   */
  const [now, setNow] = useState(() => Date.now())

  // Ask the server, and keep asking — a driver may clock out on another device.
  useEffect(() => {
    if (!enabled) return
    let stale = false
    const load = () => {
      fetchTimeClock()
        .then((d) => {
          cached = d.openShift
          cachedAt = Date.now()
          if (!stale) setShift(d.openShift)
        })
        .catch(() => { /* the header is a nicety; a failed call simply shows nothing */ })
    }
    if (Date.now() - cachedAt > REFRESH_MS) load()
    const timer = setInterval(load, REFRESH_MS)
    return () => { stale = true; clearInterval(timer) }
  }, [enabled])

  // The visible tick. Only runs while there is something to count.
  useEffect(() => {
    if (!shift?.clockInAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [shift?.clockInAt])

  // Derived from the timestamp, so a phone that slept wakes showing the real elapsed time
  // rather than however many ticks it managed to fire.
  return { shift, seconds: elapsedSeconds(shift?.clockInAt, now) }
}
