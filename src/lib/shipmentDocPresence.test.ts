import { describe, it, expect } from 'vitest'
import { shipmentDocPresence } from './shipmentDocPresence'

describe('shipmentDocPresence', () => {
  it('reads the POD and rate con filed on the shipment page (20039: POD and RATE_CON filed, settlement said missing)', () => {
    const p = shipmentDocPresence([
      { type: 'RATE_CON', status: 'ACTIVE', uploadedAt: '2026-11-13T20:57:00Z' },
      { type: 'POD', status: 'ACTIVE', loadId: 'l1', uploadedAt: '2026-11-12T16:44:00Z' },
      { type: 'POD', status: 'ACTIVE', loadId: 'l1', uploadedAt: '2026-11-12T16:30:00Z' },
    ], 'l1')
    expect(p).toEqual({ pod: true, podUploadedAt: '2026-11-12T16:30:00Z', ratecon: true })
  })

  it('counts a customer rate con and a POD still waiting for review', () => {
    expect(shipmentDocPresence([{ type: 'CUSTOMER_RATE_CON' }, { type: 'POD', reviewStatus: 'PENDING' }], 'l1')).toMatchObject({ pod: true, ratecon: true })
  })

  it("ignores voided, superseded and rejected documents and another load's", () => {
    expect(shipmentDocPresence([
      { type: 'POD', status: 'VOID' },
      { type: 'POD', status: 'SUPERSEDED' },
      { type: 'POD', reviewStatus: 'REJECTED' },
      { type: 'POD', loadId: 'other' },
      { type: 'OTHER', loadId: 'l1' },
    ], 'l1')).toEqual({ pod: false, podUploadedAt: null, ratecon: false })
  })
})
