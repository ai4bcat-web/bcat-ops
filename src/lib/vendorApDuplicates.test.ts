import { describe, it, expect } from 'vitest'
import { findVendorApDuplicates } from './vendorApDuplicates'
import type { VendorPayable } from '@/types/vendorAp'

const row = (id: string, over: Partial<VendorPayable>): VendorPayable => ({ id, status: 'NEED_TO_PAY', source: 'EMAIL', subject: 's', attachments: [], receivedAt: `2026-10-0${id.length}T00:00:00Z`, createdAt: '', updatedAt: '', ...over })

describe('findVendorApDuplicates', () => {
  it('marks the later copy of the same vendor + invoice number, whatever the punctuation', () => {
    const d = findVendorApDuplicates([
      row('a', { vendor: 'Lyons Truck Parts, Inc.', invoiceNumber: 'INV 157588', receivedAt: '2026-10-01T00:00:00Z' }),
      row('bb', { vendor: 'Lyons Truck Parts', invoiceNumber: '#157588', receivedAt: '2026-10-02T00:00:00Z' }),
    ])
    expect(d.get('bb')).toEqual({ originalId: 'a', reason: 'invoice number' })
    expect(d.has('a')).toBe(false)
  })
  it('matches on amount and invoice date when there is no invoice number', () => {
    const d = findVendorApDuplicates([
      row('a', { vendor: 'Pilot', amount: 12345, invoiceDate: '2026-10-01', receivedAt: '2026-10-01T00:00:00Z' }),
      row('bb', { vendor: 'Pilot', amount: 12345, invoiceDate: '2026-10-01', receivedAt: '2026-10-03T00:00:00Z' }),
      row('ccc', { vendor: 'Pilot', amount: 12345, invoiceDate: '2026-10-02', receivedAt: '2026-10-04T00:00:00Z' }),
    ])
    expect(d.get('bb')?.reason).toBe('amount and date')
    expect(d.has('ccc')).toBe(false)
  })
  it('ignores rows with no vendor, and different vendors with the same number', () => {
    const d = findVendorApDuplicates([
      row('a', { invoiceNumber: '1' }), row('bb', { invoiceNumber: '1' }),
      row('ccc', { vendor: 'A', invoiceNumber: '9' }), row('dddd', { vendor: 'B', invoiceNumber: '9' }),
    ])
    expect(d.size).toBe(0)
  })
})
