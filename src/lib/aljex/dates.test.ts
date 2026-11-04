import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  chicagoDateTimeIso,
  chicagoMidnightIso,
  derivedWindow,
  isPlausibleDate,
  noonUtcIso,
  parseAljexDate,
  parseAljexTime,
  resolvePickupDate,
} from './dates'
import type { CanonicalDates } from './canonical'

const dates = (p: Partial<CanonicalDates>): { dates: CanonicalDates } => ({
  dates: {
    invoice: null, ship: null, eta: null, deliveryAppt: null, deliveryApptTime: null, mustDeliver: null, delivered: null,
    release: null, releaseTime: null, created: null, createdTime: null, covered: null, coveredTime: null, confRecd: null,
    ...p,
  },
})

describe('parseAljexDate', () => {
  it('reads MM/DD/YY with the 70 pivot: 24 -> 2024, 70 -> 1970 (flagged junk, never coerced)', () => {
    expect(parseAljexDate('03/05/24')).toEqual({ parsed: '2024-03-05', date: '2024-03-05', junk: false })
    expect(parseAljexDate('01/01/69')).toEqual({ parsed: '2069-01-01', date: null, junk: true }) // outside 2000..2035
    expect(parseAljexDate('01/01/70')).toEqual({ parsed: '1970-01-01', date: null, junk: true })
    expect(parseAljexDate('11/16/26').date).toBe('2026-11-16')
  })
  it('accepts 4-digit years and ISO, rejects impossible calendar dates, treats blank as not junk', () => {
    expect(parseAljexDate('2/9/2025').date).toBe('2025-02-09')
    expect(parseAljexDate('2025-02-09').date).toBe('2025-02-09')
    expect(parseAljexDate('02/30/25')).toEqual({ parsed: null, date: null, junk: true })
    expect(parseAljexDate('13/01/25').junk).toBe(true)
    expect(parseAljexDate('02/29/24').date).toBe('2024-02-29')
    expect(parseAljexDate('02/29/25').junk).toBe(true)
    expect(parseAljexDate('')).toEqual({ parsed: null, date: null, junk: false })
    expect(parseAljexDate('soon').junk).toBe(true)
  })
})

describe('parseAljexTime', () => {
  it('normalises to HH:MM 24h', () => {
    expect(parseAljexTime('9:30')).toBe('09:30')
    expect(parseAljexTime('0930')).toBe('09:30')
    expect(parseAljexTime('9:30 PM')).toBe('21:30')
    expect(parseAljexTime('12:05 AM')).toBe('00:05')
    expect(parseAljexTime('25:00')).toBeNull()
    expect(parseAljexTime('')).toBeNull()
    expect(parseAljexTime('later')).toBeNull()
  })
})

describe('Chicago and ledger instants', () => {
  it('a date-only appointment is Chicago midnight, not UTC midnight (no previous-evening shift)', () => {
    expect(chicagoMidnightIso('2025-01-15')).toBe('2025-01-15T06:00:00.000Z') // CST
    expect(chicagoMidnightIso('2025-07-15')).toBe('2025-07-15T05:00:00.000Z') // CDT
  })
  it('stays correct on the spring-forward and fall-back days', () => {
    expect(chicagoMidnightIso('2025-03-09')).toBe('2025-03-09T06:00:00.000Z') // midnight is still CST
    expect(chicagoMidnightIso('2025-03-10')).toBe('2025-03-10T05:00:00.000Z')
    expect(chicagoMidnightIso('2025-11-02')).toBe('2025-11-02T05:00:00.000Z') // midnight is still CDT
    expect(chicagoMidnightIso('2025-11-03')).toBe('2025-11-03T06:00:00.000Z')
    expect(chicagoDateTimeIso('2025-03-09', '12:00')).toBe('2025-03-09T17:00:00.000Z')
  })
  it('ledger timestamps from a date-only source are noon UTC', () => {
    expect(noonUtcIso('2025-02-03')).toBe('2025-02-03T12:00:00.000Z')
  })
})

describe('calendar math and window', () => {
  it('adds months with day clamping and days across month ends', () => {
    expect(addMonths('2025-03-31', -1)).toBe('2025-02-28')
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29')
    expect(addMonths('2025-11-15', 3)).toBe('2026-02-15')
    expect(addDays('2025-12-30', 3)).toBe('2026-01-02')
  })
  it('derives the window from the file (min/max created +- 1 year), never from the clock', () => {
    expect(derivedWindow(['2025-03-01', null, '2026-02-10'])).toEqual({ start: '2024-03-01', end: '2027-02-10' })
    expect(derivedWindow([null])).toBeNull()
  })
  it('plausibility is inclusive of the window edges', () => {
    const w = { start: '2024-03-01', end: '2027-02-10' }
    expect(isPlausibleDate('2024-03-01', w)).toBe(true)
    expect(isPlausibleDate('2024-02-29', w)).toBe(false)
    expect(isPlausibleDate('2027-02-10', w)).toBe(true)
    expect(isPlausibleDate(null, w)).toBe(false)
  })
})

describe('resolvePickupDate fallback chain', () => {
  const w = { start: '2025-01-01', end: '2026-12-31' }
  it('uses a plausible ship date first', () => {
    expect(resolvePickupDate(dates({ ship: '2025-05-01', delivered: '2025-05-03', created: '2025-04-29' }), w)).toEqual({ date: '2025-05-01', source: 'SHIP_DATE' })
  })
  it('falls back to delivered, then delivery appt, then created when ship is junk or out of window', () => {
    expect(resolvePickupDate(dates({ ship: '2020-01-01', delivered: '2025-05-03', created: '2025-04-29' }), w).source).toBe('DELIVERED')
    expect(resolvePickupDate(dates({ ship: null, delivered: '2019-01-01', deliveryAppt: '2025-05-04', created: '2025-04-29' }), w).source).toBe('DELIVERY_APPT')
    expect(resolvePickupDate(dates({ ship: null, created: '2025-04-29' }), w)).toEqual({ date: '2025-04-29', source: 'CREATED' })
  })
  it('is undated when nothing is plausible', () => {
    expect(resolvePickupDate(dates({ ship: '2020-01-01', created: '2021-01-01' }), w)).toEqual({ date: null, source: 'NONE' })
  })
})
