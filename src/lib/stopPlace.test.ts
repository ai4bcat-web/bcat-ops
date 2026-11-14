import { describe, it, expect } from 'vitest'
import { parsePlaceText, stopPlace, zip5 } from './stopPlace'

describe('stopPlace', () => {
  it("reads 20039's pickup the way the editor shows it: the stop's own address, no Location", () => {
    expect(stopPlace({
      name: 'APPLIED MATERIAL SOLUTIONS',
      city: 'BURLINGTON, WI',
      address: { street: '1956 S Pine St', city: 'BURLINGTON', state: 'WI', zip: '53105' },
    }, null)).toEqual({ name: 'APPLIED MATERIAL SOLUTIONS', street: '1956 S Pine St', city: 'BURLINGTON', state: 'WI', zip: '53105', country: null })
  })

  it("falls back field by field to the saved Location (20031: Location ZIP stored as 799285900)", () => {
    const p = stopPlace({ name: null, city: 'EL PASO, TX' }, { city: 'EL PASO', state: 'TX', zip: '799285900', address1: '13699 GATEWAY BLVD W' })
    expect(p).toMatchObject({ city: 'EL PASO', state: 'TX', zip: '79928', street: '13699 GATEWAY BLVD W' })
  })

  it('parses legacy "CITY, ST 12345" text last', () => {
    expect(stopPlace({ city: 'EL PASO, TX 79928-5900' })).toMatchObject({ city: 'EL PASO', state: 'TX', zip: '79928' })
    expect(parsePlaceText('Chicago')).toEqual({ city: 'Chicago', state: null, zip: null })
  })

  it('reads ZIP+4 with or without its dash, and ignores N/A', () => {
    expect(zip5('79928-5900')).toBe('79928')
    expect(zip5('799285900')).toBe('79928')
    expect(zip5('N/A')).toBeNull()
  })
})
