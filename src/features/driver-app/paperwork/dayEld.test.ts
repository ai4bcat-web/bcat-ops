import { describe, it, expect } from 'vitest'
import { dayEldState } from './dayEld'
import type { PaperworkLoad } from '../driverApi'

const load = (status: 'REQUIRED' | 'NOT_REQUIRED' | 'UNKNOWN' | null) =>
  ({ id: status ?? 'none', eld: status ? { status, required: status === 'REQUIRED', farthestMiles: 0, farthestCity: null, label: '' } : undefined } as unknown as PaperworkLoad)

describe('dayEldState — the one thing to know before rolling', () => {
  it('is NOT_REQUIRED on an empty day and on an all-local day', () => {
    expect(dayEldState([])).toBe('NOT_REQUIRED')
    expect(dayEldState([load('NOT_REQUIRED'), load('NOT_REQUIRED')])).toBe('NOT_REQUIRED')
  })
  it('is REQUIRED as soon as any stop leaves the radius', () => {
    expect(dayEldState([load('NOT_REQUIRED'), load('REQUIRED'), load('UNKNOWN')])).toBe('REQUIRED')
  })
  it('is UNKNOWN when a stop could not be placed and nothing is known to be out', () => {
    expect(dayEldState([load('NOT_REQUIRED'), load('UNKNOWN')])).toBe('UNKNOWN')
  })
  it('says nothing when the API predates the field — absent must never read as "no logs"', () => {
    expect(dayEldState([load(null), load('NOT_REQUIRED')])).toBe('NO_DATA')
  })
})
