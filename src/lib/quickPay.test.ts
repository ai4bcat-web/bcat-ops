import { describe, it, expect } from 'vitest'
import {
  DEFAULT_QUICK_PAY_TIERS,
  normalizeQuickPayTiers,
  quickPayFee,
  quickPayTiersOf,
  tierFor,
} from './quickPay'

describe('tierFor', () => {
  it('matches a day count exactly and never rounds onto a neighbouring rung', () => {
    expect(tierFor(7)).toEqual({ days: 7, feeBps: 250 })
    expect(tierFor(10)).toBeNull()
  })

  it('reads the ladder it is given rather than the default one', () => {
    expect(tierFor(2, [{ days: 2, feeBps: 400 }])).toEqual({ days: 2, feeBps: 400 })
    expect(tierFor(7, [{ days: 2, feeBps: 400 }])).toBeNull()
  })
})

describe('quickPayFee', () => {
  it('rounds half up at a true half-cent', () => {
    expect(quickPayFee(1, 5000)).toBe(1)
    expect(quickPayFee(3, 5000)).toBe(2)
  })

  it('takes nothing at a zero rate', () => {
    expect(quickPayFee(0, 300)).toBe(0)
    expect(quickPayFee(250_000, 0)).toBe(0)
  })

  it('charges the basis points off the rate', () => {
    expect(quickPayFee(250_000, 250)).toBe(6_250)
  })

  it('refuses a fee outside 0 to 10000 basis points', () => {
    expect(() => quickPayFee(250_000, 10_001)).toThrow(/basis points/)
    expect(() => quickPayFee(250_000, -1)).toThrow(/basis points/)
  })

  it('refuses a rate that is not whole cents, or negative', () => {
    expect(() => quickPayFee(250_000.5, 250)).toThrow(/whole number of cents/)
    expect(() => quickPayFee(-1, 250)).toThrow(/negative/)
  })
})

describe('normalizeQuickPayTiers', () => {
  it('sorts the ladder ascending by days', () => {
    expect(
      normalizeQuickPayTiers([
        { days: 21, feeBps: 150 },
        { days: 1, feeBps: 300 },
        { days: 7, feeBps: 250 },
      ]),
    ).toEqual([
      { days: 1, feeBps: 300 },
      { days: 7, feeBps: 250 },
      { days: 21, feeBps: 150 },
    ])
  })

  it('refuses the same day priced twice', () => {
    expect(() =>
      normalizeQuickPayTiers([
        { days: 7, feeBps: 250 },
        { days: 7, feeBps: 200 },
      ]),
    ).toThrow(/repeat/)
  })

  it('refuses a fee outside 0 to 10000 basis points', () => {
    expect(() => normalizeQuickPayTiers([{ days: 7, feeBps: 10_001 }])).toThrow(/basis points/)
    expect(() => normalizeQuickPayTiers([{ days: 7, feeBps: -1 }])).toThrow(/basis points/)
  })

  it('refuses a ladder where waiting longer costs more', () => {
    expect(() =>
      normalizeQuickPayTiers([
        { days: 7, feeBps: 200 },
        { days: 21, feeBps: 250 },
      ]),
    ).toThrow(/longer wait must never cost more/)
  })

  it('refuses days that are not whole numbers of one or more', () => {
    expect(() => normalizeQuickPayTiers([{ days: 0, feeBps: 300 }])).toThrow(/days/)
    expect(() => normalizeQuickPayTiers([{ days: 1.5, feeBps: 300 }])).toThrow(/days/)
  })

  it('refuses anything that is not a list of one to twenty rungs', () => {
    expect(() => normalizeQuickPayTiers(null)).toThrow(/list/)
    expect(() => normalizeQuickPayTiers([])).toThrow(/1 and 20/)
  })
})

describe('quickPayTiersOf', () => {
  it('falls back to the default ladder when the org has none', () => {
    expect(quickPayTiersOf(null)).toEqual([...DEFAULT_QUICK_PAY_TIERS])
    expect(quickPayTiersOf({ quickPayTiers: null })).toEqual([...DEFAULT_QUICK_PAY_TIERS])
  })

  it('returns the org ladder sorted, and never throws on a stored ladder gone bad', () => {
    expect(
      quickPayTiersOf({
        quickPayTiers: [
          { days: 14, feeBps: 200 },
          { days: 2, feeBps: 350 },
        ],
      }),
    ).toEqual([
      { days: 2, feeBps: 350 },
      { days: 14, feeBps: 200 },
    ])
    expect(quickPayTiersOf({ quickPayTiers: [{ days: 0, feeBps: 99_999 }] })).toEqual([
      ...DEFAULT_QUICK_PAY_TIERS,
    ])
  })
})
