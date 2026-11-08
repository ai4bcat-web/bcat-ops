import { describe, expect, it } from 'vitest'
import { lookupZip, usZip5, zipFill } from './zipLookup'

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
})
