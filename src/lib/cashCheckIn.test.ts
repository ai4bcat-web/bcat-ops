import { describe, it, expect } from 'vitest'
import {
  CENTERS,
  DEFAULT_CASH_SETTINGS,
  type CashCheckIn,
  type CashSettingsValues,
  projectCash,
  latestCashCheckIn,
  trueLiquidity,
  cashMoney,
  cashMonthLabel,
  cashDateLabel,
  addCashMonths,
  factoringSummary,
  normalizeCashSettings,
  validateCashCheckIn,
  reminderDuePayroll,
} from './cashCheckIn'

const baseSettings: CashSettingsValues = {
  floor: 25_000,
  months: 6,
  // lag 0 everywhere so these cases exercise the reference math unchanged
  runrate: {
    bcat: { fixed: 30_000, profit: -5_000, lagMonths: 0 },
    ivan: { fixed: 60_000, profit: 20_000, lagMonths: 0 },
    amazon: { fixed: 82_000, profit: 18_000, lagMonths: 0 },
  },
  items: [],
  factoring: { on: false, start: '', stop: '', eligible: 0, fee: 0, advance: 90 },
}

const checkin = (over: Partial<CashCheckIn> = {}): CashCheckIn => ({
  id: 'ci-1',
  date: '2026-09-15',
  cash: 100_000,
  ar: 0,
  ap: 0,
  cards: 0,
  bcatMtdProfit: null,
  ivanMtdProfit: null,
  amazonMtdProfit: null,
  note: null,
  ...over,
})

describe('projectCash — per-center cash lag', () => {
  const lagged: CashSettingsValues = {
    ...baseSettings,
    months: 4,
    runrate: {
      bcat: { fixed: 0, profit: 0, lagMonths: 0 },
      ivan: { fixed: 0, profit: 20_000, lagMonths: 1 },
      amazon: { fixed: 0, profit: 0, lagMonths: 0 },
    },
  }

  it('shifts a scaled MTD month right by the lag and back-fills with run-rate', () => {
    const rows = projectCash([checkin({ cash: 0, ivanMtdProfit: 30_000 })], lagged) // Sep 15 → 60k earned
    expect(rows[0].net).toBe(60_000)        // Earned (P&L view)
    expect(rows[0].landing).toBe(20_000)    // August's run-rate lands in September
    expect(rows[1].landing).toBe(60_000)    // September's earnings land in October
    expect(rows[2].landing).toBe(20_000)
    expect(rows[0].cash).toBe(10_000)       // 20k × (1 − 15/30)
    expect(rows[1].cash).toBe(70_000)
  })

  it('lag 0 lands the same month; lag beyond the horizon start is all run-rate', () => {
    const rows = projectCash([checkin({ cash: 0, ivanMtdProfit: 30_000 })], {
      ...lagged,
      runrate: { ...lagged.runrate, ivan: { fixed: 0, profit: 20_000, lagMonths: 3 } },
    })
    expect(rows.slice(0, 3).map((r) => r.landing)).toEqual([20_000, 20_000, 20_000])
    expect(rows[3].landing).toBe(60_000)
  })

  it('normalize migrates a record without lagMonths to the per-center defaults and clamps', () => {
    const s = normalizeCashSettings({
      runrate: { bcat: { fixed: 1, profit: 1 }, ivan: { fixed: 1, profit: 1, lagMonths: 9 }, amazon: { fixed: 1, profit: 1, lagMonths: -2 } },
    })
    expect(s.runrate.bcat.lagMonths).toBe(1)
    expect(s.runrate.ivan.lagMonths).toBe(3)
    expect(s.runrate.amazon.lagMonths).toBe(0)
  })
})

describe('reminderDuePayroll', () => {
  // Mirrors amplify/functions/cash-checkin-reminder/handler.test.ts — the Lambda carries
  // its own copy of this rule; these cases keep the two from drifting.
  const settings = { reminder: { payrollAnchor: '2026-09-11', slackChannel: 'C1' } }
  const at = (today: string, dates: string[] = []) => reminderDuePayroll(settings, dates.map((date) => ({ date })), today)

  it('is due the morning after the anchor and every 14 days, suppressed by a check-in for that payroll', () => {
    expect(at('2026-09-12')).toBe('2026-09-11')
    expect(at('2026-09-26')).toBe('2026-09-25')
    expect(at('2026-09-11')).toBeNull()
    expect(at('2026-09-19')).toBeNull()
    expect(at('2026-09-01')).toBeNull()
    expect(at('2026-09-26', ['2026-09-25'])).toBeNull()
    expect(at('2026-09-26', ['2026-09-24'])).toBe('2026-09-25')
    expect(reminderDuePayroll({ reminder: { payrollAnchor: '', slackChannel: '' } }, [], '2026-09-12')).toBeNull()
  })
})

describe('latestCashCheckIn', () => {
  it('returns the most recent check-in by date', () => {
    const a = checkin({ id: 'a', date: '2026-09-10' })
    const b = checkin({ id: 'b', date: '2026-09-18' })
    const c = checkin({ id: 'c', date: '2026-09-15' })
    expect(latestCashCheckIn([a, b, c])?.id).toBe('b')
  })

  it('returns null for an empty list', () => {
    expect(latestCashCheckIn([])).toBeNull()
  })
})

describe('trueLiquidity', () => {
  it('is cash − cards + ar − ap', () => {
    expect(
      trueLiquidity({
        date: '2026-09-15',
        cash: 80_000,
        cards: 5_000,
        ar: 20_000,
        ap: 12_000,
      }),
    ).toBe(83_000)
  })
})

describe('formatters', () => {
  it('adds months across year boundaries', () => {
    expect(addCashMonths('2026-11', 3)).toBe('2027-02')
    expect(addCashMonths('2026-01', -1)).toBe('2025-12')
  })

  it('labels months and dates in UTC', () => {
    expect(cashMonthLabel('2026-02')).toBe('Feb 2026')
    expect(cashDateLabel('2026-12-25')).toBe('Dec 25, 2026')
  })

  it('renders whole dollars with a unicode minus', () => {
    expect(cashMoney(1234)).toBe('$1,234')
    expect(cashMoney(-1234)).toBe('−$1,234')
  })
})

describe('projectCash — month boundaries', () => {
  it('uses the correct day count for leap and short months', () => {
    const rows = projectCash(
      [checkin({ date: '2026-02-15', bcatMtdProfit: 3_000 })],
      { ...baseSettings, months: 1 },
    )
    // Feb 2026 has 28 days. day fraction floored at 0.1 => 15/28.
    expect(rows[0].per.bcat).toBeCloseTo(3_000 / (15 / 28), 4)
    // Remaining fraction is unrounded.
    expect(rows[0].netToCome).toBeCloseTo(rows[0].net * (1 - 15 / 28), 4)
  })

  it('applies no remaining profit when the check-in is on the last day of the month', () => {
    const rows = projectCash(
      [checkin({ date: '2026-04-30', bcatMtdProfit: 10_000 })],
      { ...baseSettings, months: 1 },
    )
    // Full month estimated, nothing still to come.
    expect(rows[0].netToCome).toBe(0)
  })

  it('floors the day fraction to 0.1 early in the month', () => {
    const rows = projectCash(
      [checkin({ date: '2026-01-02', bcatMtdProfit: 1_000 })],
      { ...baseSettings, months: 1 },
    )
    // 2/31 would be ~0.0645, floored to 0.1.
    expect(rows[0].per.bcat).toBe(1_000 / 0.1)
  })
})

describe('projectCash — MTD missing vs zero', () => {
  it('uses the run rate when MTD is missing', () => {
    const rows = projectCash([checkin({ bcatMtdProfit: undefined })], baseSettings)
    expect(rows[0].per.bcat).toBe(baseSettings.runrate.bcat.profit)
    expect(rows[0].estimated.bcat).toBe(false)
  })

  it('treats explicit zero MTD as an estimate', () => {
    const rows = projectCash([checkin({ bcatMtdProfit: 0 })], baseSettings)
    expect(rows[0].per.bcat).toBe(0)
    expect(rows[0].estimated.bcat).toBe(true)
    // Other centers without MTD still use run rate.
    expect(rows[0].per.ivan).toBe(baseSettings.runrate.ivan.profit)
    expect(rows[0].estimated.ivan).toBe(false)
  })
})

describe('projectCash — no AR/AP influence', () => {
  it('starts from cash only, ignoring AR and AP', () => {
    const rows = projectCash(
      [checkin({ cash: 50_000, ar: 30_000, ap: 20_000 })],
      { ...baseSettings, months: 1 },
    )
    expect(rows[0].cash).toBeCloseTo(50_000 + rows[0].netToCome, 4)
    expect(trueLiquidity(checkin({ cash: 50_000, ar: 30_000, ap: 20_000 }))).toBe(60_000)
  })
})

describe('projectCash — items by month', () => {
  it('adds items only in their assigned month', () => {
    const settings: CashSettingsValues = {
      ...baseSettings,
      items: [
        { ym: '2026-09', label: 'Tax', amount: -10_000 },
        { ym: '2026-10', label: 'Refund', amount: 5_000 },
      ],
    }
    const rows = projectCash([checkin({ date: '2026-09-15' })], settings)
    expect(rows[0].itemsSum).toBe(-10_000)
    expect(rows[1].itemsSum).toBe(5_000)
    expect(rows[2].itemsSum).toBe(0)
  })
})

describe('factoring overlay', () => {
  const factoringSettings = (on: boolean): CashSettingsValues => ({
    ...baseSettings,
    months: 4,
    factoring: {
      on,
      start: '2026-10',
      stop: '2026-11',
      eligible: 100_000,
      fee: 2,
      advance: 90,
    },
  })

  it('does nothing when factoring is off', () => {
    const rows = projectCash([checkin({ date: '2026-09-15' })], factoringSettings(false))
    expect(rows[0].fxCash).toBeUndefined()
    expect(factoringSummary(rows, factoringSettings(false)).endCash).toBe(rows[rows.length - 1].cash)
  })

  it('handles a one-month overlap start/stop correctly', () => {
    const rows = projectCash([checkin({ date: '2026-09-15' })], factoringSettings(true))
    // October: active, +90k advance, -2k fee
    const oct = rows.find((r) => r.ym === '2026-10')!
    expect(oct.fxDelta).toBe(88_000)
    expect(oct.fxActive).toBe(true)

    // November: reserve release +10k, reversal -90k
    const nov = rows.find((r) => r.ym === '2026-11')!
    expect(nov.fxDelta).toBe(-80_000)
    expect(nov.fxActive).toBe(false)

    // December: remaining reserve release -10k
    const dec = rows.find((r) => r.ym === '2026-12')!
    expect(dec.fxDelta).toBeCloseTo(-10_000, 4)
  })

  it('keeps monthly fees active when factoring starts before the horizon', () => {
    const settings: CashSettingsValues = {
      ...baseSettings,
      months: 3,
      factoring: {
        on: true,
        start: '2025-01',
        stop: '',
        eligible: 100_000,
        fee: 2,
        advance: 90,
      },
    }
    const rows = projectCash([checkin({ date: '2026-09-15' })], settings)
    expect(rows.every((r) => r.fxActive)).toBe(true)
    expect(rows[0].fxDelta).toBe(-2_000)
  })
})

describe('factoringSummary', () => {
  it('reports totals from the projected rows', () => {
    const settings: CashSettingsValues = {
      ...baseSettings,
      months: 4,
      factoring: {
        on: true,
        start: '2026-10',
        stop: '',
        eligible: 100_000,
        fee: 2,
        advance: 90,
      },
    }
    const rows = projectCash([checkin({ date: '2026-09-15' })], settings)
    const summary = factoringSummary(rows, settings)
    expect(summary.stepUp).toBe(100_000)
    expect(summary.advanceAmount).toBe(90_000)
    expect(summary.monthlyFee).toBe(2_000)
    expect(summary.endCash).toBe(rows[rows.length - 1].fxCash)
    expect(summary.baseEndCash).toBe(rows[rows.length - 1].cash)
    expect(summary.totalFees).toBe(2_000 * rows.filter((r) => r.fxActive).length)
  })
})

describe('normalizeCashSettings', () => {
  it('returns defaults for null, undefined, or invalid JSON', () => {
    expect(normalizeCashSettings(null)).toEqual(DEFAULT_CASH_SETTINGS)
    expect(normalizeCashSettings(undefined)).toEqual(DEFAULT_CASH_SETTINGS)
    expect(normalizeCashSettings('not json')).toEqual(DEFAULT_CASH_SETTINGS)
  })

  it('parses an AWSJSON string and preserves zero/false', () => {
    const input = {
      floor: 10_000,
      months: 1,
      runrate: {
        bcat: { fixed: 0, profit: 0 },
        ivan: { fixed: 60_000, profit: 20_000 },
        amazon: { fixed: 82_000, profit: 18_000 },
      },
      items: [],
      factoring: { on: false, start: '2026-10', stop: '', eligible: 0, fee: 0, advance: 90 },
    }
    const normalized = normalizeCashSettings(JSON.stringify(input))
    expect(normalized.floor).toBe(10_000)
    expect(normalized.months).toBe(3) // clamped
    expect(normalized.runrate.bcat.fixed).toBe(0)
    expect(normalized.runrate.bcat.profit).toBe(0)
    expect(normalized.factoring.on).toBe(false)
    expect(normalized.factoring.eligible).toBe(0)
    expect(normalized.items).toEqual([])
  })

  it('clamps months to 3..12', () => {
    expect(normalizeCashSettings({ ...DEFAULT_CASH_SETTINGS, months: 2 }).months).toBe(3)
    expect(normalizeCashSettings({ ...DEFAULT_CASH_SETTINGS, months: 24 }).months).toBe(12)
    expect(normalizeCashSettings({ ...DEFAULT_CASH_SETTINGS, months: 6 }).months).toBe(6)
  })
})

describe('validateCashCheckIn', () => {
  it('accepts a valid check-in', () => {
    const input = {
      date: '2026-09-15',
      cash: 100_000,
      ar: null,
      ap: undefined,
      bcatMtdProfit: 0,
      note: 'week one',
    }
    expect(validateCashCheckIn(input)).toMatchObject({
      date: '2026-09-15',
      cash: 100_000,
      ar: null,
      bcatMtdProfit: 0,
      note: 'week one',
    })
  })

  it('rejects invalid and impossible dates', () => {
    expect(() => validateCashCheckIn({ date: '2026-09-31', cash: 1 })).toThrow(/calendar date/)
    expect(() => validateCashCheckIn({ date: '09/15/2026', cash: 1 })).toThrow(/YYYY-MM-DD/)
  })

  it('rejects fractional money on cash and MTD fields', () => {
    expect(() => validateCashCheckIn({ date: '2026-09-15', cash: 100.5 })).toThrow(/whole dollars/)
    expect(() =>
      validateCashCheckIn({ date: '2026-09-15', cash: 100, bcatMtdProfit: 50.25 }),
    ).toThrow(/whole dollars/)
  })
})
