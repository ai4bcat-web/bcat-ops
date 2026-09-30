import { getStops } from './stops'
import type { Driver, Load } from '@/types'
import type { PodDocument, PodSenderMapping } from '@/types/pods'
import { digits, nameKey, senderKey } from './podSenderKey'

/**
 * The driver who texted this POD.
 * 1. Backend mapping by normalized phone or name (highest priority: user override).
 * 2. Roster phone match.
 * 3. Automatic full-name match (requires first + last to avoid bare-first-name collisions).
 */
export function matchPodDriver(
  doc: Pick<PodDocument, 'senderName' | 'senderContact'>,
  drivers: Driver[],
  mappings: PodSenderMapping[],
): Driver | null {
  // Backend override by shared senderKey.
  const key = senderKey(doc)
  if (key) {
    const mapped = mappings.find((m) => m.senderKey === key)
    if (mapped) {
      const driver = drivers.find((d) => d.id === mapped.driverId)
      if (driver) return driver
    }
  }

  const phone = digits(doc.senderContact)
  if (phone.length === 10) {
    const byPhone = drivers.find((d) => digits(d.phone) === phone)
    if (byPhone) return byPhone
  }
  const name = nameKey(doc.senderName)
  if (name.length < 2) return null
  return drivers.find((d) => nameKey(d.name) === name) ?? null
}

export { digits, nameKey, senderKey } from './podSenderKey'

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
