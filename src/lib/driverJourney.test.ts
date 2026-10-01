import { describe, it, expect } from 'vitest'
import {
  canTransition,
  nextStatuses,
  transitionError,
  driverIsOnLoad,
  currentLoadForDriver,
  currentLoadByDriver,
  laneLabel,
  fixAge,
  STALE_FIX_MINUTES,
} from './driverJourney'
import type { Load } from '@/types'

const DRIVER = 'drv-roy'
const OTHER = 'drv-other'

/** Minimal Load with the fields the journey logic actually reads. */
function load(over: Partial<Load> = {}): Load {
  return {
    id: 'ld-1',
    aljexId: '13364',
    tmsId: 'N/A',
    pickupNumber: 'N/A',
    originCity: 'Mesa',
    destinationCity: 'Tempe',
    pickupAppt: '2026-10-01T11:30:00.000Z',
    deliveryAppt: '2026-10-02T02:15:00.000Z',
    readyToInvoice: false,
    stops: [
      { id: 's1', type: 'pickup', sequence: 0, driverId: DRIVER, appt: '2026-10-01T11:30:00.000Z' },
      { id: 's2', type: 'delivery', sequence: 1, driverId: DRIVER, appt: '2026-10-02T02:15:00.000Z' },
    ],
    ...over,
  } as unknown as Load
}

describe('status transitions', () => {
  it('walks the normal progression', () => {
    expect(canTransition(null, 'EN_ROUTE')).toBe(true) // null defaults to ASSIGNED
    expect(canTransition('EN_ROUTE', 'ON_SITE')).toBe(true)
    expect(canTransition('ON_SITE', 'DELIVERED')).toBe(true)
  })

  it('allows on site back to en route for the run to the delivery', () => {
    expect(canTransition('ON_SITE', 'EN_ROUTE')).toBe(true)
  })

  it('treats delivered as terminal', () => {
    expect(canTransition('DELIVERED', 'EN_ROUTE')).toBe(false)
    expect(nextStatuses('DELIVERED')).toEqual([])
    expect(transitionError('DELIVERED', 'ON_SITE')).toBe('This load is already delivered')
  })

  it('refuses skipping a step', () => {
    expect(canTransition('ASSIGNED', 'DELIVERED')).toBe(false)
    expect(transitionError('ASSIGNED', 'DELIVERED')).toContain('Cannot go from not started')
  })

  it('names a repeated move rather than failing silently', () => {
    expect(transitionError('ON_SITE', 'ON_SITE')).toBe('Already marked on site')
  })
})

describe('whose load is it', () => {
  it('matches a driver on any stop', () => {
    expect(driverIsOnLoad(load(), DRIVER)).toBe(true)
    expect(driverIsOnLoad(load(), OTHER)).toBe(false)
  })

  it('falls back to the mirrored fields on a legacy load with no stops', () => {
    const legacy = load({ stops: undefined, pickupDriverId: DRIVER } as Partial<Load>)
    expect(driverIsOnLoad(legacy, DRIVER)).toBe(true)
  })

  it('ignores an empty driver id rather than matching every load', () => {
    expect(driverIsOnLoad(load(), '')).toBe(false)
  })
})

describe('current load', () => {
  it('picks the soonest appointment among open loads', () => {
    const soon = load({ id: 'ld-soon', pickupAppt: '2026-10-01T06:00:00.000Z',
      stops: [{ id: 'a', type: 'pickup', sequence: 0, driverId: DRIVER, appt: '2026-10-01T06:00:00.000Z' }] } as Partial<Load>)
    const later = load({ id: 'ld-later' })
    expect(currentLoadForDriver([later, soon], DRIVER)?.id).toBe('ld-soon')
  })

  it('skips delivered loads', () => {
    const done = load({ id: 'ld-done', driverStatus: 'DELIVERED' } as Partial<Load>)
    expect(currentLoadForDriver([done], DRIVER)).toBeNull()
  })

  it('returns null when the driver has nothing open', () => {
    expect(currentLoadForDriver([load()], OTHER)).toBeNull()
  })

  it('maps many drivers at once for the dashboard', () => {
    const mine = load({ id: 'ld-mine' })
    const theirs = load({ id: 'ld-theirs',
      stops: [{ id: 'b', type: 'pickup', sequence: 0, driverId: OTHER, appt: '2026-10-01T09:00:00.000Z' }] } as Partial<Load>)
    const map = currentLoadByDriver([mine, theirs], [DRIVER, OTHER])
    expect(map.get(DRIVER)?.id).toBe('ld-mine')
    expect(map.get(OTHER)?.id).toBe('ld-theirs')
  })
})

describe('display helpers', () => {
  it('renders the lane, and degrades when half is missing', () => {
    expect(laneLabel(load())).toBe('Mesa → Tempe')
    expect(laneLabel(load({ destinationCity: '' } as Partial<Load>))).toBe('Mesa')
    expect(laneLabel(load({ originCity: '', destinationCity: '' } as Partial<Load>))).toBe('Lane unknown')
  })

  it('ages an ELD fix and flags the stale ones', () => {
    const now = Date.parse('2026-10-01T12:00:00.000Z')
    expect(fixAge('2026-10-01T11:56:00.000Z', now)).toMatchObject({ label: '4m ago', stale: false })
    expect(fixAge('2026-10-01T09:00:00.000Z', now)).toMatchObject({ label: '3h ago', stale: true })
    // Roy Workman's Unit 310 was showing a 25-hour-old Blue Ink fix as if live.
    expect(fixAge('2026-09-30T11:00:00.000Z', now)).toMatchObject({ label: '1d ago', stale: true })
    expect(fixAge(null, now)).toMatchObject({ label: 'no fix', stale: true })
  })

  it('puts the stale threshold just past an hour and a half', () => {
    const now = Date.parse('2026-10-01T12:00:00.000Z')
    const justUnder = new Date(now - (STALE_FIX_MINUTES - 1) * 60000).toISOString()
    expect(fixAge(justUnder, now).stale).toBe(false)
  })
})
