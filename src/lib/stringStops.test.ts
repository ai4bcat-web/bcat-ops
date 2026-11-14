import { describe, it, expect } from 'vitest'
import { getStops } from './stops'
import { ordered, placeOf } from './factorHandoff'
import type { Load, Stop } from '@/types'

// An Aljex-imported row: `stops` stored as a JSON string, not a list.
const STOPS = [
  { id: 'pu', type: 'pickup', sequence: 0, name: 'YAZAKI', city: 'EL PASO, TX', address: { city: 'EL PASO', state: 'TX', zip: '799285900' } },
  { id: 'de', type: 'delivery', sequence: 1, name: 'YAZAKI', city: 'EDWARDSVILLE, IL', address: { city: 'EDWARDSVILLE', state: 'IL', zip: '620252894' } },
]

describe('string stops', () => {
  it('getStops reads them instead of synthesizing stops without ZIPs', () => {
    const got = getStops({ id: 'l1', stops: JSON.stringify(STOPS) } as unknown as Load)
    expect(got.map((s) => s.id)).toEqual(['pu', 'de'])
  })

  it('the factor-ready / OTR place reading finds city, state and ZIP', () => {
    const raw = JSON.stringify(STOPS) as unknown as Stop[]
    expect(placeOf(ordered(raw, 'pickup')[0])).toEqual({ city: 'EL PASO', state: 'TX', zip: '79928' })
    expect(placeOf(ordered(raw, 'delivery')[0])).toEqual({ city: 'EDWARDSVILLE', state: 'IL', zip: '62025' })
  })
})
