import { describe, expect, it } from 'vitest'
import { sectionOf, splitIntoSections } from './fleetSections'

const drivers = [
  { id: 'iv', name: 'Charles Best', type: 'driver' },
  { id: 'oo', name: 'Zak Pace', type: 'driver', fleetGroup: 'OWNER_OPERATOR' },
  { id: 'bk', name: 'BROKER NEED TO COVER', type: 'broker' },
] as never
const row = (id: string, driverId: string | null, role: 'pickup' | 'delivery' | 'same-day' = 'same-day') =>
  ({ load: { id, pickupDriverId: driverId, deliveryDriverId: driverId }, role }) as never

describe('calendar fleet sections', () => {
  it('puts Ivan drivers, owner operators and nobody / the placeholder rows in their own sections, in that order', () => {
    const rows = [row('a', 'oo'), row('b', null), row('c', 'iv'), row('d', 'bk'), row('e', 'iv')]
    const out = splitIntoSections(rows, drivers)
    expect(out.map((s) => s.key)).toEqual(['IVAN', 'OWNER_OP', 'UNASSIGNED'])
    expect(out[0]!.entries.map((e: { load: { id: string } }) => e.load.id)).toEqual(['c', 'e'])
    expect(out[2]!.entries.map((e: { load: { id: string } }) => e.load.id)).toEqual(['b', 'd'])
  })

  it('leaves an empty section out', () => {
    expect(splitIntoSections([row('a', 'iv')], drivers).map((s) => s.key)).toEqual(['IVAN'])
  })

  it('reads a delivery row by its delivery driver and a stop row by its stop driver', () => {
    const split = { load: { id: 'x', pickupDriverId: 'iv', deliveryDriverId: 'oo' }, role: 'delivery' } as never
    expect(sectionOf(split, drivers)).toBe('OWNER_OP')
    const stopRow = { load: { id: 'y', pickupDriverId: 'iv', deliveryDriverId: 'iv' }, role: 'pickup', stop: { driverId: 'oo' } } as never
    expect(sectionOf(stopRow, drivers)).toBe('OWNER_OP')
  })
})
