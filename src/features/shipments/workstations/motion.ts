/**
 * Tracking display derives from evidence, not the configured provider. The list
 * currently projects only one position: without a comparable earlier fix neither
 * movement nor a stop can be proved, so the workstation honestly says No signal.
 */
export type Motion = 'Moving' | 'Stopped' | 'No signal'

export interface MotionInput {
  lastUpdateAt?: string | null
  lastUpdatePlace?: string | null
  /** Optional evidence, not a claim that the shipment list projects history. */
  previousUpdateAt?: string | null
  previousUpdatePlace?: string | null
  nowMs: number
}

export function motionOf(input: MotionInput): Motion {
  const currentAt = Date.parse(input.lastUpdateAt ?? '')
  const previousAt = Date.parse(input.previousUpdateAt ?? '')
  const age = input.nowMs - currentAt
  if (!Number.isFinite(currentAt) || age < 0 || age > 4 * 3_600_000) return 'No signal'
  const currentPlace = input.lastUpdatePlace?.trim().toLowerCase()
  const previousPlace = input.previousUpdatePlace?.trim().toLowerCase()
  if (!currentPlace || !previousPlace || !Number.isFinite(previousAt)
    || previousAt >= currentAt || input.nowMs - previousAt > 4 * 3_600_000) return 'No signal'
  if (currentPlace === previousPlace) return 'Stopped'
  return age <= 90 * 60_000 ? 'Moving' : 'No signal'
}

/** A caller-owned clock keeps appointment and location labels consistent. */
export function relativeTime(iso: string | null | undefined, nowMs: number): string | null {
  const then = Date.parse(iso ?? '')
  if (!Number.isFinite(then)) return null
  const minutes = Math.round((then - nowMs) / 60_000)
  if (minutes === 0) return 'just now'
  const abs = Math.abs(minutes)
  const duration = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`
  return minutes < 0 ? `${duration} ago` : `in ${duration}`
}
