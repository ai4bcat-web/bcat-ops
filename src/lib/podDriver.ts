import { getStops } from './stops'
import type { Driver, Load } from '@/types'
import type { PodDocument, PodSenderMapping } from '@/types/pods'

export function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '').slice(-10)
}

const alphaTokens = (s: string | null | undefined): string[] =>
  (s ?? '').toLowerCase().match(/[a-z]+/g) ?? []

const nameKey = (s: string | null | undefined): string => alphaTokens(s).join('')

/**
 * Stable backend key for a sender. Phone-first (last 10 digits); otherwise a
 * normalized name key so email-only senders can also be mapped.
 */
export function senderKey(doc: Pick<PodDocument, 'senderName' | 'senderContact'>): string {
  const phone = digits(doc.senderContact)
  if (phone.length === 10) return `phone:${phone}`
  const name = nameKey(doc.senderName)
  if (name.length >= 2) return `name:${name}`
  return `name:${(doc.senderName ?? 'unknown').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-') || 'unknown'}`
}

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
  const mapped = mappings.find((m) => m.senderKey === senderKey(doc))
  if (mapped) {
    const driver = drivers.find((d) => d.id === mapped.driverId)
    if (driver) return driver
  }

  const phone = digits(doc.senderContact)
  if (phone.length === 10) {
    const byPhone = drivers.find((d) => digits(d.phone) === phone)
    if (byPhone) return byPhone
  }
  const name = nameKey(doc.senderName)
  if (alphaTokens(doc.senderName).length < 2) return null
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
