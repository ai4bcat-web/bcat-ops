import { describe, expect, it } from 'vitest'
import { customerFactorFlag, customerMcRequiredError, factorGapsAtCreate, factorGapsError, factorGapsForLoad, factorGapSummary, orderPoNumber, routeEnds } from './factorReadyAtCreate'
import { isFactorBilled } from './factorBilling'
import type { Stop } from '../types'

const full = {
  customer: { name: 'ACME', billingMethod: 'FACTOR' as const, factored: null, mcNumber: '123456', customerType: 'BROKER' as const },
  poNumber: 'PO-1',
  customerRateCents: 150000,
  pickup: { city: 'Chicago', state: 'IL', zip: '60601' },
  delivery: { city: 'Dallas', state: 'TX', zip: '75201' },
}

describe('factorGapsAtCreate', () => {
  it('passes a load with everything OTR needs', () => {
    expect(factorGapsAtCreate(full)).toEqual([])
    expect(factorGapsError([])).toBeNull()
  })

  it('names each missing field', () => {
    const codes = factorGapsAtCreate({
      ...full,
      customer: { ...full.customer, mcNumber: '' },
      poNumber: '',
      customerRateCents: 0,
      pickup: { city: 'Chicago', state: 'Illinois', zip: '' },
      delivery: null,
    }).map((g) => g.code)
    expect(codes).toEqual(['CUSTOMER_MC', 'PO_MISSING', 'RATE_MISSING', 'PICKUP_STATE', 'PICKUP_ZIP', 'DELIVERY_CITY', 'DELIVERY_STATE', 'DELIVERY_ZIP'])
  })

  it('a manually billed customer needs no MC; an unset billing method is a gap', () => {
    expect(factorGapsAtCreate({ ...full, customer: { ...full.customer, billingMethod: 'MANUAL', mcNumber: null } })).toEqual([])
    expect(factorGapsAtCreate({ ...full, customer: { ...full.customer, billingMethod: null } }).map((g) => g.code)).toEqual(['BILLING_METHOD'])
  })

  it('only a broker needs an MC: a factored shipper or an unset type does not (Ryne 2026-11-14)', () => {
    const noMc = { ...full.customer, mcNumber: '' }
    expect(factorGapsAtCreate({ ...full, customer: { ...noMc, customerType: 'BROKER' } }).map((g) => g.code)).toEqual(['CUSTOMER_MC'])
    expect(factorGapsAtCreate({ ...full, customer: { ...noMc, customerType: 'SHIPPER' } })).toEqual([])
    expect(factorGapsAtCreate({ ...full, customer: { ...noMc, customerType: null } })).toEqual([])
  })

  it('skips the customer checks when only a typed name exists', () => {
    expect(factorGapsAtCreate({ ...full, customer: null })).toEqual([])
  })

  it('the server error lists every message', () => {
    expect(factorGapsError(factorGapsAtCreate({ ...full, poNumber: null }))).toMatch(/^Not ready to factor: Enter the customer ref \(PO\)/)
  })
})

describe('isFactorBilled', () => {
  it('billing method FACTOR or the older factored flag; MANUAL never', () => {
    expect(isFactorBilled({ billingMethod: 'FACTOR', factored: null })).toBe(true)
    expect(isFactorBilled({ billingMethod: 'FACTOR', factored: false })).toBe(true)
    expect(isFactorBilled({ billingMethod: null, factored: true })).toBe(true)
    expect(isFactorBilled({ billingMethod: 'MANUAL', factored: true })).toBe(false)
    expect(isFactorBilled({ billingMethod: null, factored: null })).toBe(false)
  })
})

describe('orderPoNumber / routeEnds', () => {
  it('reads a customer-visible PO only', () => {
    expect(orderPoNumber([{ code: 'PO', value: 'X', visibility: 'INTERNAL' }, { code: 'po', value: ' 77 ', visibility: 'CUSTOMER' }])).toBe('77')
    expect(orderPoNumber([])).toBeNull()
  })

  it('first pick up and last delivery, from the address or the city label', () => {
    const stops = [
      { id: 'a', type: 'pickup', sequence: 0, city: 'MESA, AZ', address: { zip: '85201' } },
      { id: 'b', type: 'delivery', sequence: 1, address: { city: 'Reno', state: 'nv', zip: '89501-1234' } },
      { id: 'c', type: 'delivery', sequence: 2, address: { city: 'Boise', state: 'ID', zip: '83702' } },
    ] as unknown as Stop[]
    expect(routeEnds(stops)).toEqual({
      pickup: { city: 'MESA', state: 'AZ', zip: '85201' },
      delivery: { city: 'Boise', state: 'ID', zip: '83702' },
    })
    expect(routeEnds([])).toEqual({ pickup: null, delivery: null })
  })
})

describe('factor gaps after booking (Ryne 2026-11-14)', () => {
  it('flags only a factor-billed load, with a short summary', () => {
    const gaps = factorGapsForLoad({ ...full, poNumber: '', pickup: { ...full.pickup, zip: '' } })
    expect(gaps.map((g) => g.code)).toEqual(['PO_MISSING', 'PICKUP_ZIP'])
    expect(factorGapSummary(gaps.map((g) => g.code))).toBe('Missing for factoring: PO, Pick Up ZIP')
    expect(factorGapSummary([])).toBe('')
    expect(factorGapsForLoad({ ...full, poNumber: '', customer: { ...full.customer, billingMethod: 'MANUAL' } })).toEqual([])
    expect(factorGapsForLoad({ ...full, poNumber: '', customer: null })).toEqual([])
  })

  it('a customer record: a factored broker needs an MC; a factored customer with no type is flagged, not blocked', () => {
    const broker = { billingMethod: 'FACTOR' as const, factored: null, customerType: 'BROKER' as const, mcNumber: '' }
    expect(customerMcRequiredError(broker)).toMatch(/MC number/)
    expect(customerMcRequiredError({ ...broker, mcNumber: '99' })).toBeNull()
    expect(customerMcRequiredError({ ...broker, customerType: 'SHIPPER' })).toBeNull()
    expect(customerMcRequiredError({ ...broker, customerType: null })).toBeNull()
    expect(customerFactorFlag(broker)).toBe('MISSING_MC')
    expect(customerFactorFlag({ ...broker, customerType: null })).toBe('NEEDS_TYPE')
    expect(customerFactorFlag({ ...broker, customerType: 'SHIPPER' })).toBeNull()
    expect(customerFactorFlag({ ...broker, billingMethod: 'MANUAL', customerType: null })).toBeNull()
  })
})
