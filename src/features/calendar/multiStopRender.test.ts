import { describe, it, expect } from 'vitest'
import type { Load, Stop } from '@/types'
import { getStops, updateStop, withDerivedLegacy, flattenLoadsToStopEntries } from '@/lib/stops'
import { chicagoDateStr } from '@/lib/date'

// ── Validation for Phase 2 per-stop calendar rendering ──────────────────────────
//
// The four calendar views all build their per-stop entries from the same exported
// helpers and write edits/drags back through `updateStop` → `updateLoad`, where the
// store applies `withDerivedLegacy`. These tests pin the behaviors those views
// depend on (placement, mirror re-derivation, per-leg pairing, split detection, and
// the no-appt guard) without needing a DOM or a backend.

function mkLoad(over: Partial<Load> = {}): Load {
  return {
    id: 'load-1', aljexId: 'A-1', tmsId: 'T-1', pickupNumber: 'PU-1',
    pickupAppt: '2026-06-15T08:00:00Z', pickupApptType: 'exact',
    deliveryAppt: '2026-06-17T09:00:00Z', deliveryApptType: 'exact',
    originName: 'Shipper', originCity: 'Chicago, IL',
    destinationName: 'Consignee', destinationCity: 'Columbus, OH',
    pickupDriverId: 'drvA', deliveryDriverId: 'drvC',
    readyToInvoice: false,
    createdAt: '', updatedAt: '', createdBy: 'x', updatedBy: 'x',
    ...over,
  }
}

// A 4-stop load: 2 pickups (drvA), 2 deliveries (drvB, drvC) across three days.
const multiStops: Stop[] = [
  { id: 's0', type: 'pickup',   name: 'PU A', city: 'Chicago, IL',      appt: '2026-06-15T08:00:00Z', apptType: 'exact', driverId: 'drvA', sequence: 0 },
  { id: 's1', type: 'pickup',   name: 'PU B', city: 'Joliet, IL',       appt: '2026-06-15T11:00:00Z', apptType: 'exact', driverId: 'drvA', sequence: 1 },
  { id: 's2', type: 'delivery', name: 'DE C', city: 'Indianapolis, IN', appt: '2026-06-16T14:00:00Z', apptType: 'exact', driverId: 'drvB', sequence: 2 },
  { id: 's3', type: 'delivery', name: 'DE D', city: 'Columbus, OH',     appt: '2026-06-17T09:00:00Z', apptType: 'exact', driverId: 'drvC', sequence: 3 },
]

describe('per-stop flattening + day placement (Planner / Grid / Scheduler)', () => {
  it('emits one entry per stop with stable `loadId:stopId` keys', () => {
    const load = mkLoad({ stops: multiStops })
    const entries = flattenLoadsToStopEntries([load])
    expect(entries.map((e) => e.key)).toEqual(['load-1:s0', 'load-1:s1', 'load-1:s2', 'load-1:s3'])
    expect(entries.map((e) => e.stop.driverId)).toEqual(['drvA', 'drvA', 'drvB', 'drvC'])
    expect(entries.map((e) => e.stop.type)).toEqual(['pickup', 'pickup', 'delivery', 'delivery'])
  })

  it('places each stop on its own Chicago appt day (the two PUs share a day; DEs split)', () => {
    const load = mkLoad({ stops: multiStops })
    const byDay = new Map<string, string[]>()
    for (const { stop, key } of flattenLoadsToStopEntries([load])) {
      const day = chicagoDateStr(stop.appt)!
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day)!.push(key)
    }
    expect(byDay.get('2026-06-15')).toEqual(['load-1:s0', 'load-1:s1'])
    expect(byDay.get('2026-06-16')).toEqual(['load-1:s2'])
    expect(byDay.get('2026-06-17')).toEqual(['load-1:s3'])
  })

  it('a legacy load (no stops array) still flattens to its 2 synthesized stops', () => {
    const entries = flattenLoadsToStopEntries([mkLoad()])
    expect(entries.map((e) => e.key)).toEqual(['load-1:load-1:pu', 'load-1:load-1:de'])
    expect(entries.map((e) => e.stop.driverId)).toEqual(['drvA', 'drvC'])
  })
})

describe('dragging / editing one stop re-derives the legacy mirrors (Scheduler / Grid drop, Planner edit)', () => {
  it('reassigning the FIRST pickup updates pickupDriverId only', () => {
    const load = mkLoad({ stops: multiStops })
    const patch = withDerivedLegacy({ stops: updateStop(load, 's0', { driverId: 'drvZ' }) })
    expect(patch.pickupDriverId).toBe('drvZ')   // first pickup → mirror
    expect(patch.deliveryDriverId).toBe('drvC') // last delivery unchanged
    expect(patch.pickupAppt).toBe('2026-06-15T08:00:00Z')
  })

  it('moving a MIDDLE stop leaves the first-pickup / last-delivery mirrors stable', () => {
    const load = mkLoad({ stops: multiStops })
    const patch = withDerivedLegacy({ stops: updateStop(load, 's1', { appt: '2026-06-15T20:00:00Z', driverId: 'drvX' }) })
    expect(patch.pickupAppt).toBe('2026-06-15T08:00:00Z')   // still s0
    expect(patch.pickupDriverId).toBe('drvA')
    expect(patch.deliveryAppt).toBe('2026-06-17T09:00:00Z') // still s3
    expect(patch.deliveryDriverId).toBe('drvC')
    // …but the moved stop itself is updated in the canonical array.
    const moved = patch.stops!.find((s) => s.id === 's1')!
    expect(moved).toMatchObject({ appt: '2026-06-15T20:00:00Z', driverId: 'drvX' })
  })

  it('moving the LAST delivery to a new day updates deliveryAppt mirror', () => {
    const load = mkLoad({ stops: multiStops })
    const patch = withDerivedLegacy({ stops: updateStop(load, 's3', { appt: '2026-06-18T09:00:00Z' }) })
    expect(patch.deliveryAppt).toBe('2026-06-18T09:00:00Z')
  })
})

describe('per-leg segments (CompactWeek)', () => {
  it('pairs consecutive stops into legs owned by the departing-stop driver', () => {
    const stops = getStops(mkLoad({ stops: multiStops }))
    const legs = stops.slice(0, -1).map((from, i) => ({ from, to: stops[i + 1], driverId: from.driverId }))
    expect(legs).toHaveLength(3)
    expect(legs.map((l) => [l.from.id, l.to.id])).toEqual([['s0', 's1'], ['s1', 's2'], ['s2', 's3']])
    expect(legs.map((l) => l.driverId)).toEqual(['drvA', 'drvA', 'drvB'])
  })
})

describe('split detection (Phase 3 Grid tab / EventCard)', () => {
  const distinctDrivers = (l: Load) => new Set(getStops(l).map((s) => s.driverId)).size

  it('flags a load with more than one distinct stop driver as split', () => {
    expect(distinctDrivers(mkLoad({ stops: multiStops })) > 1).toBe(true)
  })

  it('a single-driver multi-stop load is NOT split', () => {
    const oneDriver = multiStops.map((s) => ({ ...s, driverId: 'drvA' }))
    expect(distinctDrivers(mkLoad({ stops: oneDriver })) > 1).toBe(false)
  })
})

describe('TBD / no-appt stop guard (Scheduler timeline)', () => {
  // Replicates the SchedulerView events filter: a stop with no firm appt is skipped
  // rather than crashing on `new Date('').toISOString()`.
  const placeable = (s: Stop) => !!s.appt && !isNaN(new Date(s.appt).getTime())

  it('excludes a stop with an empty appt from timeline placement', () => {
    const tbd: Stop = { id: 'sx', type: 'delivery', appt: '', apptType: 'tbd', driverId: 'drvB', sequence: 2 }
    expect(placeable(tbd)).toBe(false)
    expect(chicagoDateStr(tbd.appt)).toBeFalsy()
  })

  it('keeps stops with a real appt', () => {
    expect(placeable(multiStops[0])).toBe(true)
  })
})
