import { describe, it, expect } from 'vitest'
import { matchLoadForDriverRef, type PaperworkLoadLike } from './paperwork'

const CHAD = 'driver-chad'
const OTHER = 'driver-other'

const load = (over: Partial<PaperworkLoadLike> & { id: string }): PaperworkLoadLike => ({ ...over })

describe('matchLoadForDriverRef', () => {
  it('matches the PRO across all loads, padded as the table stores it', () => {
    const loads = [load({ id: 'a', aljexId: '14547  ' }), load({ id: 'b', aljexId: '14548' })]
    expect(matchLoadForDriverRef(loads, '14547', CHAD)).toEqual({ loadId: 'a', via: 'PRO' })
  })

  it("falls back to the customer's load id on the driver's own load (Chad, 20031 / 4011180493)", () => {
    const loads = [
      load({ id: 'lod-20031', aljexId: '20031', tmsId: '4011180493', pickupNumber: '6100439219', deliveryDriverId: CHAD }),
      load({ id: 'lod-other', aljexId: '20039', deliveryDriverId: CHAD }),
    ]
    expect(matchLoadForDriverRef(loads, '4011180493', CHAD)).toEqual({ loadId: 'lod-20031', via: 'CUSTOMER_REF' })
    expect(matchLoadForDriverRef(loads, '6100439219', CHAD)).toEqual({ loadId: 'lod-20031', via: 'CUSTOMER_REF' })
  })

  it("never matches a customer reference on another driver's load", () => {
    const loads = [load({ id: 'lod-20031', aljexId: '20031', tmsId: '4011180493', deliveryDriverId: OTHER })]
    expect(matchLoadForDriverRef(loads, '4011180493', CHAD)).toBeNull()
  })

  it('leaves it unattached when the reference is on two of the driver’s loads', () => {
    const loads = [
      load({ id: 'x', aljexId: '20050', pickupNumber: 'PO-77', deliveryDriverId: CHAD }),
      load({ id: 'y', aljexId: '20051', pickupNumber: 'PO-77', pickupDriverId: CHAD }),
    ]
    expect(matchLoadForDriverRef(loads, 'PO-77', CHAD)).toBeNull()
  })

  it('leaves it unattached when a PRO is on two loads, without falling back', () => {
    const loads = [
      load({ id: 'x', aljexId: '14000', deliveryDriverId: CHAD }),
      load({ id: 'y', aljexId: '14000' }),
      load({ id: 'z', aljexId: '20099', tmsId: '14000', deliveryDriverId: CHAD }),
    ]
    expect(matchLoadForDriverRef(loads, '14000', CHAD)).toBeNull()
  })

  it('returns null for nothing typed', () => {
    expect(matchLoadForDriverRef([load({ id: 'a', aljexId: '14547' })], '  ', CHAD)).toBeNull()
  })
})
