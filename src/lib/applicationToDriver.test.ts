import { describe, it, expect } from 'vitest'
import {
  driverPatchFromApplication, isPlaceholderName, placeholderNameFor, formatCdl,
} from './applicationToDriver'
import type { Driver, DriverApplicationRecord } from '@/types'

const app = (over: Partial<DriverApplicationRecord> = {}): DriverApplicationRecord => ({
  id: 'a1', driverId: 'd1', status: 'SUBMITTED', createdAt: '', updatedAt: '',
  legalName: 'Zachary Pace', phone: '(847) 293-6704',
  cdlNumber: '8823901', cdlState: 'il', cdlClass: 'A', cdlExpiration: '2027-03-14',
  ...over,
})

const driver = (over: Partial<Driver> = {}): Driver => ({
  id: 'd1', name: 'zak pace', email: 'zak.pace@example.com', phone: '', active: true,
  createdAt: '', updatedAt: '', ...over,
})

describe('placeholder names', () => {
  it('recognises the stub the invite generates', () => {
    expect(placeholderNameFor('zak.pace@example.com')).toBe('zak pace')
    expect(isPlaceholderName('zak pace', 'zak.pace@example.com')).toBe(true)
    expect(isPlaceholderName('Zak Pace', 'zak.pace@example.com')).toBe(true)  // case-insensitive
  })

  it('treats a real name as real', () => {
    expect(isPlaceholderName('Zachary Pace', 'zak.pace@example.com')).toBe(false)
  })

  it('treats an empty name as a placeholder', () => {
    expect(isPlaceholderName('', 'x@y.com')).toBe(true)
    expect(isPlaceholderName(null, 'x@y.com')).toBe(true)
  })

  it('never assumes a placeholder when there is no email to compare against', () => {
    expect(isPlaceholderName('Some Name', null)).toBe(false)
  })
})

describe('formatCdl', () => {
  it('builds the shape used elsewhere in the app', () => {
    expect(formatCdl({ cdlNumber: '8823901', cdlState: 'il', cdlClass: 'A' })).toBe('CDL-A IL-8823901')
  })

  it('tolerates "Class A" as well as "A"', () => {
    expect(formatCdl({ cdlNumber: '1', cdlState: 'WI', cdlClass: 'Class B' })).toBe('CDL-B WI-1')
  })

  it('is empty without a number — a state alone is not a licence', () => {
    expect(formatCdl({ cdlNumber: '', cdlState: 'IL', cdlClass: 'A' })).toBe('')
  })
})

describe('driverPatchFromApplication', () => {
  it('fills in the real name over the generated stub', () => {
    expect(driverPatchFromApplication(app(), driver()).name).toBe('Zachary Pace')
  })

  it('fills phone, CDL and expiry when the record has none', () => {
    const patch = driverPatchFromApplication(app(), driver())
    expect(patch.phone).toBe('(847) 293-6704')
    expect(patch.cdl).toBe('CDL-A IL-8823901')
    expect(patch.cdlExpiration).toBe('2027-03-14')
  })

  it('NEVER overwrites what a person already entered', () => {
    // The office may have corrected something the applicant typed wrong; a submission
    // must not silently undo that.
    const existing = driver({ name: 'Zak P. Pace', phone: '+15551234567', cdl: 'CDL-A IL-0000', cdlExpiration: '2030-01-01' })
    expect(driverPatchFromApplication(app(), existing)).toEqual({})
  })

  it('returns an empty patch when the application carries nothing useful', () => {
    const empty = app({ legalName: null, phone: null, cdlNumber: null, cdlExpiration: null })
    expect(driverPatchFromApplication(empty, driver())).toEqual({})
  })

  it('fills only the gaps, leaving the rest alone', () => {
    const partial = driver({ phone: '+15551112222' })   // phone already known
    const patch = driverPatchFromApplication(app(), partial)
    expect(patch.phone).toBeUndefined()
    expect(patch.name).toBe('Zachary Pace')
    expect(patch.cdl).toBe('CDL-A IL-8823901')
  })

  it('trims a full ISO expiry to the calendar day', () => {
    const patch = driverPatchFromApplication(app({ cdlExpiration: '2027-03-14T00:00:00Z' }), driver())
    expect(patch.cdlExpiration).toBe('2027-03-14')
  })
})
