import { describe, it, expect } from 'vitest'
import {
  apptHasTime, apptTimeLabel, needLabel, fromDateInput, fromDateTimeInput, PENDING_LABEL,
  formatDateTimeInput, formatTime,
} from './date'

/**
 * These pin the "no time chosen" convention the whole appointment UI rests on.
 *
 * The subtlety: a date-only appointment is stored as Chicago midnight, which is 05:00 or
 * 06:00 Z depending on daylight saving. Checking the UTC portion of the ISO string finds a
 * "time" on every one of them — the bug that made a NEED with no desired time render as
 * "NEED 24:00". The comparison has to happen in Chicago.
 */
describe('apptHasTime', () => {
  it('is false for a date-only appointment, in and out of daylight saving', () => {
    expect(apptHasTime(fromDateInput('2026-08-20'))).toBe(false) // CDT, stored 05:00Z
    expect(apptHasTime(fromDateInput('2026-01-15'))).toBe(false) // CST, stored 06:00Z
  })

  it('is true once a real time is set', () => {
    expect(apptHasTime(fromDateTimeInput('2026-08-20T09:30'))).toBe(true)
    expect(apptHasTime(fromDateTimeInput('2026-01-15T23:59'))).toBe(true)
  })

  it('treats a blank or unparseable value as having no time', () => {
    expect(apptHasTime('')).toBe(false)
    expect(apptHasTime(null)).toBe(false)
    expect(apptHasTime(undefined)).toBe(false)
    expect(apptHasTime('TBD')).toBe(false)
  })
})

describe('needLabel', () => {
  it('is plain NEED when no desired time was entered', () => {
    // Regression: this used to read "NEED 24:00" because the check compared UTC.
    expect(needLabel(fromDateInput('2026-08-20'))).toBe('NEED')
    expect(needLabel(fromDateInput('2026-01-15'))).toBe('NEED')
  })

  it('carries the desired time when one was entered', () => {
    expect(needLabel(fromDateTimeInput('2026-08-20T14:00'))).toBe('NEED 14:00')
  })
})

describe('apptTimeLabel', () => {
  const dateOnly = fromDateInput('2026-08-20')
  const at0930 = fromDateTimeInput('2026-08-20T09:30')

  it('reads Pending for an exact appointment with no time yet', () => {
    expect(apptTimeLabel(dateOnly, 'exact')).toBe(PENDING_LABEL)
  })

  it('reads the time once one is set', () => {
    expect(apptTimeLabel(at0930, 'exact')).toBe('09:30')
  })

  it('defaults to the same behaviour when the type is missing', () => {
    // Legacy rows can have no apptType; they should not claim a midnight appointment.
    expect(apptTimeLabel(dateOnly)).toBe(PENDING_LABEL)
    expect(apptTimeLabel(at0930)).toBe('09:30')
  })

  it('keeps NEED and FCFS distinct from Pending', () => {
    expect(apptTimeLabel(dateOnly, 'tbd')).toBe('NEED')
    expect(apptTimeLabel(dateOnly, 'fcfs')).toBe('FCFS')
    expect(apptTimeLabel(at0930, 'tbd')).toBe('NEED 09:30')
  })

  it('renders a range as a span', () => {
    expect(apptTimeLabel(at0930, 'range', fromDateTimeInput('2026-08-20T11:00')))
      .toBe('09:30–11:00')
  })

  it('shows a dash when there is no appointment at all', () => {
    expect(apptTimeLabel('')).toBe('—')
    expect(apptTimeLabel(null)).toBe('—')
  })
})

describe('midnight formats as 00:00, not 24:00, on every engine', () => {
  it('formatDateTimeInput never emits a 24:00 hour', () => {
    // Node's default h24 renders Chicago midnight as "24:00", which is not a valid
    // datetime-local value and made a date-only appointment look like it had a time.
    expect(formatDateTimeInput(fromDateInput('2099-01-01'))).toBe('2099-01-01T00:00')
  })

  it('formatTime agrees', () => {
    expect(formatTime(fromDateInput('2099-01-01'))).toBe('00:00')
  })

  it('so a date-only appointment still reads as having no time', () => {
    expect(apptHasTime(fromDateInput('2099-01-01'))).toBe(false)
  })
})
