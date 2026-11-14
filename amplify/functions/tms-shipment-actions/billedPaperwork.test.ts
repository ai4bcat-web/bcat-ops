import { describe, it, expect } from 'vitest'

import { billedPaperworkRefusal } from './documents'

const pod = { id: 'd1', type: 'POD' }
const rc = { id: 'd2', type: 'RATE_CON' }
const bol = { id: 'd3', type: 'BOL' }

describe('billedPaperworkRefusal', () => {
  it('a POD or rate con on an invoiced load cannot be removed or retyped', () => {
    for (const orders of [[{ invoiceId: 'inv1' }], [{ arStatus: 'UNPAID' }], [{ arStatus: 'PAID' }]]) {
      expect(billedPaperworkRefusal({ orders }, pod)).toMatch(/already invoiced/)
      expect(billedPaperworkRefusal({ orders }, rc)).toMatch(/already invoiced/)
    }
  })

  it('before invoicing, and for other paperwork, nothing is refused', () => {
    expect(billedPaperworkRefusal({ orders: [{ arStatus: 'DOCS_NEEDED' }] }, pod)).toBeNull()
    expect(billedPaperworkRefusal({ orders: [{ arStatus: 'UNBILLED' }] }, rc)).toBeNull()
    expect(billedPaperworkRefusal({ orders: [{ invoiceId: 'inv1' }] }, bol)).toBeNull()
  })
})
