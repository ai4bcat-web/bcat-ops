import type { Stop } from '@/types'

/**
 * What the driver app recorded at a stop, as one readable line for staff:
 *   pickup   → "On site 9:12 AM · Departed 9:48 AM"
 *   delivery → "On site 1:05 PM · POD sent 1:22 PM · Delivered 1:30 PM"
 * Only times that were actually recorded appear; null when the app recorded nothing.
 */
export function clockTime(iso: string | null | undefined): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })
}

export function stopTapsLine(stop: Pick<Stop, 'type' | 'arrivedAt' | 'departedAt'>, podSentAt?: string | null): string | null {
  const parts: string[] = []
  const arrived = clockTime(stop.arrivedAt)
  const departed = clockTime(stop.departedAt)
  if (arrived) parts.push(`On site ${arrived}`)
  if (stop.type === 'pickup') {
    if (departed) parts.push(`Departed ${departed}`)
  } else {
    const pod = clockTime(podSentAt)
    if (pod) parts.push(`POD sent ${pod}`)
    if (departed) parts.push(`Delivered ${departed}`)
  }
  return parts.length ? parts.join(' · ') : null
}

/** Earliest POD page the driver sent for a load, ISO, or null. */
export function podSentAtFrom(docs: ReadonlyArray<{ kind?: string | null; uploadedAt?: string | null }>): string | null {
  const times = docs
    .filter((d) => (d.kind ?? 'POD').toUpperCase() === 'POD')
    .map((d) => (d.uploadedAt ?? '').trim())
    .filter((t) => t && !Number.isNaN(Date.parse(t)))
    .sort()
  return times[0] ?? null
}
