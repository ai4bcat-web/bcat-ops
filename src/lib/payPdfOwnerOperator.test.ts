import { describe, it, expect } from 'vitest'
import { ownerOperatorPdfRows, ownerOperatorPdfFilename } from './payPdfOwnerOperator'
import type { OwnerOperatorPayRow } from '@/hooks/useOwnerOperatorPay'

describe('owner-operator statement PDF rows', () => {
  const row = {
    driver: { name: 'Roy Workman' },
    setting: { payPercent: 0.88, expensesBeforePercent: false },
    trips: [
      { id: 'a', loadId: 'L1', customer: 'Axle Logistics', origin: 'Norfolk, NE', destination: 'Otsego, MN', miles: 371, freightAmount: 1400, deliveredAt: '', readiness: { payload: { InvoiceNo: '14604' }, missingDocuments: [] } },
      { id: 'b', loadId: 'L2', customer: 'Reliable', origin: 'Augusta, WI', destination: 'Goddard, KS', miles: 723, freightAmount: 2900, deliveredAt: '' },
    ],
    heldTrips: [{ trip: { id: 'b' }, reason: 'NO_POD' }],
  } as unknown as OwnerOperatorPayRow
  it('prints the PRO, the share, and a held load at $0 with why', () => {
    const rows = ownerOperatorPdfRows(row)
    expect(rows[0]).toEqual(['14604', 'Axle Logistics', 'Norfolk, NE  ->  Otsego, MN', '371', '$1,400.00', '$3.77', 'On this check', '$1,232.00'])
    expect(rows[1][0]).toBe('—')
    expect(rows[1][6]).toMatch(/^Held — /)
    expect(rows[1][7]).toBe('$0.00')
  })
  it('names the file by driver and period', () => {
    expect(ownerOperatorPdfFilename(row, '2026-10-04')).toBe('settlement-Roy-Workman-2026-10-04.pdf')
  })
})
