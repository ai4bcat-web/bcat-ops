import { describe, expect, it } from 'vitest'
import { typeCarrierBlock, typeLockReason } from './shipmentTypeChange'

const open = { shipmentStatus: 'OPEN', loadStatus: 'SOURCING', hasInvoice: false, financialsFrozen: false }

describe('typeLockReason', () => {
  it('lets a draft and an open load (Sourcing or Booked) change the type', () => {
    expect(typeLockReason({ ...open, shipmentStatus: 'DRAFT', loadStatus: 'DELIVERED' })).toBeNull()
    expect(typeLockReason(open)).toBeNull()
    expect(typeLockReason({ ...open, shipmentStatus: 'BOOKED', loadStatus: 'BOOKED' })).toBeNull()
  })
  it('says why when an invoice, frozen numbers or a later status fix the type', () => {
    expect(typeLockReason({ ...open, hasInvoice: true })).toMatch(/invoiced/)
    expect(typeLockReason({ ...open, financialsFrozen: true })).toMatch(/frozen/)
    expect(typeLockReason({ ...open, loadStatus: 'IN_TRANSIT' })).toMatch(/in transit.*Sourcing or Booked/)
  })
})

describe('typeCarrierBlock', () => {
  it('only blocks a truckload / non-truckload move while a carrier is booked', () => {
    expect(typeCarrierBlock('RAIL', 'FTL', false)).toBeNull()
    expect(typeCarrierBlock('FTL', 'FTL', true)).toBeNull()
    expect(typeCarrierBlock('FTL', 'LTL', true)).toMatch(/carrier is booked/i)
    expect(typeCarrierBlock('RAIL', 'FTL', true)).toMatch(/carrier is booked/i)
    expect(typeCarrierBlock(null, 'FTL', true)).toBeNull()
  })
})
