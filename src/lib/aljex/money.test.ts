import { describe, expect, it } from 'vitest'
import { formatCents, MAX_CENTS, moneyCents, parseMoney } from './money'

describe('parseMoney', () => {
  const ok: Array<[string, number]> = [
    ['0', 0],
    ['0.00', 0],
    ['1', 100],
    ['12.5', 1250],
    ['12.50', 1250],
    ['$1,234.50', 123450],
    ['1,234,567.89', 123456789],
    ['(12.00)', -1200],
    ['12.00-', -1200],
    ['-12.00', -1200],
    ['+7.10', 710],
    ['.5', 50],
    ['5.', 500],
    ['-0.00', 0],
    ['  $ 3.07 ', 307],
    ['12.500', 1250],
    // values that float arithmetic gets wrong when done as Math.round(x * 100)
    ['1.005', 101],
    ['8.325', 833],
    ['0.29', 29],
    ['19.99', 1999],
    ['4,352,069.01', 435206901],
  ]
  it.each(ok)('%s -> %i cents', (text, cents) => {
    expect(parseMoney(text).cents).toBe(cents)
  })

  it('flags rounding of more than two decimals (and not a zero remainder)', () => {
    expect(parseMoney('12.504')).toEqual({ cents: 1250, flag: 'ROUNDED' })
    expect(parseMoney('12.505')).toEqual({ cents: 1251, flag: 'ROUNDED' })
    expect(parseMoney('-12.505')).toEqual({ cents: -1251, flag: 'ROUNDED' })
    expect(parseMoney('12.500').flag).toBeUndefined()
  })

  it('treats blank as absent, a bare $ as the placeholder, and junk as invalid', () => {
    expect(parseMoney('')).toEqual({ cents: null })
    expect(parseMoney('  ')).toEqual({ cents: null })
    expect(parseMoney('$')).toEqual({ cents: null, flag: 'PLACEHOLDER' })
    for (const bad of ['abc', '1.2.3', '12,34', '1,2345', '--5', '$$5', '1e5', '12 34x']) {
      expect(parseMoney(bad)).toEqual({ cents: null, flag: 'INVALID' })
    }
  })

  it('refuses a value above the AppSync Int ceiling', () => {
    expect(parseMoney(formatCents(MAX_CENTS)).cents).toBe(MAX_CENTS)
    expect(parseMoney('21,474,836.48')).toEqual({ cents: null, flag: 'OVERFLOW' })
  })

  it('moneyCents counts absent values as 0 for sums', () => {
    expect(moneyCents('')).toBe(0)
    expect(moneyCents('$')).toBe(0)
    expect(moneyCents('(1.00)')).toBe(-100)
  })

  it('formatCents round-trips', () => {
    for (const c of [0, 5, -5, 100, 123456789, -987654321]) expect(parseMoney(formatCents(c)).cents).toBe(c)
  })
})
