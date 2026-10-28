import { describe, it, expect } from 'vitest'
import {
  chargeAmount,
  computeFinancials,
  isRateCode,
  priceCharges,
  rateBaseCents,
} from './shipmentCharges'
import type { ChargeLineInput } from './shipmentCharges'
import type { PricingDefaults } from '@/types/tms'

const line = (over: Partial<ChargeLineInput> = {}): ChargeLineInput => ({
  side: 'CUSTOMER',
  code: 'LINEHAUL',
  calculatedBy: 'FLAT',
  rateCents: 100_000,
  isRate: true,
  ...over,
})

describe('chargeAmount', () => {
  it('multiplies a flat rate by its count, defaulting the count to one', () => {
    expect(chargeAmount(line({ calculatedBy: 'FLAT', rateCents: 25_000, count: 3 }))).toBe(75_000)
    expect(chargeAmount(line({ calculatedBy: 'FLAT', rateCents: 25_000 }))).toBe(25_000)
    expect(chargeAmount(line({ calculatedBy: 'FLAT', rateCents: 25_000, count: null }))).toBe(25_000)
  })

  it('multiplies a per-mile rate by the miles, ignoring the count', () => {
    expect(chargeAmount(line({ calculatedBy: 'PER_MILE', rateCents: 250, count: 7 }), { miles: 412 })).toBe(103_000)
  })

  it('charges per hundredweight, rounding to the cent', () => {
    // $12.50/cwt on 42,350 lb = 423.5 cwt × 1250 = 529,375 cents exactly.
    expect(chargeAmount(line({ calculatedBy: 'PER_CWT', rateCents: 1250 }), { weightLbs: 42_350 })).toBe(529_375)
    // 1 lb at $9.99/cwt is 9.99 cents — a half-cent case that must not drift.
    expect(chargeAmount(line({ calculatedBy: 'PER_CWT', rateCents: 999 }), { weightLbs: 1 })).toBe(10)
  })

  it('takes a percentage of the side rate base in basis points', () => {
    expect(chargeAmount(line({ calculatedBy: 'PERCENT', rateCents: 1500 }), { sideRateBaseCents: 200_000 })).toBe(30_000)
  })

  it('treats a missing measurement as zero rather than NaN', () => {
    expect(chargeAmount(line({ calculatedBy: 'PER_MILE', rateCents: 250 }))).toBe(0)
    expect(chargeAmount(line({ calculatedBy: 'PER_CWT', rateCents: 250 }))).toBe(0)
    expect(chargeAmount(line({ calculatedBy: 'PERCENT', rateCents: 250 }))).toBe(0)
  })
})

describe('rateBaseCents', () => {
  const lines = [
    line({ code: 'LINEHAUL', rateCents: 200_000, isRate: true }),
    line({ code: 'FSC', calculatedBy: 'PER_MILE', rateCents: 100, isRate: true }),
    line({ code: 'DETENTION', rateCents: 15_000, isRate: false }),
    line({ side: 'CARRIER', code: 'LINEHAUL', rateCents: 170_000, isRate: true }),
  ]

  it('sums only the rate lines on the side asked for', () => {
    expect(rateBaseCents(lines, 'CUSTOMER', { miles: 400 })).toBe(240_000)
    expect(rateBaseCents(lines, 'CARRIER', { miles: 400 })).toBe(170_000)
  })

  it('leaves a percentage line out of the base it is a percentage of', () => {
    const circular = [...lines, line({ code: 'FSC', calculatedBy: 'PERCENT', rateCents: 2500, isRate: true })]
    expect(rateBaseCents(circular, 'CUSTOMER', { miles: 400 })).toBe(240_000)
  })
})

describe('priceCharges', () => {
  it('prices each percentage line against its own side rate', () => {
    const priced = priceCharges([
      line({ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 200_000, isRate: true }),
      line({ side: 'CUSTOMER', code: 'FSC', calculatedBy: 'PERCENT', rateCents: 1000, isRate: false }),
      line({ side: 'CARRIER', code: 'LINEHAUL', rateCents: 150_000, isRate: true }),
      line({ side: 'CARRIER', code: 'FSC', calculatedBy: 'PERCENT', rateCents: 1000, isRate: false }),
    ])
    expect(priced.map((p) => p.amountCents)).toEqual([200_000, 20_000, 150_000, 15_000])
  })
})

describe('computeFinancials', () => {
  const shipmentLines = [
    line({ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 200_000, isRate: true }),
    line({ side: 'CUSTOMER', code: 'FSC', rateCents: 40_000, isRate: true }),
    line({ side: 'CUSTOMER', code: 'DETENTION', rateCents: 10_000, isRate: false }),
    line({ side: 'CARRIER', code: 'LINEHAUL', rateCents: 150_000, isRate: true }),
    line({ side: 'CARRIER', code: 'FSC', rateCents: 30_000, isRate: true }),
    line({ side: 'CARRIER', code: 'LUMPER', rateCents: 5_000, isRate: false }),
  ]

  it('splits rate from revenue on each side and derives profit and margin', () => {
    const t = computeFinancials(shipmentLines)
    expect(t.customerRateCents).toBe(240_000)
    expect(t.revenueCents).toBe(250_000)
    expect(t.carrierRateCents).toBe(180_000)
    expect(t.costCents).toBe(185_000)
    expect(t.profitCents).toBe(65_000)
    expect(t.marginBps).toBe(2600)
  })

  it('reports zero margin at zero revenue instead of dividing by it', () => {
    const t = computeFinancials([line({ side: 'CARRIER', code: 'LINEHAUL', rateCents: 50_000, isRate: true })])
    expect(t.revenueCents).toBe(0)
    expect(t.profitCents).toBe(-50_000)
    expect(t.marginBps).toBe(0)
  })

  it('keeps the returned lines aligned with the input rows', () => {
    const t = computeFinancials(shipmentLines)
    expect(t.lines).toHaveLength(shipmentLines.length)
    expect(t.lines.map((l) => l.code)).toEqual(shipmentLines.map((l) => l.code))
    expect(t.lines[2].amountCents).toBe(10_000)
  })

  describe('top spend', () => {
    it('leaves the org margin floor on the table', () => {
      const t = computeFinancials(shipmentLines, {}, null, 1500)
      expect(t.topSpendCents).toBe(250_000 - 37_500)
    })

    it('prefers an explicit minimum profit over the percentage floor', () => {
      const pricing: PricingDefaults = { mode: 'MARGIN', defaultBps: 2000, minProfitCents: 15_000 }
      const t = computeFinancials(shipmentLines, {}, pricing, 1500)
      expect(t.topSpendCents).toBe(235_000)
    })

    it('is the whole revenue when no floor is configured', () => {
      expect(computeFinancials(shipmentLines).topSpendCents).toBe(250_000)
    })
  })

  describe('target buy', () => {
    it('takes the margin off the sell price in MARGIN mode', () => {
      const pricing: PricingDefaults = { mode: 'MARGIN', defaultBps: 2000 }
      expect(computeFinancials(shipmentLines, {}, pricing).targetBuyCents).toBe(200_000)
    })

    it('backs the markup out of the sell price in MARKUP mode', () => {
      const pricing: PricingDefaults = { mode: 'MARKUP', defaultBps: 2500 }
      // 250,000 ÷ 1.25 — buying here and marking up 25% returns the sell price.
      expect(computeFinancials(shipmentLines, {}, pricing).targetBuyCents).toBe(200_000)
    })

    it('subtracts a flat spread in PROFIT mode', () => {
      const pricing: PricingDefaults = { mode: 'PROFIT', defaultProfitCents: 45_000 }
      expect(computeFinancials(shipmentLines, {}, pricing).targetBuyCents).toBe(205_000)
    })

    it('is blank rather than the full revenue when the mode has no default', () => {
      expect(computeFinancials(shipmentLines, {}, { mode: 'MARGIN' }).targetBuyCents).toBeNull()
      expect(computeFinancials(shipmentLines, {}, { mode: 'MARKUP' }).targetBuyCents).toBeNull()
      expect(computeFinancials(shipmentLines, {}, { mode: 'PROFIT' }).targetBuyCents).toBeNull()
      expect(computeFinancials(shipmentLines).targetBuyCents).toBeNull()
    })
  })

  it('measures per-mile and per-cwt lines against the shipment context', () => {
    const t = computeFinancials(
      [
        line({ side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'PER_MILE', rateCents: 500, isRate: true }),
        line({ side: 'CUSTOMER', code: 'FSC', calculatedBy: 'PERCENT', rateCents: 1200, isRate: false }),
        line({ side: 'CARRIER', code: 'LINEHAUL', calculatedBy: 'PER_CWT', rateCents: 400, isRate: true }),
      ],
      { miles: 400, weightLbs: 40_000 },
    )
    expect(t.customerRateCents).toBe(200_000)
    expect(t.revenueCents).toBe(224_000)
    expect(t.costCents).toBe(160_000)
  })
})

describe('isRateCode', () => {
  it('counts linehaul and fuel surcharge, case-insensitively, and nothing else', () => {
    expect(isRateCode('LINEHAUL')).toBe(true)
    expect(isRateCode('fsc')).toBe(true)
    expect(isRateCode('DETENTION')).toBe(false)
  })
})
