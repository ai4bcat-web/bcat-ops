import { describe, it, expect } from 'vitest'
import { matchLocation, newLocationItem, normalizeAddress } from './locationFromStop'

const stop = { name: "Batory's Oakley", city: 'Chicago, IL', address: { street: '1234 S Oakley Ave.', city: 'Chicago', state: 'IL', zip: '60608' } }
const loc = (over: Record<string, unknown>) => ({ id: 'loc-1', name: 'Other', active: true, ...over })

describe('matchLocation', () => {
  it('reuses the record at the same street address however it is punctuated', () => {
    const existing = loc({ id: 'dock', name: 'Batory Foods Chicago', street: '1234 s oakley ave', city: 'CHICAGO', state: 'IL', zip: '60608' })
    expect(matchLocation(stop, [loc({ id: 'x', street: '9 Elm', city: 'Joliet' }), existing])?.id).toBe('dock')
  })
  it('matches on the stored normalizedAddress key staff-made records carry', () => {
    const key = normalizeAddress({ street: '1234 S Oakley Ave.', city: 'Chicago', state: 'IL', zip: '60608', country: 'US' })
    expect(matchLocation(stop, [loc({ id: 'k', normalizedAddress: key })])?.id).toBe('k')
  })
  it('ignores archived and merged-away records', () => {
    const key = normalizeAddress({ street: '1234 S Oakley Ave.', city: 'Chicago', state: 'IL', zip: '60608', country: 'US' })
    expect(matchLocation(stop, [loc({ normalizedAddress: key, active: false }), loc({ id: 'm', normalizedAddress: key, mergedIntoId: 'z' })])).toBeNull()
  })
  it('falls back to the same facility name in the same city for a stop with no street', () => {
    const bare = { name: 'Eagle Foods LLC', city: 'Gary, IN', address: { city: 'Gary', state: 'IN' } }
    expect(matchLocation(bare, [loc({ id: 'e', name: 'EAGLE FOODS', city: 'Gary' })])?.id).toBe('e')
    expect(matchLocation(bare, [loc({ id: 'e', name: 'EAGLE FOODS', city: 'Hammond' })])).toBeNull()
  })
  it('finds nothing for a stop with neither a name nor a street', () => {
    expect(matchLocation({ city: 'Gary, IN' }, [loc({})])).toBeNull()
  })
})

describe('newLocationItem', () => {
  it('builds the directory row from the stop, with the keys the directory dedupes on', () => {
    const item = newLocationItem(stop, 'new-1', '2026-11-06T12:00:00Z', 'driver@x.com')!
    expect(item).toMatchObject({ id: 'new-1', name: "Batory's Oakley", street: '1234 S Oakley Ave.', city: 'Chicago', state: 'IL', zip: '60608', country: 'US', active: true, normalizedAddress: '1234 s oakley ave chicago il 60608 us' })
  })
  it('omits normalizedAddress (a GSI key) when the stop has no address, and refuses a nameless stop', () => {
    expect(newLocationItem({ name: 'Yard' }, 'n', 't', 'u')).not.toHaveProperty('normalizedAddress')
    expect(newLocationItem({ address: { street: '1 Main' } }, 'n', 't', 'u')).toBeNull()
  })
})
