import { describe, it, expect } from 'vitest'
import { emptyValues } from '../model'
import { marginTone, ratesSummary } from './ratesSummary'

describe('marginTone', () => {
  it('is green at the target, amber within 5 points under it, red further down', () => {
    expect(marginTone(20, 20)).toBe('green')
    expect(marginTone(15, 20)).toBe('amber')
    expect(marginTone(14.9, 20)).toBe('red')
  })
})

describe('ratesSummary', () => {
  it('prices Net and Profit % from the Rates card inputs', () => {
    const v = emptyValues()
    v.rates.customer.lhRate = '1000'
    v.rates.carrier.lhRate = '800'
    const s = ratesSummary(v, null, null)
    expect(s).toMatchObject({ customerTotalCents: 100000, carrierTotalCents: 80000, netCents: 20000, profitPct: 20, priced: true, tone: 'green' })
  })

  it('is not priced until the customer has a rate', () => {
    expect(ratesSummary(emptyValues(), null, null).priced).toBe(false)
  })
})
