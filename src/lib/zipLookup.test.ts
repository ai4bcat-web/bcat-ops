import { describe, expect, it } from 'vitest'
import { cityKey, lookupZip, searchCities, usZip5, zipFill } from './zipLookup'

describe('zipLookup', () => {
  it('finds city and state for a real US zip, including a run boundary and ZIP+4', async () => {
    expect(await lookupZip('60435')).toEqual({ city: 'Joliet', state: 'IL' })
    expect(await lookupZip(' 10001-1234 ')).toMatchObject({ state: 'NY' })
    expect(await lookupZip('90210')).toMatchObject({ state: 'CA' })
  })

  it('ignores short, non-numeric, non-US and unassigned zips without throwing', async () => {
    for (const z of ['6043', '', '  ', 'K1A 0B1', 'ABCDE', '604355', null, undefined, '00000']) {
      expect(await lookupZip(z as string | null)).toBeNull()
    }
    expect(usZip5('60435')).toBe('60435')
    expect(usZip5('6043')).toBeNull()
  })

  it('fills only blank fields and never overwrites typed text', () => {
    const found = { city: 'Joliet', state: 'IL' }
    expect(zipFill({ city: '', state: '' }, found)).toEqual({ city: 'Joliet', state: 'IL' })
    expect(zipFill({ city: 'Plainfield', state: '' }, found)).toEqual({ state: 'IL' })
    expect(zipFill({ city: 'Plainfield', state: 'WI' }, found)).toEqual({})
    expect(zipFill({ city: '  ', state: null }, found)).toEqual({ city: 'Joliet', state: 'IL' })
  })

  it('reads a ZIP+4 with or without its dash', async () => {
    expect(usZip5('60435-1234')).toBe('60435')
    expect(usZip5('604351234')).toBe('60435')
    expect(usZip5('6043512')).toBeNull()
    expect(await lookupZip('604351234')).toEqual({ city: 'Joliet', state: 'IL' })
  })
})

describe('searchCities', () => {
  it('suggests places for a typed start of a city, with a state and a ZIP', async () => {
    const hits = await searchCities('Cochr')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.find((h) => h.city === 'Cochrane' && h.state === 'WI')).toMatchObject({ zip: '54622' })
  })

  it('narrows to the state typed after the city or passed in', async () => {
    const typed = await searchCities('Cochrane, WI')
    expect(typed.every((h) => h.state === 'WI')).toBe(true)
    const narrowed = await searchCities('Springfield', { state: 'MO' })
    expect(narrowed.length).toBeGreaterThan(0)
    expect(narrowed.every((h) => h.state === 'MO')).toBe(true)
  })

  it('lists the ZIPs of a city typed in full, lowest first, so the person picks theirs', async () => {
    const hits = await searchCities('Chicago', { state: 'IL', limit: 5 })
    expect(hits).toHaveLength(5)
    expect(hits.every((h) => h.city === 'Chicago' && h.state === 'IL' && h.zipCount > 5)).toBe(true)
    expect(hits[0].zip).toBe('60601')
    expect([...hits].map((h) => h.zip)).toEqual([...hits].map((h) => h.zip).sort())
  })

  it('treats St / Saint, Ft / Fort and punctuation as the same spelling', async () => {
    expect(cityKey("St. Charles")).toBe(cityKey('Saint Charles'))
    const hits = await searchCities('St Charles', { state: 'IL' })
    expect(hits.some((h) => /charles/i.test(h.city) && h.state === 'IL')).toBe(true)
  })

  it('offers nothing for fewer than two letters, and never throws', async () => {
    expect(await searchCities('')).toEqual([])
    expect(await searchCities('c')).toEqual([])
    expect(await searchCities(null)).toEqual([])
    expect(await searchCities('Zzzzzzzz')).toEqual([])
  })
})
