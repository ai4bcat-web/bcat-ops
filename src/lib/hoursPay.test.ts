import { describe, it, expect } from 'vitest'
import { payForPeriod, rateOn, withRateChange, currentRateFrom, money } from './hoursPay'

const day = (date: string, minutes: number) => ({ date, minutes })
const fortnight = (minutes: number) => Array.from({ length: 14 }, (_, i) => day(new Date(Date.UTC(2026, 9, 12 + i)).toISOString().slice(0, 10), minutes))

describe('payForPeriod', () => {
  it('multiplies paid hours by the rate and rounds to cents once', () => {
    // 10 days x 8h15m = 82.5h at $22.37 = $1845.525 -> $1845.53, not ten rounded days.
    const days = Array.from({ length: 10 }, (_, i) => day(`2026-10-${12 + i}`, 495))
    const r = payForPeriod(days, { hourlyRate: 22.37 })
    expect(r).toMatchObject({ totalMinutes: 4950, pay: 1845.53, rate: 22.37, mixedRates: false, partial: false })
  })

  it('a mid-period raise pays each day at the rate in effect that day', () => {
    // $20 before 10/19, $25 from 10/19. Two 8h days either side.
    const setting = withRateChange({ hourlyRate: 20 }, 25, '2026-10-19', 'ryne@bcatcorp.com', 't')
    const r = payForPeriod([day('2026-10-17', 480), day('2026-10-18', 480), day('2026-10-19', 480), day('2026-10-20', 480)], setting)
    expect(r.pay).toBe(8 * 20 * 2 + 8 * 25 * 2)
    expect(r).toMatchObject({ rate: 25, mixedRates: true, partial: false })
  })

  it('no rate means no figure: pay null, never zero', () => {
    const r = payForPeriod([day('2026-10-12', 480)], {})
    expect(r).toMatchObject({ pay: null, rate: null, totalMinutes: 480 })
    expect(money(r.pay)).toBe('—')
  })

  it('a rate that starts mid-period leaves the earlier days unrated and says the pay is partial', () => {
    const setting = withRateChange({}, 30, '2026-10-19', 'r', 't')
    const r = payForPeriod([day('2026-10-17', 480), day('2026-10-19', 480)], setting)
    expect(r).toMatchObject({ pay: 240, partial: true, totalMinutes: 960 })
  })

  it('worked + PTO on the same day, and a holiday, are all paid minutes at the rate', () => {
    // Day minutes already combine kinds (timeClock DayTotal.totalMinutes): 4h worked + 8h PTO.
    const r = payForPeriod([day('2026-10-12', 240 + 480), day('2026-10-14', 480)], { hourlyRate: 20 })
    expect(r.pay).toBe(12 * 20 + 8 * 20)
  })

  it('an empty period is zero minutes and no pay', () => {
    expect(payForPeriod([], { hourlyRate: 20 })).toMatchObject({ totalMinutes: 0, pay: null, rate: null })
    expect(payForPeriod(fortnight(0), { hourlyRate: 20 })).toMatchObject({ totalMinutes: 0, pay: null })
  })
})

describe('withRateChange', () => {
  it('keeps the old rate as a closed window with who and when, and the new one current', () => {
    const s = withRateChange({ hourlyRate: 20 }, 25, '2026-10-19', 'ryne@bcatcorp.com', '2026-11-06T12:00:00Z')
    expect(s.hourlyRate).toBe(25)
    expect(s.hourlyRateHistory).toEqual([{ from: '1970-01-01', until: '2026-10-19', hourlyRate: 20, endedBy: 'ryne@bcatcorp.com', endedAt: '2026-11-06T12:00:00Z' }])
    expect(rateOn(s, '2026-10-18')).toBe(20)
    expect(rateOn(s, '2026-10-19')).toBe(25)
    expect(currentRateFrom(s)).toBe('2026-10-19')
  })

  it('a first rate leaves the days before it unrated rather than back-paying them', () => {
    const s = withRateChange({}, 22, '2026-10-12', 'r', 't')
    expect(rateOn(s, '2026-10-11')).toBeNull()
    expect(rateOn(s, '2026-10-12')).toBe(22)
  })

  it('chains raises, refuses to start before the current rate began, and corrects in place on the same day', () => {
    const one = withRateChange({ hourlyRate: 20 }, 25, '2026-10-19', 'r', 't')
    const two = withRateChange(one, 27, '2026-11-02', 'r', 't')
    expect(two.hourlyRateHistory.map((w) => [w.from, w.until, w.hourlyRate])).toEqual([['1970-01-01', '2026-10-19', 20], ['2026-10-19', '2026-11-02', 25]])
    expect(() => withRateChange(two, 30, '2026-10-25', 'r', 't')).toThrow(/began 2026-11-02/)
    const fixed = withRateChange(two, 28, '2026-11-02', 'r', 't')
    expect(fixed.hourlyRate).toBe(28)
    expect(fixed.hourlyRateHistory).toHaveLength(2)
  })

  it('rejects a zero, negative or missing rate and a bad date', () => {
    expect(() => withRateChange({}, 0, '2026-10-12', 'r', 't')).toThrow()
    expect(() => withRateChange({}, -3, '2026-10-12', 'r', 't')).toThrow()
    expect(() => withRateChange({}, 20, '10/12', 'r', 't')).toThrow()
  })
})
