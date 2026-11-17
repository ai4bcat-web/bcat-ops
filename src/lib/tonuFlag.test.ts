import { describe, expect, it } from 'vitest'
import { parseTonuFlag, tonuSummary, tonuTooltip, validateTonuInput } from './tonuFlag'

describe('tonuFlag', () => {
  it('accepts an empty flag, trims the note and rounds the amount to cents', () => {
    expect(validateTonuInput({})).toEqual({ note: null, amount: null })
    expect(validateTonuInput({ note: '  Shipper cancelled  ', amount: '250.456' })).toEqual({ note: 'Shipper cancelled', amount: 250.46 })
  })
  it('refuses a bad amount, a long note and a non-object', () => {
    expect(() => validateTonuInput({ amount: -5 })).toThrow('amount')
    expect(() => validateTonuInput({ amount: 'abc' })).toThrow('amount')
    expect(() => validateTonuInput({ note: 'x'.repeat(501) })).toThrow('too long')
    expect(() => validateTonuInput(null)).toThrow('send the flag details')
  })
  it('parses the stored object, the JSON string AppSync returns, and nothing else', () => {
    const flag = { amount: 250, flaggedAt: '2026-11-16T10:00:00.000Z', flaggedBy: 'a@b.c' }
    expect(parseTonuFlag(flag)).toEqual(flag)
    expect(parseTonuFlag(JSON.stringify(flag))).toEqual(flag)
    expect(parseTonuFlag(null)).toBeNull()
    expect(parseTonuFlag('nope')).toBeNull()
    expect(parseTonuFlag({ note: 'no stamp' })).toBeNull()
  })
  it('words the summary and the hover text', () => {
    const flag = { note: 'Dock closed', amount: 250, flaggedAt: '2026-11-16T10:00:00.000Z', flaggedBy: 'a@b.c' }
    expect(tonuSummary(flag)).toBe('TONU · $250')
    expect(tonuSummary({ ...flag, amount: null })).toBe('TONU')
    expect(tonuTooltip(flag, (iso) => iso)).toBe('Waiting for TONU ($250)\nDock closed\nFlagged by a@b.c · 2026-11-16T10:00:00.000Z')
  })
})
