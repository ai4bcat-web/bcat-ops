import { describe, it, expect } from 'vitest'
import { loadFromFactoringItem } from './loadFromInvoice'
import type { OtrReadiness } from '@/lib/otrInvoice'

/**
 * The factoring builder emits the `load` bag CREATE_SHIPMENT takes, not a Load row.
 *
 * Two of its old fields would now be actively harmful. `readyToInvoice: true` is refused
 * by the server outright, and honouring it would walk freight past `evaluateReleaseGate`.
 * And `rate` as a raw number left the money on the Load while the Order it hangs under
 * stayed at $0 — the amount has to arrive as `rateCents` so it is priced as a CUSTOMER
 * LINEHAUL charge and the order's revenue is derived from it.
 */
describe('loadFromFactoringItem', () => {
  it('carries the PO, the amount in cents, the lanes and the invoice date', () => {
    const readiness = {
      payload: { PoNumber: '68869', InvoiceAmount: 150, InvoiceDate: '2026-10-14', FromCity: 'Waukesha', FromState: 'WI', ToCity: 'Addison', ToState: 'IL' },
      customerName: 'Fox Transportation Services (IL)', missingFields: [], missingDocuments: ['POD', 'Rate confirmation'],
    } as unknown as OtrReadiness
    const bag = loadFromFactoringItem({ proNumber: '14529' }, readiness, '2026-10-16T15:00:00.000Z')
    expect(bag.tmsId).toBe('68869')
    expect(bag.rateCents).toBe(15000)
    expect(bag.originCity).toBe('Waukesha, WI')
    expect(bag.destinationCity).toBe('Addison, IL')
    expect(bag.deliveryAppt?.slice(0, 10)).toBe('2026-10-14')
    expect(bag.deliveryApptType).toBe('fcfs')
    expect(bag.pickupDriverId).toBeNull()
  })

  // Both are refused by the server's whitelist; the PRO goes beside the bag, not in it.
  it('emits none of the fields the server refuses', () => {
    const bag = loadFromFactoringItem({ proNumber: '14529' }, null, '2026-10-16T15:00:00.000Z')
    expect(bag).not.toHaveProperty('readyToInvoice')
    expect(bag).not.toHaveProperty('rate')
    expect(bag).not.toHaveProperty('aljexId')
  })

  /*
   * The customer is the caller's business now: only the page knows whether the row
   * resolved to a record or only to typed text, and the bag must never carry either.
   */
  it('names no customer at all', () => {
    const readiness = { payload: {}, customerName: 'Fox Transportation Services (IL)' } as unknown as OtrReadiness
    const bag = loadFromFactoringItem({ proNumber: '14529' }, readiness, '2026-10-16T15:00:00.000Z')
    expect(bag).not.toHaveProperty('customer')
    expect(bag).not.toHaveProperty('customerId')
  })

  it('copes with an unprepared row: dated today, no amount, no lanes', () => {
    const bag = loadFromFactoringItem({ proNumber: '15000' }, null, '2026-10-16T15:00:00.000Z')
    expect(bag.rateCents).toBeUndefined()
    expect(bag.originCity).toBeUndefined()
    expect(bag.deliveryAppt?.slice(0, 10)).toBe('2026-10-16')
  })
})
