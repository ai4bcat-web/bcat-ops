import { describe, expect, it } from 'vitest'
import {
  CONSOLIDATION_CATEGORIES,
  evaluateConsolidation,
  validateConsolidationRules,
} from './consolidation'

describe('CONSOLIDATION_CATEGORIES', () => {
  it('contains the eight categories from the plan', () => {
    const keys = CONSOLIDATION_CATEGORIES.map((c) => c.key)
    expect(keys).toEqual([
      'CUSTOMER_MISMATCH',
      'TEMPERATURE',
      'WEIGHT_TOTAL',
      'STOP_COUNT',
      'PICKUP_WINDOW_DAYS',
      'EQUIPMENT_MISMATCH',
      'HAZMAT',
      'ON_HOLD',
    ])
  })
})

describe('validateConsolidationRules', () => {
  it('fills missing categories with OFF', () => {
    const rules = validateConsolidationRules({ rules: [{ category: 'CUSTOMER_MISMATCH', severity: 'BLOCK' }] })
    expect(rules.rules.find((r) => r.category === 'CUSTOMER_MISMATCH')?.severity).toBe('BLOCK')
    expect(rules.rules.find((r) => r.category === 'WEIGHT_TOTAL')?.severity).toBe('OFF')
  })

  it('refuses an unknown category', () => {
    expect(() => validateConsolidationRules({ rules: [{ category: 'FAKE', severity: 'BLOCK' }] }))
      .toThrow('not a consolidation category')
  })

  it('refuses two rules for the same category', () => {
    expect(() => validateConsolidationRules({
      rules: [
        { category: 'CUSTOMER_MISMATCH', severity: 'BLOCK' },
        { category: 'CUSTOMER_MISMATCH', severity: 'WARN' },
      ],
    })).toThrow('appears twice')
  })

  it('refuses a threshold in the wrong unit', () => {
    expect(() => validateConsolidationRules({
      rules: [{ category: 'WEIGHT_TOTAL', severity: 'BLOCK' }],
    })).toThrow('needs a threshold in pounds')
  })

  it('refuses an invalid unit', () => {
    expect(() => validateConsolidationRules({
      rules: [{ category: 'WEIGHT_TOTAL', severity: 'BLOCK', threshold: 1000, unit: 'stops' }],
    })).toThrow('unit must be pounds')
  })

  it('validates hazmat and on-hold fields', () => {
    expect(() => validateConsolidationRules({ hazmatMode: 'BAD' }))
      .toThrow('Hazmat mode must be NEVER, SAME_CLASS or ALLOW')
    expect(() => validateConsolidationRules({ onHold: 'IGNORE' }))
      .toThrow('On-hold handling must be BLOCK or WARN')
  })
})

describe('evaluateConsolidation', () => {
  const baseRules = validateConsolidationRules({
    rules: [
      { category: 'CUSTOMER_MISMATCH', severity: 'BLOCK' },
      { category: 'WEIGHT_TOTAL', severity: 'WARN', threshold: 10000, unit: 'pounds' },
      { category: 'STOP_COUNT', severity: 'OFF', threshold: 10, unit: 'stops' },
      { category: 'EQUIPMENT_MISMATCH', severity: 'WARN' },
      { category: 'ON_HOLD', severity: 'BLOCK' },
    ],
    hazmatMode: 'NEVER',
    onHold: 'BLOCK',
  })

  it('returns no reasons for a single shipment', () => {
    const result = evaluateConsolidation([{ customerId: 'c1' }], baseRules)
    expect(result.blocks).toHaveLength(0)
    expect(result.warns).toHaveLength(0)
  })

  it('BLOCK customer mismatch returns a reason', () => {
    const shipments = [{ customerId: 'c1' }, { customerId: 'c2' }]
    const result = evaluateConsolidation(shipments, baseRules)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].category).toBe('CUSTOMER_MISMATCH')
    expect(result.warns).toHaveLength(0)
  })

  it('WARN weight total does not block', () => {
    const shipments = [{ weightPounds: 6000 }, { weightPounds: 5000 }]
    const result = evaluateConsolidation(shipments, baseRules)
    expect(result.blocks).toHaveLength(0)
    expect(result.warns).toHaveLength(1)
    expect(result.warns[0].category).toBe('WEIGHT_TOTAL')
  })

  it('OFF rule returns nothing', () => {
    const shipments = [{ stopCount: 20 }, { stopCount: 20 }]
    const result = evaluateConsolidation(shipments, baseRules)
    expect(result.warns.find((r) => r.category === 'STOP_COUNT')).toBeUndefined()
  })

  it('takes no AR state and returns no AR output', () => {
    // The function signature is the invariant: no AR input, no AR output.
    const shipments = [{ customerId: 'c1', onHold: true }, { customerId: 'c1' }]
    const result = evaluateConsolidation(shipments, baseRules)
    expect(result).toEqual(expect.objectContaining({ blocks: expect.any(Array), warns: expect.any(Array) }))
    expect('arStatus' in result).toBe(false)
  })
})
