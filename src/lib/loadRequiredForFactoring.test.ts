/**
 * What a load must carry so the factoring queue can invoice it without a second pass —
 * and only for a customer whose loads actually get factored.
 *
 * OTR needs an origin ZIP, a destination ZIP and the broker's MC on every invoice, and
 * booking is the cheapest moment to capture them: the person has the address and the
 * broker in front of them rather than reconstructing both weeks later. But none of it is
 * ever sent for a customer we bill direct, so demanding it there would block real work for
 * paperwork nobody will read.
 */
import { describe, it, expect } from 'vitest'
import { loadSchema, loadSchemaFor } from './schemas'

/** A schema that treats cust-1 as factored and everyone else as not. */
const factoredSchema = loadSchemaFor((id) => id === 'cust-1')

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
    expect(factoredSchema.safeParse(load()).success).toBe(true)
  })

  it('requires an origin ZIP', () => {
    const r = factoredSchema.safeParse(load({
      stops: [stop({ address: { zip: '' } }), stop({ id: 's2', type: 'delivery', sequence: 1, address: { zip: '46201' } })],
    }))
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toMatch(/Origin ZIP is required/)
  })

  it('requires a destination ZIP', () => {
    const r = factoredSchema.safeParse(load({
      stops: [stop(), stop({ id: 's2', type: 'delivery', sequence: 1, address: null })],
    }))
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toMatch(/Destination ZIP is required/)
  })

  it('cannot demand anything when no customer has been chosen', () => {
    /*
     * Honest limit of this design: whether a load needs an MC and ZIPs is a property of
     * the CUSTOMER, so with no customer selected there is nothing to look up and nothing
     * to demand. A typed name reaches the factoring queue with no MC — but that is visible
     * there, and blocking every booking without a directory match would be the heavier
     * cost, especially for the direct-billed customers this rule is meant to leave alone.
     */
    const r = factoredSchema.safeParse(load({ customerId: '', customer: 'WAYFINDER LOGISTICS' }))
    expect(r.success).toBe(true)
  })

  it('does not demand a ZIP on a middle stop', () => {
    /*
     * Only the two endpoints reach an invoice. Demanding one for a middle stop on a
     * multi-stop run would block a booking for no gain.
     */
    const r = factoredSchema.safeParse(load({
      stops: [
        stop(),
        stop({ id: 's2', type: 'delivery', sequence: 1, address: null }),
        stop({ id: 's3', type: 'delivery', sequence: 2, address: { zip: '46201' } }),
      ],
    }))
    expect(r.success).toBe(true)
  })
})

describe('a customer we do not factor', () => {
  it('needs neither ZIPs nor a customer record to book', () => {
    /*
     * Carlyn Dairy, Batory, Rojac and Bulk Systems are billed direct. Their loads never
     * reach OTR, so the paperwork it would need is paperwork nobody will ever read —
     * demanding it only stops dispatch booking the work.
     */
    const direct = loadSchemaFor(() => false)
    const r = direct.safeParse(load({
      customerId: '',
      stops: [stop({ address: null }), stop({ id: 's2', type: 'delivery', sequence: 1, address: null })],
    }))
    expect(r.success).toBe(true)
  })

  it('is the default, so an unclassified customer never blocks a booking', () => {
    // Nobody has decided about most customers. Unknown must mean "do not get in the way";
    // a missing MC is still visible in the factoring queue either way.
    const r = loadSchemaFor((id) => id === 'someone-else').safeParse(load({
      customerId: 'cust-unknown',
      stops: [stop({ address: null }), stop({ id: 's2', type: 'delivery', sequence: 1, address: null })],
    }))
    expect(r.success).toBe(true)
  })

  it('still accepts a plain load through the base schema', () => {
    expect(loadSchema.safeParse(load()).success).toBe(true)
  })
})
