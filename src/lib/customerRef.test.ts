import { describe, it, expect } from 'vitest'
import { customerRefOf, poReferenceOf } from './customerRef'

describe('customerRefOf', () => {
  it('reads the PO reference first (the shipment form header, 20041)', () => {
    expect(customerRefOf([
      { code: 'pickup', value: '261291', visibility: 'ALL' },
      { code: 'PO', value: '132630885', visibility: 'CUSTOMER' },
    ], '132630885')).toBe('132630885')
  })

  it('then the Aljex import Customer Ref reference', () => {
    expect(customerRefOf([
      { code: 'ALJEX_TYPE', value: 'FTL', visibility: 'INTERNAL' },
      { code: 'CUSTOMER_REF', value: '8570386', visibility: 'ALL' },
    ], 'OTHER')).toBe('8570386')
  })

  it('then the load tmsId when the order carries no reference (14934, 20000)', () => {
    expect(customerRefOf([], '0359403')).toBe('0359403')
    expect(customerRefOf(null, 'M371205')).toBe('M371205')
  })

  it('never returns an internal, carrier or stop reference, or N/A', () => {
    expect(customerRefOf([
      { code: 'PO', value: 'OURS', visibility: 'INTERNAL' },
      { code: 'PO', value: 'CARRIER-ONLY', visibility: 'CARRIER' },
      { code: 'PO', value: 'STOP-PO', visibility: 'ALL', level: 'STOP' },
    ], 'N/A')).toBeNull()
  })

  it('poReferenceOf reads only the PO codes', () => {
    expect(poReferenceOf([{ code: 'CUSTOMER_REF', value: 'X', visibility: 'ALL' }])).toBeNull()
    expect(poReferenceOf([{ code: 'customer_po', value: ' 77 ', visibility: 'ALL' }])).toBe('77')
  })
})
