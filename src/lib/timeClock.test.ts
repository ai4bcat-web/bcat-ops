/**
 * The time clock's arithmetic. The cases worth pinning are the ones that put hours on the
 * wrong paycheck: the Sunday week boundary, an open shift, and a staff correction.
 */
import { describe, it, expect } from 'vitest'
import {
  weekStartOf, weekEndOf, weekDays, recentWeekStarts, rowMinutes, isOpenShift,
  summarizeWeek, minutesLabel, decimalHours, STANDARD_DAY_MINUTES, PAID_HOLIDAYS,
  compareToMotive, payPeriodStartOf, payPeriodEndOf, payPeriodDays,
  recentPayPeriodStarts, summarizePayPeriod,
  type TimeClockRow, type DayTotal,
} from './timeClock'

const row = (over: Partial<TimeClockRow> = {}): TimeClockRow => ({
  id: 'r1', driverId: 'd1', workDate: '2026-10-05', kind: 'WORK', ...over,
})

describe('the week, Monday to Sunday', () => {
  it('starts on Monday', () => {
    // 2026-10-05 is a Monday.
    expect(weekStartOf('2026-10-05')).toBe('2026-10-05')
    expect(weekEndOf('2026-10-05')).toBe('2026-10-11')
  })

  it('puts a Sunday in the week that STARTED, not the one about to begin', () => {
    /*
     * getUTCDay() is 0 for Sunday, so the naive "subtract dow - 1" moves Sunday FORWARD a
     * week. That is the off-by-one that puts a Sunday shift on the wrong paycheck.
     */
    expect(weekStartOf('2026-10-11')).toBe('2026-10-05')
    expect(weekEndOf('2026-10-11')).toBe('2026-10-11')
  })

  it('handles every day of one week identically', () => {
    for (const d of weekDays('2026-10-05')) {
      expect(weekStartOf(d)).toBe('2026-10-05')
    }
  })

  it('lists seven days starting Monday', () => {
    const days = weekDays('2026-10-05')
    expect(days).toHaveLength(7)
    expect(days[0]).toBe('2026-10-05')
    expect(days[6]).toBe('2026-10-11')
  })

  it('crosses a month and a year boundary', () => {
    expect(weekStartOf('2027-01-01')).toBe('2026-12-28')
    expect(weekEndOf('2026-12-28')).toBe('2027-01-03')
  })

  it('walks back through previous weeks, newest first', () => {
    expect(recentWeekStarts('2026-10-08', 3)).toEqual(['2026-10-05', '2026-09-28', '2026-09-21'])
  })
})

describe('what a row is worth', () => {
  it('uses the stored minutes when there are any', () => {
    expect(rowMinutes(row({ minutes: 437 }))).toBe(437)
  })

  it('prefers a staff correction over what the clock times say', () => {
    /*
     * A correction exists precisely because the timestamps are wrong — a missed clock-out,
     * a break nobody logged. Recomputing from them would undo the fix every read.
     */
    const corrected = row({
      clockInAt: '2026-10-05T12:00:00Z',
      clockOutAt: '2026-10-06T02:00:00Z',   // 14 hours of raw span
      minutes: 480,                          // staff say it was 8
      originalMinutes: 840,
    })
    expect(rowMinutes(corrected)).toBe(480)
  })

  it('falls back to the timestamps for a row never totalled', () => {
    expect(rowMinutes(row({ clockInAt: '2026-10-05T12:00:00Z', clockOutAt: '2026-10-05T20:30:00Z' })))
      .toBe(510)
  })

  it('pays an open shift nothing', () => {
    /*
     * Counting up to "now" would grow while a driver is at lunch, and a forgotten
     * clock-out would quietly bill a 14-hour day. Nothing until the shift is closed.
     */
    const open = row({ clockInAt: '2026-10-05T12:00:00Z', clockOutAt: null })
    expect(rowMinutes(open)).toBe(0)
    expect(isOpenShift(open)).toBe(true)
  })

  it('pays a holiday and PTO a standard day', () => {
    expect(rowMinutes(row({ kind: 'HOLIDAY' }))).toBe(STANDARD_DAY_MINUTES)
    expect(rowMinutes(row({ kind: 'PTO' }))).toBe(STANDARD_DAY_MINUTES)
  })

  it('refuses a clock-out before the clock-in', () => {
    expect(rowMinutes(row({ clockInAt: '2026-10-05T20:00:00Z', clockOutAt: '2026-10-05T12:00:00Z' })))
      .toBe(0)
  })

  it('does not treat a holiday as an open shift', () => {
    expect(isOpenShift(row({ kind: 'HOLIDAY' }))).toBe(false)
  })
})

describe('a week of rows', () => {
  it('sums several shifts in one day', () => {
    // Clocking out for lunch and back in is normal; the day is the SUM, not one span.
    const w = summarizeWeek('2026-10-05', [
      row({ id: 'a', workDate: '2026-10-05', minutes: 240 }),
      row({ id: 'b', workDate: '2026-10-05', minutes: 210 }),
    ])
    expect(w.days[0].workedMinutes).toBe(450)
    expect(w.totalMinutes).toBe(450)
  })

  it('keeps worked, holiday and PTO apart but totals them together', () => {
    const w = summarizeWeek('2026-10-05', [
      row({ id: 'a', workDate: '2026-10-05', minutes: 480 }),
      row({ id: 'b', workDate: '2026-10-06', kind: 'HOLIDAY' }),
      row({ id: 'c', workDate: '2026-10-07', kind: 'PTO' }),
    ])
    expect(w.workedMinutes).toBe(480)
    expect(w.holidayMinutes).toBe(STANDARD_DAY_MINUTES)
    expect(w.ptoMinutes).toBe(STANDARD_DAY_MINUTES)
    expect(w.totalMinutes).toBe(480 + STANDARD_DAY_MINUTES * 2)
  })

  it('applies NO overtime past forty hours', () => {
    // Specified: hours are hours. 60 worked hours is 60, not 40 + 20 at a multiplier.
    const w = summarizeWeek('2026-10-05',
      weekDays('2026-10-05').map((d, i) => row({ id: `r${i}`, workDate: d, minutes: 600 })))
    expect(w.workedMinutes).toBe(4200)
    expect(decimalHours(w.totalMinutes)).toBe(70)
  })

  it('shows all seven days even when nothing was worked', () => {
    const w = summarizeWeek('2026-10-05', [])
    expect(w.days).toHaveLength(7)
    expect(w.totalMinutes).toBe(0)
    expect(w.days.every((d) => d.totalMinutes === 0)).toBe(true)
  })

  it('ignores rows from another week rather than folding them in', () => {
    const w = summarizeWeek('2026-10-05', [
      row({ id: 'a', workDate: '2026-10-05', minutes: 480 }),
      row({ id: 'b', workDate: '2026-09-28', minutes: 480 }),
    ])
    expect(w.totalMinutes).toBe(480)
  })

  it('flags the week while a shift is still running', () => {
    const w = summarizeWeek('2026-10-05', [
      row({ workDate: '2026-10-07', clockInAt: '2026-10-07T12:00:00Z', clockOutAt: null }),
    ])
    expect(w.open).toBe(true)
    expect(w.days[2].open).toBe(true)
  })

  it('normalises a mid-week start to its Monday', () => {
    expect(summarizeWeek('2026-10-08', []).weekStart).toBe('2026-10-05')
  })
})

describe('formatting', () => {
  it('reads hours the way a person would', () => {
    expect(minutesLabel(495)).toBe('8h 15m')
    expect(minutesLabel(0)).toBe('0h 0m')
  })

  it('gives payroll a clean decimal', () => {
    expect(decimalHours(495)).toBe(8.25)
    expect(decimalHours(480)).toBe(8)
  })
})

describe('paid holidays', () => {
  it('is the standard six', () => {
    expect(PAID_HOLIDAYS).toHaveLength(6)
    expect(PAID_HOLIDAYS.map((h) => h.label)).toContain('Thanksgiving')
    expect(PAID_HOLIDAYS.map((h) => h.label)).toContain("New Year's Day")
  })

  it('offers a fixed list rather than free text', () => {
    // So "Thanksgiving", "thanksgiving" and "Turkey day" cannot become three holidays.
    expect(PAID_HOLIDAYS.every((h) => typeof h.key === 'string' && h.key.length > 0)).toBe(true)
  })
})

describe('comparing a time card to Motive', () => {
  const day = (over: Partial<DayTotal> = {}): DayTotal => ({
    date: '2026-10-05', workedMinutes: 480, holidayMinutes: 0, ptoMinutes: 0,
    totalMinutes: 480, open: false, rows: [], ...over,
  })

  it('agrees when the two are close', () => {
    const c = compareToMotive(day(), { firstOnDutyAt: 'x', lastOffDutyAt: 'y', workedSeconds: 8 * 3600 })
    expect(c.state).toBe('MATCH')
  })

  it('tolerates an hour either way', () => {
    // A driver doing paperwork is working while the truck records nothing; an idling truck
    // records time nobody worked. Small differences are normal, not errors.
    expect(compareToMotive(day(), { firstOnDutyAt: 'x', lastOffDutyAt: 'y', workedSeconds: 7.2 * 3600 }).state)
      .toBe('MATCH')
  })

  it('flags a real gap for a human', () => {
    const c = compareToMotive(day({ totalMinutes: 720 }), { firstOnDutyAt: 'x', lastOffDutyAt: 'y', workedSeconds: 8 * 3600 })
    expect(c.state).toBe('GAP')
    expect(c).toMatchObject({ diffMinutes: 240 })
  })

  it('flags a gap the other way too', () => {
    // The card reading LESS than the truck matters just as much — a missed clock-in.
    const c = compareToMotive(day({ totalMinutes: 120 }), { firstOnDutyAt: 'x', lastOffDutyAt: 'y', workedSeconds: 8 * 3600 })
    expect(c.state).toBe('GAP')
    expect(c).toMatchObject({ diffMinutes: -360 })
  })

  it('says nothing when Motive has no day', () => {
    expect(compareToMotive(day(), null).state).toBe('NO_DATA')
    expect(compareToMotive(day(), { firstOnDutyAt: null, lastOffDutyAt: null, workedSeconds: 0 }).state)
      .toBe('NO_DATA')
  })

  it('does not compare a shift that is still running', () => {
    expect(compareToMotive(day({ open: true }), { firstOnDutyAt: 'x', lastOffDutyAt: null, workedSeconds: 3600 }).state)
      .toBe('OPEN')
  })

  it('never returns a corrected figure, only a difference', () => {
    /*
     * The card is what payroll pays. Motive is evidence for a person to weigh, never a
     * value that overwrites a card — so there is deliberately no "suggested minutes" here.
     */
    const c = compareToMotive(day({ totalMinutes: 720 }), { firstOnDutyAt: 'x', lastOffDutyAt: 'y', workedSeconds: 8 * 3600 })
    expect(Object.keys(c).sort()).toEqual(['diffMinutes', 'state'])
  })
})

describe('pay periods', () => {
  it('uses the period the office gave us', () => {
    // 28 Sep 2026 to 11 Oct 2026, stated by Ryne.
    expect(payPeriodStartOf('2026-09-28')).toBe('2026-09-28')
    expect(payPeriodEndOf('2026-09-28')).toBe('2026-10-11')
  })

  it('puts every day of that fortnight in it', () => {
    for (const d of payPeriodDays('2026-09-28')) {
      expect(payPeriodStartOf(d)).toBe('2026-09-28')
    }
    expect(payPeriodDays('2026-09-28')).toHaveLength(14)
  })

  it('starts the next period the very next day', () => {
    expect(payPeriodStartOf('2026-10-12')).toBe('2026-10-12')
    expect(payPeriodEndOf('2026-10-12')).toBe('2026-10-25')
  })

  it('counts BACKWARDS correctly, which the obvious version gets wrong', () => {
    /*
     * A date before the anchor gives a negative offset, and `%` in JavaScript keeps the
     * sign of the dividend — so a remainder-based version puts mid-September into the
     * period starting in October. That pays somebody for the wrong fortnight.
     */
    expect(payPeriodStartOf('2026-09-27')).toBe('2026-09-14')
    expect(payPeriodStartOf('2026-09-14')).toBe('2026-09-14')
    expect(payPeriodStartOf('2026-09-13')).toBe('2026-08-31')
  })

  it('still lands on a Monday a year either side of the anchor', () => {
    for (const d of ['2025-10-06', '2027-10-04', '2026-01-05']) {
      const start = payPeriodStartOf(d)
      expect(new Date(`${start}T12:00:00Z`).getUTCDay()).toBe(1)
    }
  })

  it('crosses a year boundary without drifting', () => {
    expect(payPeriodEndOf(payPeriodStartOf('2027-01-01'))).toBe(
      payPeriodDays(payPeriodStartOf('2027-01-01'))[13],
    )
  })

  it('walks back through previous periods, newest first', () => {
    expect(recentPayPeriodStarts('2026-10-06', 3))
      .toEqual(['2026-09-28', '2026-09-14', '2026-08-31'])
  })
})

describe('a pay period of rows', () => {
  const r = (date: string, minutes: number): TimeClockRow => ({
    id: date, driverId: 'd1', workDate: date, kind: 'WORK', minutes,
  })

  it('is the sum of its two weeks', () => {
    const p = summarizePayPeriod('2026-09-28', [r('2026-09-29', 480), r('2026-10-07', 300)])
    expect(p.weeks).toHaveLength(2)
    expect(p.weeks[0].totalMinutes).toBe(480)
    expect(p.weeks[1].totalMinutes).toBe(300)
    expect(p.totalMinutes).toBe(780)
  })

  it('covers all fourteen days', () => {
    const p = summarizePayPeriod('2026-09-28', [])
    expect(p.days).toHaveLength(14)
    expect(p.days[0].date).toBe('2026-09-28')
    expect(p.days[13].date).toBe('2026-10-11')
  })

  it('applies no overtime at 40 hours or at 80', () => {
    // Hours are hours, as specified — for a fortnight as much as for a week.
    const rows = payPeriodDays('2026-09-28').map((d) => r(d, 600))
    const p = summarizePayPeriod('2026-09-28', rows)
    expect(decimalHours(p.totalMinutes)).toBe(140)
  })

  it('ignores rows outside the period', () => {
    const p = summarizePayPeriod('2026-09-28', [r('2026-09-27', 480), r('2026-10-12', 480)])
    expect(p.totalMinutes).toBe(0)
  })

  it('keeps holiday and PTO separate across the fortnight', () => {
    const p = summarizePayPeriod('2026-09-28', [
      { id: 'h', driverId: 'd1', workDate: '2026-09-30', kind: 'HOLIDAY' },
      { id: 'p', driverId: 'd1', workDate: '2026-10-08', kind: 'PTO' },
    ])
    expect(p.holidayMinutes).toBe(STANDARD_DAY_MINUTES)
    expect(p.ptoMinutes).toBe(STANDARD_DAY_MINUTES)
  })

  it('normalises a mid-period date to the period start', () => {
    expect(summarizePayPeriod('2026-10-07', []).periodStart).toBe('2026-09-28')
  })
})
