import { useMemo, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { Load, Driver } from '@/types'
import { chicagoDateStr } from '@/lib/date'
import { getStops } from '@/lib/stops'
import { useAppStore } from '@/store/useAppStore'

/** Returns IDs of all loads that have overlapping time windows with another load on the same driver+day. */
function detectConflicts(loads: Load[]): Set<string> {
  const ids = new Set<string>()
  // Group by pickupDriverId + Chicago pickup day
  const groups = new Map<string, Load[]>()

  for (const load of loads) {
    if (!load.pickupDriverId) continue
    const key = `${load.pickupDriverId}::${chicagoDateStr(load.pickupAppt)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(load)
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]
        // Overlap: a.start < b.end && b.start < a.end
        if (a.pickupAppt < b.deliveryAppt && b.pickupAppt < a.deliveryAppt) {
          ids.add(a.id)
          ids.add(b.id)
        }
      }
    }
  }

  return ids
}

/**
 * Multi-stop variant: group STOPS by driver + Chicago day and flag overlapping windows.
 * Each stop's window is [appt, apptEnd ?? appt]. Only CROSS-load overlaps count (a load's
 * own pickup/delivery on the same driver/day is not a double-booking). Catches conflicts on
 * a delivery day that the legacy pickup-day-only model structurally can't see. Returns LOAD ids.
 */
export function detectConflictsByStop(loads: Load[]): Set<string> {
  const ids = new Set<string>()
  const groups = new Map<string, { loadId: string; start: string; end: string }[]>()

  for (const load of loads) {
    for (const stop of getStops(load)) {
      if (!stop.driverId || !stop.appt) continue
      const key = `${stop.driverId}::${chicagoDateStr(stop.appt)}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push({ loadId: load.id, start: stop.appt, end: stop.apptEnd ?? stop.appt })
    }
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]
        if (a.loadId === b.loadId) continue // a load's own stops aren't a double-booking
        if (a.start < b.end && b.start < a.end) {
          ids.add(a.loadId)
          ids.add(b.loadId)
        }
      }
    }
  }

  return ids
}

export function useConflictDetection(loads: Load[], drivers: Driver[]): Set<string> {
  const multiStopRender = useAppStore((s) => s.multiStopRender)
  const conflictIds = useMemo(
    () => (multiStopRender ? detectConflictsByStop(loads) : detectConflicts(loads)),
    [loads, multiStopRender],
  )
  const prevRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const prev = prevRef.current
    const newIds = [...conflictIds].filter((id) => !prev.has(id))

    if (newIds.length > 0) {
      // Group new conflicts by driver
      const byDriver = new Map<string, { name: string; count: number }>()
      for (const loadId of newIds) {
        const load = loads.find((l) => l.id === loadId)
        if (!load?.pickupDriverId) continue
        const driver = drivers.find((d) => d.id === load.pickupDriverId)
        const key = load.pickupDriverId
        if (!byDriver.has(key)) byDriver.set(key, { name: driver?.name ?? 'Unknown driver', count: 0 })
        byDriver.get(key)!.count++
      }
      for (const { name, count } of byDriver.values()) {
        const loadCount = Math.ceil(count / 2)
        toast.warning(`${name} has ${loadCount} scheduling conflict${loadCount > 1 ? 's' : ''}`, {
          duration: 6000,
        })
      }
    }

    prevRef.current = conflictIds
  }, [conflictIds, loads, drivers])

  return conflictIds
}
