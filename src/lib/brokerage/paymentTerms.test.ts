import { describe, expect, it } from 'vitest'
import { defaultTermFor, netDueDate, termByKey, validatePaymentTerms } from './paymentTerms'

describe('validatePaymentTerms', () => {
  it('accepts a valid catalog', () => {
    const terms = validatePaymentTerms([
      { key: 'net-30', name: 'Net 30', days: 30, description: 'Net 30 days' },
      { key: 'qp-10', name: 'Quick pay 10', days: 10, quickPayFeeBps: 150 },
    ])
    expect(terms).toHaveLength(2)
    expect(terms[1].quickPayFeeBps).toBe(150)
  })

  it('refuses a float fee', () => {
    expect(() => validatePaymentTerms([{ key: 'bad', name: 'Bad', days: 30, quickPayFeeBps: 1.5 }]))
      .toThrow('quick-pay fee must be a whole number')
  })

  it('refuses days outside 0..180', () => {
    expect(() => validatePaymentTerms([{ key: 'bad', name: 'Bad', days: -1 }]))
      .toThrow('days must be between 0 and 180')
    expect(() => validatePaymentTerms([{ key: 'bad', name: 'Bad', days: 181 }]))
      .toThrow('days must be between 0 and 180')
  })

  it('refuses two terms with the same key', () => {
    expect(() => validatePaymentTerms([
      { key: 'net-30', name: 'Net 30', days: 30 },
      { key: 'net-30', name: 'Net 30 again', days: 30 },
    ])).toThrow('Payment term key "net-30" is used twice')
  })

  it('refuses a doNotUse default term', () => {
    expect(() => validatePaymentTerms(
      [{ key: 'net-30', name: 'Net 30', days: 30, doNotUse: true }],
      { defaultPaymentTermsDays: 30 },
    )).toThrow('cannot be marked do not use')
  })

  it('slugifies keys from names when omitted', () => {
    const [term] = validatePaymentTerms([{ name: 'Net 30 Days', days: 30 }])
    expect(term.key).toBe('net-30-days')
  })

  it('accepts an empty list and null', () => {
    expect(validatePaymentTerms([])).toEqual([])
    expect(validatePaymentTerms(null)).toEqual([])
  })
})

describe('termByKey', () => {
  it('finds a term case-insensitively', () => {
    const terms = [{ key: 'net-30', name: 'Net 30', days: 30 }]
    expect(termByKey(terms, 'NET-30')).toEqual(terms[0])
    expect(termByKey(terms, 'missing')).toBeNull()
  })
})

describe('defaultTermFor', () => {
  it('uses the customer days when present', () => {
    const terms = [
      { key: 'net-15', name: 'Net 15', days: 15 },
      { key: 'net-30', name: 'Net 30', days: 30 },
    ]
    expect(defaultTermFor({ paymentTermsDays: 15 }, { paymentTerms: terms })?.key).toBe('net-15')
  })

  it('falls back to the first usable term', () => {
    const terms = [{ key: 'net-30', name: 'Net 30', days: 30 }]
    expect(defaultTermFor({}, { paymentTerms: terms })?.key).toBe('net-30')
  })

  it('skips doNotUse terms', () => {
    const terms = [
      { key: 'net-30', name: 'Net 30', days: 30, doNotUse: true },
      { key: 'net-15', name: 'Net 15', days: 15 },
    ]
    expect(defaultTermFor({}, { paymentTerms: terms })?.key).toBe('net-15')
  })
})

describe('netDueDate', () => {
  it('crosses a month end', () => {
    expect(netDueDate('2026-10-29', { days: 5 })).toBe('2026-11-03')
  })

  it('handles zero days', () => {
    expect(netDueDate('2026-10-29', { days: 0 })).toBe('2026-10-29')
  })
})
