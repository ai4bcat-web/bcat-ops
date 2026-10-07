// @vitest-environment jsdom
/**
 * The Appts to Book card counts BATORY stops and nothing else.
 *
 * Every other customer's appointments arrive already booked on the rate confirmation, so
 * counting them produced a number nobody could act on — and a number nobody acts on is a
 * card people learn to skip past.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { fromDateInput, fromDateTimeInput } from '@/lib/date'
import type { Load, Stop } from '@/types'

let state: { loads: Load[]; drivers: unknown[] } = { loads: [], drivers: [] }
vi.mock('@/store/useAppStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel(state),
}))

const { useDashboardMetrics } = await import('./useDashboardMetrics')

const stop = (over: Partial<Stop> = {}): Stop => ({
  id: 's', type: 'pickup', appt: fromDateTimeInput('2099-01-01T08:00'),
  apptType: 'exact', driverId: 'd1', sequence: 0, ...over,
} as Stop)

/** A load with one stop still to book — the shape the ladder cares about. */
const unbooked = (over: Partial<Load> = {}): Load => ({
  id: 'l1', aljexId: '1', readyToInvoice: false,
  stops: [
    stop({ id: 'p', type: 'pickup', apptType: 'tbd', appt: fromDateInput('2099-01-01') }),
    stop({ id: 'd', type: 'delivery', sequence: 1, appt: fromDateTimeInput('2099-01-02T14:00') }),
  ],
  ...over,
} as Load)

const metrics = () => renderHook(() => useDashboardMetrics('this-month')).result.current

beforeEach(() => { state = { loads: [], drivers: [] } })

describe('needsAppt — Batory only', () => {
  it('counts a Batory load with a stop still to book', () => {
    state.loads = [unbooked({ id: 'l1', customer: 'BATORY FOODS INC' })]
    expect(metrics().needsAppt).toBe(1)
  })

  it('ignores another customer with exactly the same unbooked stop', () => {
    state.loads = [unbooked({ id: 'l2', customer: 'Axle Logistics, LLC' })]
    expect(metrics().needsAppt).toBe(0)
  })

  it('counts only the Batory half of a mixed board', () => {
    state.loads = [
      unbooked({ id: 'l1', customer: 'BATORY FOODS INC' }),
      unbooked({ id: 'l2', customer: 'Axle Logistics, LLC' }),
      unbooked({ id: 'l3', customer: 'Batory' }),
    ]
    expect(metrics().needsAppt).toBe(2)
  })

  it('recognises Batory from the linked customer record, not only the typed name', () => {
    state.loads = [unbooked({ id: 'l1', customer: 'BF Inc', customerApptWorkflow: 'BATORY' })]
    expect(metrics().needsAppt).toBe(1)
  })

  it('still counts a Batory load whose times are set but not CONFIRMED', () => {
    /*
     * A time on the stop is not the end of the Batory ladder — it is confirmed when the
     * E2Open update and the confirmation email are both on file. Counting a merely-typed
     * time as booked is what would let an unconfirmed appointment leave the card and
     * surprise somebody at the dock.
     */
    state.loads = [{
      id: 'l1', aljexId: '1', readyToInvoice: false, customer: 'BATORY FOODS INC',
      stops: [
        stop({ id: 'p', type: 'pickup' }),
        stop({ id: 'd', type: 'delivery', sequence: 1, appt: fromDateTimeInput('2099-01-02T14:00') }),
      ],
    } as Load]
    expect(metrics().needsAppt).toBe(1)
  })

  it('clears once both ends are confirmed', () => {
    state.loads = [{
      id: 'l1', aljexId: '1', readyToInvoice: false, customer: 'BATORY FOODS INC',
      stops: [
        stop({ id: 'p', type: 'pickup', apptStatus: 'confirmed' }),
        stop({ id: 'd', type: 'delivery', sequence: 1, apptStatus: 'confirmed',
               appt: fromDateTimeInput('2099-01-02T14:00') }),
      ],
    } as Load]
    expect(metrics().needsAppt).toBe(0)
  })
})

describe('loadsSplit — always adds to totalLoads', () => {
  it('reconciles even when loads have no rate', () => {
    state.loads = [
      unbooked({ id: 'l1', customer: 'A', pickupDriverId: 'd1', rate: null } as Partial<Load>),
      unbooked({ id: 'l2', customer: 'B', pickupDriverId: null, rate: 50000 } as Partial<Load>),
    ]
    const m = metrics()
    expect(m.loadsSplit.total).toBe(m.totalLoads)
    expect(m.loadsSplit.byBucket.reduce((n, b) => n + b.loads, 0)).toBe(m.totalLoads)
  })
})
