import { driverGroupOf } from '@/lib/driverFilter'
import type { Driver, Load, Stop } from '@/types'

/** The calendar's sections inside a day: Ivan Cartage's own drivers, owner operators, then everything with nobody on it. */
export type FleetSection = 'IVAN' | 'OWNER_OP' | 'UNASSIGNED'

export const FLEET_SECTIONS: readonly { key: FleetSection; label: string }[] = [
  { key: 'IVAN', label: 'Ivan Cartage drivers' },
  { key: 'OWNER_OP', label: 'Owner operators' },
  { key: 'UNASSIGNED', label: 'Unassigned / need to cover' },
]

interface SectionEntry { load: Load; role: 'pickup' | 'delivery' | 'same-day'; stop?: Stop }

/** The driver a row belongs to: its stop's own driver, else the pickup driver (pickup / same-day row) or the delivery driver. */
function rowDriverId(e: SectionEntry): string | null {
  if (e.stop) return e.stop.driverId ?? null
  return (e.role === 'delivery' ? e.load.deliveryDriverId : e.load.pickupDriverId) ?? null
}

/** Which section a row sits in. A placeholder broker driver (BROKER NEED TO COVER / COVERED) is nobody, so it is Unassigned. */
export function sectionOf(e: SectionEntry, drivers: readonly Pick<Driver, 'id' | 'fleetGroup' | 'driverType' | 'type'>[]): FleetSection {
  const id = rowDriverId(e)
  const driver = id ? drivers.find((d) => d.id === id) : undefined
  if (!driver) return 'UNASSIGNED'
  const group = driverGroupOf(driver)
  return group === 'IVAN' ? 'IVAN' : group === 'OWNER_OP' ? 'OWNER_OP' : 'UNASSIGNED'
}

/** Split a day's rows into the sections, keeping each section's own order; empty sections are left out. */
export function splitIntoSections<T extends SectionEntry>(entries: readonly T[], drivers: readonly Pick<Driver, 'id' | 'fleetGroup' | 'driverType' | 'type'>[]): { key: FleetSection; label: string; entries: T[] }[] {
  return FLEET_SECTIONS
    .map(({ key, label }) => ({ key, label, entries: entries.filter((e) => sectionOf(e, drivers) === key) }))
    .filter((s) => s.entries.length > 0)
}
