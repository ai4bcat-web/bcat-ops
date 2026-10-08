import { describe, it, expect } from 'vitest'
import { eldRunsOutsideRadius, driverOfRun } from './eldMonitor'
import type { Load } from '../types'

const NOW = new Date('2026-10-08T18:00:00Z')
const load = (over: Partial<Load>): Load => ({
  id: 'L', aljexId: '1', tmsId: '', pickupNumber: '', pickupAppt: '2026-10-07T13:00:00.000Z', deliveryAppt: '2026-10-07T20:00:00.000Z',
  pickupDriverId: null, deliveryDriverId: null, readyToInvoice: false, createdBy: '', updatedBy: '', createdAt: '', updatedAt: '',
  ...over,
} as unknown as Load)

describe('eldRunsOutsideRadius', () => {
  it('lists a run that left the radius, with who drove it, and leaves a local one out', () => {
    const rows = eldRunsOutsideRadius([
      load({ id: 'far', aljexId: '14570', originCity: 'Chicago, IL', destinationCity: 'Indianapolis, IN', deliveryDriverId: 'drv-jason' }),
      load({ id: 'near', aljexId: '14571', originCity: 'Chicago, IL', destinationCity: 'Waukegan, IL', deliveryDriverId: 'drv-jason' }),
    ], { sinceDays: 30, now: NOW })
    expect(rows.map((r) => r.load.id)).toEqual(['far'])
    expect(rows[0]).toMatchObject({ status: 'REQUIRED', driverId: 'drv-jason', day: '2026-10-07', reviewed: null })
    expect(rows[0].farthestMiles).toBeGreaterThan(150)
  })

  it('flags a run whose stop could not be placed as one to check', () => {
    const rows = eldRunsOutsideRadius([
      load({ id: 'x', originCity: 'Chicago, IL', destinationCity: 'CTSI WAREHOUSE' }),
    ], { sinceDays: 30, now: NOW })
    expect(rows[0]).toMatchObject({ status: 'UNKNOWN', unplaceable: ['CTSI WAREHOUSE'] })
  })

  it('keeps to the window, newest first, and carries the review', () => {
    const rows = eldRunsOutsideRadius([
      load({ id: 'old', originCity: 'Chicago, IL', destinationCity: 'Indianapolis, IN', pickupAppt: '2026-08-01T13:00:00.000Z', deliveryAppt: '2026-08-01T20:00:00.000Z' }),
      load({ id: 'a', originCity: 'Chicago, IL', destinationCity: 'Indianapolis, IN', pickupAppt: '2026-10-01T13:00:00.000Z', deliveryAppt: '2026-10-01T20:00:00.000Z', eldLogsReviewedAt: '2026-10-02T10:00:00Z', eldLogsReviewedBy: 'fleet@bcatcorp.com' }),
      load({ id: 'b', originCity: 'Chicago, IL', destinationCity: 'Indianapolis, IN', deliveryAppt: '2026-10-07T20:00:00.000Z' }),
    ], { sinceDays: 30, now: NOW })
    expect(rows.map((r) => r.load.id)).toEqual(['b', 'a'])
    expect(rows[1].reviewed).toEqual({ at: '2026-10-02T10:00:00Z', by: 'fleet@bcatcorp.com' })
  })

  it('reads the driver off the stops before the legacy fields', () => {
    const l = load({ stops: [
      { id: 'p', type: 'pickup', sequence: 0, appt: '2026-10-07T13:00:00.000Z', driverId: 'drv-a' },
      { id: 'd', type: 'delivery', sequence: 1, appt: '2026-10-07T20:00:00.000Z', driverId: 'drv-b' },
    ], pickupDriverId: 'drv-z' } as Partial<Load>)
    expect(driverOfRun(l)).toBe('drv-b')
  })
})
