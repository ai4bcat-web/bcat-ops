import { describe, it, expect } from 'vitest'
import {
  laneKey3OfSpec, laneKeyOfSpec, lanePlace, laneSpecFromKeys, matchLane, matchPlace, normalizeEquipment, sameEquipment,
} from './laneMatch'

const lane = (o: [string, string, string?], d: [string, string, string?]) => ({
  origin: lanePlace({ city: o[0], state: o[1], zip: o[2] }),
  destination: lanePlace({ city: d[0], state: d[1], zip: d[2] }),
})

describe('lane matching', () => {
  it('treats spelling, punctuation and state names as the same place', () => {
    const a = lanePlace({ city: 'St. Louis', state: 'Missouri' })
    const b = lanePlace({ city: 'SAINT  LOUIS', state: 'mo' })
    expect(matchPlace(a, b)).toBe('CITY')
    expect(matchPlace(a, lanePlace({ city: 'St Louis', state: 'IL' }))).toBeNull()
  })

  it('never matches a city with no state by name', () => {
    expect(matchPlace(lanePlace({ city: 'Springfield' }), lanePlace({ city: 'Springfield', state: 'IL' }))).toBeNull()
  })

  it('falls back to ZIP3 when the cities differ, and says so', () => {
    const target = lane(['Chicago', 'IL', '60601'], ['Dallas', 'TX', '75201'])
    const evanston = laneSpecFromKeys('EVANSTON|IL>DALLAS|TX', '606>752')
    expect(matchLane(target, evanston)).toBe('ZIP3')
    expect(matchLane(target, evanston, { zip3: false })).toBeNull()
    expect(matchLane(target, laneSpecFromKeys('CHICAGO|IL>DALLAS|TX', '606>752'))).toBe('CITY')
  })

  it('needs BOTH ends to match', () => {
    const target = lane(['Chicago', 'IL', '60601'], ['Dallas', 'TX', '75201'])
    expect(matchLane(target, laneSpecFromKeys('CHICAGO|IL>HOUSTON|TX', '606>770'))).toBeNull()
    expect(matchLane(target, laneSpecFromKeys('DALLAS|TX>CHICAGO|IL', '752>606'))).toBeNull()
  })

  it('matches by radius only when asked and only with coordinates on both sides', () => {
    const chicago = lanePlace({ city: 'Chicago', state: 'IL', lat: 41.878, lon: -87.63 })
    const joliet = lanePlace({ city: 'Joliet', state: 'IL', lat: 41.525, lon: -88.082 })
    const milwaukee = lanePlace({ city: 'Milwaukee', state: 'WI', lat: 43.039, lon: -87.907 })
    expect(matchPlace(chicago, joliet)).toBeNull()
    expect(matchPlace(chicago, joliet, { radiusMiles: 50 })).toBe('RADIUS')
    expect(matchPlace(chicago, joliet, { radiusMiles: 20 })).toBeNull()
    expect(matchPlace(chicago, milwaukee, { radiusMiles: 50 })).toBeNull()
    expect(matchPlace(chicago, lanePlace({ city: 'Joliet', state: 'IL' }), { radiusMiles: 500 })).toBeNull()
  })

  it('round-trips the lane keys the samples are stored under', () => {
    const spec = lane(['St. Louis', 'MO', '63101'], ['Danville', 'IL', '61832'])
    expect(laneKeyOfSpec(spec)).toBe('ST LOUIS|MO>DANVILLE|IL')
    expect(laneKey3OfSpec(spec)).toBe('631>618')
    expect(laneKeyOfSpec(lane(['Chicago', ''], ['Dallas', 'TX']))).toBeNull()
  })

  it('compares equipment through its aliases and does not punish an untyped row', () => {
    expect(normalizeEquipment('Dry Van')).toBe('VAN')
    expect(sameEquipment('VAN', 'dv')).toBe(true)
    expect(sameEquipment('VAN', 'REEFER')).toBe(false)
    expect(sameEquipment('VAN', null)).toBe(true)
  })
})
