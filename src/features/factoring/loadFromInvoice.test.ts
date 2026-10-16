import { describe, it, expect } from 'vitest'
import { loadFromFactoringItem } from './loadFromInvoice'
import type { OtrReadiness } from '@/lib/otrInvoice'

describe('loadFromFactoringItem', () => {
  it('builds a ready-to-invoice load from the row: PRO, PO, amount in cents, lanes, invoice date', () => {
    const readiness = {
      payload: { PoNumber: '68869', InvoiceAmount: 150, InvoiceDate: '2026-10-14', FromCity: 'Waukesha', FromState: 'WI', ToCity: 'Addison', ToState: 'IL' },
      customerName: 'Fox Transportation Services (IL)', missingFields: [], missingDocuments: ['POD', 'Rate confirmation'],
    } as unknown as OtrReadiness
    const l = loadFromFactoringItem({ proNumber: '14529', customerId: 'cust-1' }, readiness, 'ryne@bcatcorp.com', '2026-10-16T15:00:00.000Z')
    expect(l.aljexId).toBe('14529')
    expect(l.tmsId).toBe('68869')
    expect(l.rate).toBe(15000)
    expect(l.customer).toBe('Fox Transportation Services (IL)')
    expect(l.customerId).toBe('cust-1')
    expect(l.originCity).toBe('Waukesha, WI')
    expect(l.destinationCity).toBe('Addison, IL')
    expect(l.deliveryAppt.slice(0, 10)).toBe('2026-10-14')
    expect(l.deliveryApptType).toBe('fcfs')
    expect(l.readyToInvoice).toBe(true)
    expect(l.pickupDriverId).toBeNull()
    expect(l.createdBy).toBe('ryne@bcatcorp.com')
  })
  it('copes with an unprepared row: PRO only, dated today, no rate', () => {
    const l = loadFromFactoringItem({ proNumber: '15000' }, null, 'kel@bcatcorp.com', '2026-10-16T15:00:00.000Z')
    expect(l.aljexId).toBe('15000')
    expect(l.rate).toBeNull()
    expect(l.customer).toBeNull()
    expect(l.originCity).toBeUndefined()
    expect(l.deliveryAppt.slice(0, 10)).toBe('2026-10-16')
  })
})
