import { getStops } from './stops'
import type { Driver, Load } from '@/types'
import type { PodDocument } from '@/types/pods'

const digits = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '').slice(-10)
const alphaTokens = (s: string | null | undefined): string[] =>
  (s ?? '').toLowerCase().match(/[a-z]+/g) ?? []
const nameKey = (s: string | null | undefined): string => alphaTokens(s).join('')

/**
 * The driver who texted this POD. JobsDone gives us the sender's phone and the name
 * they registered with; the roster stores E.164 phones. Phone is the reliable key;
 * name is only used as a fallback when the sender provides at least a first and last
 * name, to avoid matching a bare first name to the wrong driver.
 */
export function matchPodDriver(doc: Pick<PodDocument, 'senderName' | 'senderContact'>, drivers: Driver[]): Driver | null {
  const phone = digits(doc.senderContact)
  if (phone.length === 10) {
    const byPhone = drivers.find((d) => digits(d.phone) === phone)
    if (byPhone) return byPhone
  }
  if (alphaTokens(doc.senderName).length < 2) return null
  const name = nameKey(doc.senderName)
  if (!name) return null
  return drivers.find((d) => nameKey(d.name) === name) ?? null
}

function latestDriverAppt(load: Load, driverId: string): string | null {
  const stops = getStops(load)
  return stops
    .filter((s) => s.driverId === driverId && s.appt)
    .map((s) => s.appt)
    .sort()
    .pop() ?? null
}

/** Loads this driver delivered (or picked up), most recent stop first. */
export function recentLoadsForDriver(loads: Load[], driverId: string, limit = 15): Load[] {
  return loads
    .filter((l) => getStops(l).some((s) => s.driverId === driverId))
    .sort((a, b) => Date.parse(latestDriverAppt(b, driverId) || '0') - Date.parse(latestDriverAppt(a, driverId) || '0'))
    .slice(0, limit)
}
