import { describe, it, expect } from 'vitest'

import {
  DEFAULT_MARGIN_TARGET_BPS,
  DEFAULT_REQUIRED_LOAD_FIELDS,
  marginBpsOf,
  missingRequiredFields,
  needsLine,
  resolveMargin,
  resolveRequiredFields,
  sellRateFromMarket,
  type RequiredFieldSubject,
} from './flowDefaults'

describe('the margin a quote is built with', () => {
  it('falls back to Ryne\'s 20% when nothing is configured at all', () => {
    const m = resolveMargin(null, null, 'FTL')
    expect(m.targetBps).toBe(DEFAULT_MARGIN_TARGET_BPS)
    expect(m.targetSource).toBe('BUILT_IN')
    expect(m.autoReply).toBe(false)
  })

  it('takes the org default over the built-in', () => {
    expect(resolveMargin({ marginTargetBps: 1800 }, null, 'FTL')).toMatchObject({ targetBps: 1800, targetSource: 'ORG' })
  })

  it('takes the per-mode org override over the plain org default', () => {
    const m = resolveMargin({ marginTargetBps: 2000, marginTargetBpsByMode: { LTL: 2600 } }, null, 'LTL')
    expect(m).toMatchObject({ targetBps: 2600, targetSource: 'ORG_MODE' })
  })

  it('takes the customer over every org answer', () => {
    const m = resolveMargin({ marginTargetBps: 2000, marginTargetBpsByMode: { LTL: 2600 } }, { marginTargetBps: 1200 }, 'LTL')
    expect(m).toMatchObject({ targetBps: 1200, targetSource: 'CUSTOMER' })
  })

  it('never lets the floor rise above the target — a floor that beats the target refuses its own price', () => {
    expect(resolveMargin({ marginFloorBps: 2500 }, { marginTargetBps: 1500 }, 'FTL').floorBps).toBe(1500)
  })

  it('ignores a nonsense margin rather than pricing with it', () => {
    expect(resolveMargin({ marginTargetBps: 12000 }, null, 'FTL').targetBps).toBe(DEFAULT_MARGIN_TARGET_BPS)
    expect(resolveMargin(null, { marginTargetBps: -500 }, 'FTL').targetBps).toBe(DEFAULT_MARGIN_TARGET_BPS)
  })

  it('lets a customer switch auto replies on while the org leaves them off', () => {
    expect(resolveMargin({ quoteAutoReplyDefault: false }, { quoteAutoReply: true }, 'FTL').autoReply).toBe(true)
    expect(resolveMargin({ quoteAutoReplyDefault: true }, { quoteAutoReply: false }, 'FTL').autoReply).toBe(false)
  })

  it('treats an unset override as inheritance, not as a zero margin', () => {
    // `Number(null)` is 0 and 0 is a legal margin, so this is the difference
    // between "use the org's 20%" and "this customer works for nothing".
    const m = resolveMargin({ marginTargetBps: 1800 }, { marginTargetBps: null, marginFloorBps: null }, 'FTL')
    expect(m).toMatchObject({ targetBps: 1800, targetSource: 'ORG' })
  })

  it('still honours an explicit zero target when somebody really means it', () => {
    expect(resolveMargin({ marginTargetBps: 1800 }, { marginTargetBps: 0 }, 'FTL'))
      .toMatchObject({ targetBps: 0, targetSource: 'CUSTOMER' })
  })
})

describe('turning a market number into a sell rate', () => {
  it('is a margin, not a markup: 20% on a $1,000 buy is $1,250', () => {
    expect(sellRateFromMarket(100000, 2000)).toBe(125000)
  })

  it('round-trips through the margin it was built with', () => {
    const sell = sellRateFromMarket(187300, 2200)
    expect(marginBpsOf(sell, 187300)).toBeGreaterThanOrEqual(2190)
    expect(marginBpsOf(sell, 187300)).toBeLessThanOrEqual(2210)
  })

  it('answers zero for a market that said nothing', () => {
    expect(sellRateFromMarket(0, 2000)).toBe(0)
  })
})

describe('the required-field list', () => {
  it('is Ryne\'s five when nobody has configured anything', () => {
    expect(resolveRequiredFields(null, null)).toEqual([...DEFAULT_REQUIRED_LOAD_FIELDS])
  })

  it('adds the customer\'s list and can never subtract from the org\'s', () => {
    const list = resolveRequiredFields(
      { defaultRequiredLoadFields: ['pickupAddress', 'billTo'] },
      { requiredLoadFields: ['poNumber', 'weight'] },
    )
    expect(list).toContain('pickupAddress')
    expect(list).toContain('billTo')
    expect(list).toContain('poNumber')
    expect(list).toContain('weight')
  })

  it('de-duplicates a field both lists name', () => {
    const list = resolveRequiredFields({ defaultRequiredLoadFields: ['billTo'] }, { requiredLoadFields: ['billTo'] })
    expect(list).toEqual(['billTo'])
  })
})

const complete: RequiredFieldSubject = {
  stops: [
    { type: 'pickup', city: 'Chicago', state: 'IL', appt: '2026-11-02T14:00:00Z' },
    { type: 'delivery', city: 'Dallas', state: 'TX', appt: '2026-11-04T14:00:00Z' },
  ],
  billToId: 'bt-1',
  salesRepId: 'rep.chen',
  revDivision: 'BROKERAGE',
  customerRateCents: 250000,
  equipmentType: 'VAN',
  references: { po: 'PO-99' },
  freight: { commodity: 'Paper', weightLbs: 42000 },
}

describe('what a shipment still needs', () => {
  it('reports nothing when every required field is filled', () => {
    expect(missingRequiredFields(complete, DEFAULT_REQUIRED_LOAD_FIELDS)).toEqual([])
  })

  it('names each of the org five when it is empty', () => {
    const bare: RequiredFieldSubject = { stops: [] }
    expect(missingRequiredFields(bare, DEFAULT_REQUIRED_LOAD_FIELDS)).toEqual([
      'pickupAddress', 'deliveryAddress', 'billTo', 'salesRep', 'revenueDivision',
    ])
  })

  it('needs a pickup address when one stop of two has no city', () => {
    const subject = { ...complete, stops: [{ type: 'pickup', city: '', state: 'IL' }, ...complete.stops!.slice(1)] }
    expect(missingRequiredFields(subject, ['pickupAddress'])).toEqual(['pickupAddress'])
  })

  it('accepts a carrier team in place of a carrier rep', () => {
    expect(missingRequiredFields({ ...complete, carrierTeamKey: 'coverage-a' }, ['carrierRep'])).toEqual([])
    expect(missingRequiredFields(complete, ['carrierRep'])).toEqual(['carrierRep'])
  })

  it('reports a field this build does not know rather than passing it silently', () => {
    expect(missingRequiredFields(complete, ['notAFieldAnybodyAdded'])).toEqual(['notAFieldAnybodyAdded'])
  })

  it('writes the Needs: line in the labels a person reads', () => {
    expect(needsLine(['billTo', 'salesRep'])).toBe('Needs: Bill-to party, Sales rep')
    expect(needsLine([])).toBe('')
  })
})
