import { describe, it, expect } from 'vitest'
import { cityStateText, isRegionCode, parsePlaceText, stopPlace, stopsList, zip5 } from './stopPlace'

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

describe('loose "CITY, ST" text (Ryne 2026-11-16: "COCHRANE. WI" with no state)', () => {
  it('splits a period, a space or a squashed comma the same as a comma', () => {
    for (const text of ['COCHRANE. WI', 'COCHRANE WI', 'Cochrane,WI', 'COCHRANE , WI', 'COCHRANE; WI']) {
      expect(parsePlaceText(text)).toMatchObject({ city: expect.stringMatching(/^cochrane$/i), state: 'WI', zip: null })
    }
    expect(parsePlaceText('COCHRANE. WI 54622')).toEqual({ city: 'COCHRANE', state: 'WI', zip: '54622' })
    expect(parsePlaceText('Cochrane WI 54622-1234')).toEqual({ city: 'Cochrane', state: 'WI', zip: '54622' })
  })

  it('never cuts a city name that is not followed by a real state', () => {
    for (const text of ['ST. LOUIS', 'FORT WAYNE', 'WEST ALLIS', 'MT. PLEASANT', 'CHICAGO', 'COVERT, MII']) {
      expect(parsePlaceText(text).state).toBeNull()
    }
    expect(parsePlaceText('ST. LOUIS MO')).toEqual({ city: 'ST. LOUIS', state: 'MO', zip: null })
    expect(parsePlaceText('FORT WAYNE IN')).toEqual({ city: 'FORT WAYNE', state: 'IN', zip: null })
    expect(parsePlaceText('NEW YORK NY 10001')).toEqual({ city: 'NEW YORK', state: 'NY', zip: '10001' })
  })

  it('stopPlace reads the state out of the address city and out of the display text', () => {
    expect(stopPlace({ city: 'COCHRANE. WI', address: { street: '1 Mill Rd', city: '', state: '', zip: '' } })).toMatchObject({ city: 'COCHRANE', state: 'WI' })
    expect(stopPlace({ city: '', address: { city: 'COCHRANE. WI', state: null, zip: null } })).toMatchObject({ city: 'COCHRANE', state: 'WI' })
    // A real state field still wins.
    expect(stopPlace({ city: 'COCHRANE, WI', address: { city: 'COCHRANE', state: 'MN', zip: '54622' } })).toMatchObject({ state: 'MN' })
  })

  it('knows US states, territories and Canadian provinces, and writes "CITY, ST"', () => {
    for (const ok of ['WI', 'DC', 'PR', 'ON']) expect(isRegionCode(ok)).toBe(true)
    for (const no of ['XX', 'MII', '']) expect(isRegionCode(no)).toBe(false)
    expect(cityStateText('COCHRANE. WI', null)).toBe('COCHRANE, WI')
    expect(cityStateText('COCHRANE', 'wi')).toBe('COCHRANE, WI')
    expect(cityStateText('', '')).toBe('')
  })
})

describe('stopsList', () => {
  const stops = [{ id: 'pu', type: 'pickup', sequence: 0, address: { city: 'BURLINGTON', state: 'WI', zip: '53105' } }]
  it('reads a list, a JSON string, and a double-encoded string the same (Aljex-imported rows)', () => {
    expect(stopsList(stops)).toEqual(stops)
    expect(stopsList(JSON.stringify(stops))).toEqual(stops)
    expect(stopsList(JSON.stringify(JSON.stringify(stops)))).toEqual(stops)
  })
  it('reads garbage as no stops', () => {
    expect(stopsList('not json')).toEqual([])
    expect(stopsList(null)).toEqual([])
    expect(stopsList({})).toEqual([])
  })
})
