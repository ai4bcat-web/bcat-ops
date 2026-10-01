import { describe, it, expect } from 'vitest'
import {
  driverIsOnLoad,
  currentLoadForDriver,
  currentLoadByDriver,
  recentLoadsForDriver,
  lastApptAt,
  laneLabel,
  fixAge,
  STALE_FIX_MINUTES,
  CURRENT_LOAD_GRACE_HOURS,
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

/** Just after the fixture load's delivery appointment. */
const NOW = Date.parse('2026-10-02T03:00:00.000Z')
const hoursAfter = (iso: string, h: number) => Date.parse(iso) + h * 60 * 60 * 1000

describe('current load', () => {
  it('picks the soonest appointment among open loads', () => {
    const soon = load({ id: 'ld-soon', pickupAppt: '2026-10-01T06:00:00.000Z',
      stops: [{ id: 'a', type: 'pickup', sequence: 0, driverId: DRIVER, appt: '2026-10-01T06:00:00.000Z' }] } as Partial<Load>)
    const later = load({ id: 'ld-later' })
    expect(currentLoadForDriver([later, soon], DRIVER, NOW)?.id).toBe('ld-soon')
  })

  it('keeps a load through the grace window after its last appointment', () => {
    // A delivery that ran late, or finished at midnight, is still the driver's load the
    // next morning when they come to send the POD.
    const at = hoursAfter('2026-10-02T02:15:00.000Z', CURRENT_LOAD_GRACE_HOURS - 1)
    expect(currentLoadForDriver([load()], DRIVER, at)?.id).toBe('ld-1')
  })

  it('drops a load once the grace window has passed', () => {
    // Driver-reported status used to end a load. The appointment does it now.
    const at = hoursAfter('2026-10-02T02:15:00.000Z', CURRENT_LOAD_GRACE_HOURS + 1)
    expect(currentLoadForDriver([load()], DRIVER, at)).toBeNull()
  })

  it('keeps a load with no appointment at all, because nothing says it is finished', () => {
    const undated = load({ id: 'ld-undated', pickupAppt: '', deliveryAppt: '',
      stops: [{ id: 'c', type: 'pickup', sequence: 0, driverId: DRIVER }] } as Partial<Load>)
    expect(currentLoadForDriver([undated], DRIVER, NOW)?.id).toBe('ld-undated')
  })

  it('returns null when the driver has nothing open', () => {
    expect(currentLoadForDriver([load()], OTHER, NOW)).toBeNull()
  })

  it('maps many drivers at once for the dashboard', () => {
    const mine = load({ id: 'ld-mine' })
    const theirs = load({ id: 'ld-theirs',
      stops: [{ id: 'b', type: 'pickup', sequence: 0, driverId: OTHER, appt: '2026-10-01T09:00:00.000Z' }] } as Partial<Load>)
    const map = currentLoadByDriver([mine, theirs], [DRIVER, OTHER], NOW)
    expect(map.get(DRIVER)?.id).toBe('ld-mine')
    expect(map.get(OTHER)?.id).toBe('ld-theirs')
  })
})

describe('recent loads, for attaching a POD', () => {
  it('offers loads the current-load window has already dropped', () => {
    // A POD photographed on Friday may only be attached on Monday, so the picker has to
    // reach further back than the card does.
    const at = hoursAfter('2026-10-02T02:15:00.000Z', CURRENT_LOAD_GRACE_HOURS + 48)
    expect(currentLoadForDriver([load()], DRIVER, at)).toBeNull()
    expect(recentLoadsForDriver([load()], DRIVER, at).map((l) => l.id)).toEqual(['ld-1'])
  })

  it('stops at the window, so the list never grows without bound', () => {
    const at = hoursAfter('2026-10-02T02:15:00.000Z', 31 * 24)
    expect(recentLoadsForDriver([load()], DRIVER, at)).toEqual([])
  })

  it('lists the newest load first', () => {
    const older = load({ id: 'ld-older', deliveryAppt: '2026-09-20T02:15:00.000Z',
      stops: [{ id: 'd', type: 'delivery', sequence: 0, driverId: DRIVER, appt: '2026-09-20T02:15:00.000Z' }] } as Partial<Load>)
    expect(recentLoadsForDriver([older, load()], DRIVER, NOW).map((l) => l.id)).toEqual(['ld-1', 'ld-older'])
  })

  it("never offers another driver's load", () => {
    expect(recentLoadsForDriver([load()], OTHER, NOW)).toEqual([])
  })
})

describe('lastApptAt', () => {
  it('takes the latest stop appointment', () => {
    expect(lastApptAt(load())).toBe('2026-10-02T02:15:00.000Z')
  })

  it("falls back to the load's own delivery appointment with no stops", () => {
    const legacy = load({ stops: undefined } as Partial<Load>)
    expect(lastApptAt(legacy)).toBe('2026-10-02T02:15:00.000Z')
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
