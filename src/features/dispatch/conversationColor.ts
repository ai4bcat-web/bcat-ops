import { COLOR_MAP, getColor, type DriverColor } from '@/lib/driverColors'
import type { ColorKey } from '@/types'
import type { Driver } from '@/types'
import { phoneColorSlot, type DispatchConversation } from '@/lib/dispatch'

const KEYS = Object.keys(COLOR_MAP) as ColorKey[]

/**
 * The colour a conversation wears everywhere on the Dispatch page: the linked driver's
 * own colour (the same one the calendar and dashboard use), else a stable colour hashed
 * from the number so an unknown line is still told apart at a glance.
 */
export function conversationColor(c: Pick<DispatchConversation, 'phone' | 'driverId'>, drivers: readonly Driver[]): DriverColor {
  const driver = c.driverId ? drivers.find((d) => d.id === c.driverId) : undefined
  if (driver?.colorKey) return getColor(driver.colorKey)
  return getColor(KEYS[phoneColorSlot(c.phone, KEYS.length)])
}

/** Two-letter initials for the avatar. */
export function initialsOf(title: string): string {
  const parts = title.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '#'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}
