import { describe, it, expect } from 'vitest'
import type { Load, Stop } from '@/types'
import { detectConflictsByStop } from './useConflictDetection'

function mkLoad(id: string, stops: Stop[], over: Partial<Load> = {}): Load {
  return {
    id, aljexId: id, tmsId: id, pickupNumber: id,
    pickupAppt: stops[0].appt, pickupApptType: 'exact',
    deliveryAppt: stops[stops.length - 1].appt, deliveryApptType: 'exact',
    originName: '', originCity: '', destinationName: '', destinationCity: '',
    pickupDriverId: stops[0].driverId, deliveryDriverId: stops[stops.length - 1].driverId,
    readyToInvoice: false, createdAt: '', updatedAt: '', createdBy: 'x', updatedBy: 'x',
    stops, ...over,
  }
}

const stop = (over: Partial<Stop>): Stop => ({
  id: 'sx', type: 'pickup', appt: '2026-06-15T10:00:00Z', apptType: 'range', driverId: 'd1', sequence: 0, ...over,
})

describe('detectConflictsByStop', () => {
  it('flags two different loads whose stop windows overlap on the same driver + day', () => {
    const a = mkLoad('A', [stop({ id: 'a0', appt: '2026-06-15T10:00:00Z', apptEnd: '2026-06-15T12:00:00Z', driverId: 'd1' })])
    const b = mkLoad('B', [stop({ id: 'b0', appt: '2026-06-15T11:00:00Z', apptEnd: '2026-06-15T13:00:00Z', driverId: 'd1' })])
    expect([...detectConflictsByStop([a, b])].sort()).toEqual(['A', 'B'])
  })

  it('catches a DELIVERY-day double-book the legacy pickup-day model misses', () => {
    // Load A delivers 6/16 with driver d9; Load B picks up 6/16 with d9, overlapping windows.
    const a = mkLoad('A', [
      stop({ id: 'a0', type: 'pickup',   appt: '2026-06-15T08:00:00Z', apptEnd: '2026-06-15T09:00:00Z', driverId: 'd1' }),
      stop({ id: 'a1', type: 'delivery', appt: '2026-06-16T14:00:00Z', apptEnd: '2026-06-16T16:00:00Z', driverId: 'd9', sequence: 1 }),
    ])
    const b = mkLoad('B', [
      stop({ id: 'b0', type: 'pickup',   appt: '2026-06-16T15:00:00Z', apptEnd: '2026-06-16T17:00:00Z', driverId: 'd9' }),
      stop({ id: 'b1', type: 'delivery', appt: '2026-06-17T09:00:00Z', apptEnd: '2026-06-17T10:00:00Z', driverId: 'd1', sequence: 1 }),
    ])
    expect([...detectConflictsByStop([a, b])].sort()).toEqual(['A', 'B'])
  })

  it('does NOT flag a load against its own stops', () => {
    const a = mkLoad('A', [
      stop({ id: 'a0', type: 'pickup',   appt: '2026-06-15T10:00:00Z', apptEnd: '2026-06-15T18:00:00Z', driverId: 'd1' }),
      stop({ id: 'a1', type: 'delivery', appt: '2026-06-15T12:00:00Z', apptEnd: '2026-06-15T14:00:00Z', driverId: 'd1', sequence: 1 }),
    ])
    expect(detectConflictsByStop([a]).size).toBe(0)
  })

  it('does not flag non-overlapping windows or different drivers', () => {
    const a = mkLoad('A', [stop({ id: 'a0', appt: '2026-06-15T08:00:00Z', apptEnd: '2026-06-15T09:00:00Z', driverId: 'd1' })])
    const b = mkLoad('B', [stop({ id: 'b0', appt: '2026-06-15T10:00:00Z', apptEnd: '2026-06-15T11:00:00Z', driverId: 'd1' })]) // after A
    const c = mkLoad('C', [stop({ id: 'c0', appt: '2026-06-15T08:00:00Z', apptEnd: '2026-06-15T09:00:00Z', driverId: 'd2' })]) // other driver
    expect(detectConflictsByStop([a, b, c]).size).toBe(0)
  })
})
