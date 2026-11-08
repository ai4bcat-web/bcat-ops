import { describe, it, expect } from 'vitest'
import { invoiceSeriesStartProblem } from './invoiceSeries'

describe('invoiceSeriesStartProblem', () => {
  const state = { counter: 1500, maxImported: 14912 }

  it('accepts nothing typed and a start above both the counter and every imported number', () => {
    expect(invoiceSeriesStartProblem('', state)).toBeNull()
    expect(invoiceSeriesStartProblem('20000', state)).toBeNull()
    expect(invoiceSeriesStartProblem('14913', state)).toBeNull()
  })

  it('refuses a start that would reach back over an imported invoice number', () => {
    expect(invoiceSeriesStartProblem('14912', state)).toMatch(/up to 14912/)
    expect(invoiceSeriesStartProblem('9000', state)).toMatch(/up to 14912/)
  })

  it('refuses a start at or below the numbers already issued by the counter', () => {
    expect(invoiceSeriesStartProblem('1000', { counter: 1500, maxImported: null })).toMatch(/already at 1500/)
    // counter is last-issued: starting at counter + 1 is the first free number
    expect(invoiceSeriesStartProblem('1501', { counter: 1500, maxImported: null })).toBeNull()
    expect(invoiceSeriesStartProblem('1500', { counter: 1500, maxImported: null })).toMatch(/already at 1500/)
  })

  it('refuses anything that is not a whole positive number', () => {
    for (const bad of ['abc', '-5', '20000.5', '0', '2e4']) {
      expect(invoiceSeriesStartProblem(bad, state)).toBe('Enter a whole number of 1 or more.')
    }
  })
})
