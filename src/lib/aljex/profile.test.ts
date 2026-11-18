import { describe, expect, it } from 'vitest'
import { DEFAULT_ALJEX_PROFILE } from './profile'

describe('Aljex type map', () => {
  it('reads the R type letter as a reefer truckload, not rail (a RAIL mode blocked Cover)', () => {
    expect(DEFAULT_ALJEX_PROFILE.typeMap.R.mode).toBe('FTL')
    expect(Object.values(DEFAULT_ALJEX_PROFILE.typeMap).some((t) => t.mode === 'RAIL')).toBe(false)
  })
})
