import { describe, it, expect } from 'vitest'
import { REGIONS, regionOfState } from './usRegions'

describe('regionOfState', () => {
  it('maps every region from its states', () => {
    expect(regionOfState('NY')).toBe('NORTHEAST')
    expect(regionOfState('FL')).toBe('SOUTHEAST')
    expect(regionOfState('IL')).toBe('MIDWEST')
    expect(regionOfState('TX')).toBe('SOUTHWEST')
    expect(regionOfState('CA')).toBe('WEST')
    expect(regionOfState('DC')).toBe('NORTHEAST')
  })

  it('is tolerant of lower case and city/state text', () => {
    expect(regionOfState('dallas, tx')).toBe('SOUTHWEST')
    expect(regionOfState('CHICAGO, IL')).toBe('MIDWEST')
    expect(regionOfState('Miami, FL')).toBe('SOUTHEAST')
    expect(regionOfState('  ca  ')).toBe('WEST')
  })

  it('returns null for blank or unknown input', () => {
    expect(regionOfState(null)).toBeNull()
    expect(regionOfState('')).toBeNull()
    expect(regionOfState('   ')).toBeNull()
    expect(regionOfState('XX')).toBeNull()
    expect(regionOfState('Paris, FR')).toBeNull()
  })
})

describe('REGIONS', () => {
  it('lists the five census regions', () => {
    expect(REGIONS).toEqual(['NORTHEAST', 'SOUTHEAST', 'MIDWEST', 'SOUTHWEST', 'WEST'])
  })
})
