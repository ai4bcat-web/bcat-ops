/**
 * Which day the Ivan app opens on.
 *
 * Ivan's local drivers get tomorrow's sheet from 8 PM Chicago, so the evening look at the
 * phone shows the next day's pickups and deliveries. Box truck drivers and anyone else on
 * the app keep today until midnight.
 */
import { chicagoDateStr } from '@/lib/date'

export const NEXT_DAY_HOUR = 20

export function defaultSheetDay(now: Date, ivanLocal: boolean): { day: string; isTomorrow: boolean } {
  const today = chicagoDateStr(now)
  if (!ivanLocal) return { day: today, isTomorrow: false }
  // Some engines print midnight as "24" with hour12 off; wrap it.
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false })) % 24
  if (hour < NEXT_DAY_HOUR) return { day: today, isTomorrow: false }
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return { day: tomorrow, isTomorrow: true }
}
