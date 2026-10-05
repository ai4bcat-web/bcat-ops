/**
 * What a load must carry so the factoring queue can invoice it without a second pass.
 *
 * OTR needs an origin ZIP, a destination ZIP and the broker's MC on every invoice. None of
 * those were required when a load was booked, so they were collected weeks later by hand —
 * twenty queue rows sat blocked on exactly this. The person booking has the address and the
 * broker in front of them, which makes booking the cheapest moment to capture both.
 */
import { describe, it, expect } from 'vitest'
import { loadSchema } from './schemas'

function stop(over: Record<string, unknown> = {}) {
  return {
    id: 's1', type: 'pickup', appt: '2026-10-05T12:00:00Z', apptType: 'exact', driverId: null, sequence: 0,
    address: { zip: '60601' },
    ...over,
  }
}

function load(over: Record<string, unknown> = {}) {
  return {
    aljexId: '14538', tmsId: 'TMS-1', pickupNumber: 'PO-1',
    customerId: 'cust-1',
    readyToInvoice: false,
    stops: [stop(), stop({ id: 's2', type: 'delivery', sequence: 1, address: { zip: '46201' } })],
    ...over,
  }
}

describe('a load that can be factored', () => {
  it('accepts one with both ZIPs and a directory customer', () => {
    expect(loadSchema.safeParse(load()).success).toBe(true)
  })

  it('requires an origin ZIP', () => {
    const r = loadSchema.safeParse(load({
      stops: [stop({ address: { zip: '' } }), stop({ id: 's2', type: 'delivery', sequence: 1, address: { zip: '46201' } })],
    }))
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toMatch(/Origin ZIP is required/)
  })

  it('requires a destination ZIP', () => {
    const r = loadSchema.safeParse(load({
      stops: [stop(), stop({ id: 's2', type: 'delivery', sequence: 1, address: null })],
    }))
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toMatch(/Destination ZIP is required/)
  })

  it('requires a customer from the directory, not a typed name', () => {
    // The MC hangs off the customer record, and the invoice bills the MC.
    const r = loadSchema.safeParse(load({ customerId: '', customer: 'WAYFINDER LOGISTICS' }))
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toMatch(/Customer is required/)
  })

  it('does not demand a ZIP on a middle stop', () => {
    /*
     * Only the two endpoints reach an invoice. Demanding one for a middle stop on a
     * multi-stop run would block a booking for no gain.
     */
    const r = loadSchema.safeParse(load({
      stops: [
        stop(),
        stop({ id: 's2', type: 'delivery', sequence: 1, address: null }),
        stop({ id: 's3', type: 'delivery', sequence: 2, address: { zip: '46201' } }),
      ],
    }))
    expect(r.success).toBe(true)
  })
})
