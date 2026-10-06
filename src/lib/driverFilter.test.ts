import { describe, it, expect } from 'vitest'
import {
  driverGroupOf,
  selectableDrivers,
  driversInGroup,
  defaultVisibleDriverIds,
  loadDriverIds,
  loadVisibleForDrivers,
  driverFilterSummary,
  allSelectableDriverIds,
  DRIVER_GROUP_LABEL,
  type FilterableDriver,
} from './driverFilter'
import type { Load } from '@/types'

const driver = (over: Partial<FilterableDriver> = {}): FilterableDriver => ({
  id: 'd1', name: 'Ivan Driver', active: true, ...over,
} as FilterableDriver)

const IVAN = driver({ id: 'ivan-1', name: 'Alvaro', fleetGroup: 'LOCAL' })
const BOX = driver({ id: 'ivan-2', name: 'Bruno', fleetGroup: 'BOX_TRUCK' })
const AMZ = driver({ id: 'oo-1', name: 'Chad', fleetGroup: 'AMAZON' })
const OO = driver({ id: 'oo-2', name: 'Dina', driverType: 'OWNER_OPERATOR' })
const BROKER = driver({ id: 'bk-1', name: 'BROKER COVERED', type: 'broker' })
const GONE = driver({ id: 'x-1', name: 'Zed', active: false, fleetGroup: 'LOCAL' })

const ALL = [OO, BROKER, AMZ, BOX, GONE, IVAN]

function load(over: Partial<Load> = {}): Load {
  return {
    id: 'ld-1',
    pickupAppt: '2026-10-01T11:30:00.000Z',
    deliveryAppt: '2026-10-02T02:15:00.000Z',
    pickupDriverId: null,
    deliveryDriverId: null,
    ...over,
  } as unknown as Load
}

const visible = (...ids: string[]) => new Set(ids)

describe('driverGroupOf', () => {
  it('reads the Amazon fleet as owner-operator', () => {
    expect(driverGroupOf(AMZ)).toBe('OWNER_OP')
  })

  it('reads an explicit owner-operator driverType too', () => {
    // The two fields are meant to agree; either one is enough to say so.
    expect(driverGroupOf(OO)).toBe('OWNER_OP')
  })

  it('treats local and box-truck drivers as Ivan drivers', () => {
    expect(driverGroupOf(IVAN)).toBe('IVAN')
    expect(driverGroupOf(BOX)).toBe('IVAN')
  })

  it('treats an unclassified driver as an Ivan driver', () => {
    // This is their dispatch board, so the unclassified default is to appear on it.
    expect(driverGroupOf(driver())).toBe('IVAN')
  })

  it('names both groups in words a dispatcher uses', () => {
    expect(DRIVER_GROUP_LABEL.IVAN).toBe('Ivan drivers')
    expect(DRIVER_GROUP_LABEL.OWNER_OP).toBe('Owner operators')
  })
})

describe('who is offered in the picker', () => {
  it('drops broker pseudo-drivers and inactive people, and sorts by name', () => {
    // BROKER COVERED carries loads but is nobody, so filtering to "their" work is a lie.
    expect(selectableDrivers(ALL).map((d) => d.name)).toEqual(['Alvaro', 'Bruno', 'Chad', 'Dina'])
  })

  it('splits the two groups', () => {
    expect(driversInGroup(ALL, 'IVAN').map((d) => d.id)).toEqual(['ivan-1', 'ivan-2'])
    expect(driversInGroup(ALL, 'OWNER_OP').map((d) => d.id)).toEqual(['oo-1', 'oo-2'])
  })
})

describe('the default selection', () => {
  it('shows Ivan drivers and hides owner operators', () => {
    expect(defaultVisibleDriverIds(ALL)).toEqual(['ivan-1', 'ivan-2'])
  })

  it('is empty rather than everything when there are no Ivan drivers', () => {
    // Defaulting to "all" here would quietly put every owner-operator load on the board.
    expect(defaultVisibleDriverIds([AMZ, OO])).toEqual([])
  })
})

describe('loadDriverIds', () => {
  it('collects every driver across the stops', () => {
    const l = load({
      stops: [
        { id: 's1', type: 'pickup', sequence: 0, driverId: 'ivan-1', appt: '2026-10-01T11:30:00.000Z' },
        { id: 's2', type: 'delivery', sequence: 1, driverId: 'oo-1', appt: '2026-10-02T02:15:00.000Z' },
      ],
    } as Partial<Load>)
    expect(loadDriverIds(l).sort()).toEqual(['ivan-1', 'oo-1'])
  })

  it('falls back to the mirrored fields on a legacy load with no stops', () => {
    expect(loadDriverIds(load({ pickupDriverId: 'ivan-1', deliveryDriverId: 'ivan-1' }))).toEqual(['ivan-1'])
  })

  it('returns nothing for a load with nobody on it', () => {
    expect(loadDriverIds(load())).toEqual([])
  })
})

describe('loadVisibleForDrivers', () => {
  const ivanLoad = load({ pickupDriverId: 'ivan-1', deliveryDriverId: 'ivan-1' })
  const ooLoad = load({ pickupDriverId: 'oo-1', deliveryDriverId: 'oo-1' })

  it('shows a load whose driver is selected', () => {
    expect(loadVisibleForDrivers(ivanLoad, visible('ivan-1'))).toBe(true)
  })

  it('hides a load whose driver is not', () => {
    expect(loadVisibleForDrivers(ooLoad, visible('ivan-1'))).toBe(false)
  })

  it('always shows an unassigned load, whatever is selected', () => {
    // It has no driver to filter by, and it is the work most needing attention — making
    // it vanish behind a driver filter would hide what someone opened the board to find.
    expect(loadVisibleForDrivers(load(), visible('ivan-1'))).toBe(true)
    expect(loadVisibleForDrivers(load(), visible())).toBe(true)
  })

  it('shows a split load when either driver is selected', () => {
    const split = load({ pickupDriverId: 'ivan-1', deliveryDriverId: 'oo-1' })
    expect(loadVisibleForDrivers(split, visible('ivan-1'))).toBe(true)
    expect(loadVisibleForDrivers(split, visible('oo-1'))).toBe(true)
    expect(loadVisibleForDrivers(split, visible('someone-else'))).toBe(false)
  })

  it('hides every assigned load when nothing is selected', () => {
    expect(loadVisibleForDrivers(ivanLoad, visible())).toBe(false)
  })
})

describe('driverFilterSummary', () => {
  it('names the default state rather than counting it', () => {
    expect(driverFilterSummary(ALL, visible('ivan-1', 'ivan-2'))).toBe('Ivan drivers')
  })

  it('says all drivers when everyone is shown', () => {
    expect(driverFilterSummary(ALL, visible('ivan-1', 'ivan-2', 'oo-1', 'oo-2'))).toBe('All drivers')
  })

  it('names a single driver', () => {
    expect(driverFilterSummary(ALL, visible('oo-1'))).toBe('Chad')
  })

  it('counts a mixed selection', () => {
    expect(driverFilterSummary(ALL, visible('ivan-1', 'oo-1', 'oo-2'))).toBe('3 drivers')
  })

  it('says plainly when nothing is selected', () => {
    // An empty board needs an explanation, not a count of zero.
    expect(driverFilterSummary(ALL, visible())).toBe('No drivers')
  })
})

describe('allSelectableDriverIds — the Loads page default', () => {
  it('includes BOTH fleets, because that page is the full record of the freight', () => {
    // The calendar opens on Ivan's drivers; the loads page must not, or it would quietly
    // omit every owner-operator load from the page people audit the month against.
    const ids = allSelectableDriverIds(ALL)
    expect(ids).toContain('ivan-1')
    expect(ids).toContain('oo-1')
    expect(ids).toContain('oo-2')
  })

  it('is a superset of the calendar default', () => {
    const all = new Set(allSelectableDriverIds(ALL))
    for (const id of defaultVisibleDriverIds(ALL)) expect(all.has(id)).toBe(true)
    expect(all.size).toBeGreaterThan(defaultVisibleDriverIds(ALL).length)
  })

  it('leaves out brokers and inactive people, same as the picker', () => {
    const ids = allSelectableDriverIds(ALL)
    expect(ids).not.toContain('bk-1')
    expect(ids).not.toContain('x-1')
  })
})
