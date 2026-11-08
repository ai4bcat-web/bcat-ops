import { describe, it, expect } from 'vitest'
import { aliasMap } from './postalAliases'

describe('aliasMap', () => {
  it('keys on the five-digit ZIP, accepting ZIP+4', () => {
    const map = aliasMap([
      { zip: '60106', city: 'Chicago', state: 'IL' },
      { zip: '46201-1234', city: 'Indianapolis', state: 'IN' },
    ])
    expect(map['60106']).toEqual({ city: 'Chicago', state: 'IL' })
    expect(map['46201']).toEqual({ city: 'Indianapolis', state: 'IN' })
  })

  it('drops a row it could not apply rather than applying half of it', () => {
    const map = aliasMap([
      { zip: 'ABCDE', city: 'Nowhere', state: 'IL' },
      { zip: '60106', city: '', state: 'IL' },
      { zip: '46201', city: 'Indianapolis', state: 'Indiana' },
    ])
    expect(map).toEqual({})
  })

  it('lets a later correction win and tolerates nothing at all', () => {
    const map = aliasMap([
      { zip: '60106', city: 'Chicago', state: 'IL' },
      { zip: '60106', city: 'Bensenville', state: 'IL' },
    ])
    expect(map['60106']).toEqual({ city: 'Bensenville', state: 'IL' })
    expect(aliasMap(null)).toEqual({})
  })
})
