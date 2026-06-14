import type { Driver } from '@/types'

/**
 * The driver assigned to a given truck (Equipment.id). Single source of truth is
 * `Driver.assignedTruckId` — one driver per truck (enforced on assign in the store).
 */
export function driverForTruck(equipmentId: string, drivers: Driver[]): Driver | undefined {
  return drivers.find((d) => d.assignedTruckId === equipmentId)
}
