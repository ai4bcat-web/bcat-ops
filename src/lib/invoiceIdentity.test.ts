import { describe, it, expect } from 'vitest'
import { invoiceAttachmentName, invoiceCompanyName, invoicePoNumber } from './invoiceIdentity'

describe('invoiceIdentity', () => {
  it('names the attachment after the PRO and PO, safely', () => {
    expect(invoiceAttachmentName('20027', 'FR-113188-3')).toBe('Invoice 20027 FR-113188-3.pdf')
    expect(invoiceAttachmentName('20027', null)).toBe('Invoice 20027.pdf')
    expect(invoiceAttachmentName('20027', 'A/B:C*?')).toBe('Invoice 20027 A-B-C-.pdf')
  })

  it('reads the customer-visible PO and ignores internal and stop references', () => {
    expect(invoicePoNumber([
      { code: 'PO', value: 'SECRET', visibility: 'INTERNAL', level: 'ORDER' },
      { code: 'PO', value: 'STOPPO', visibility: 'CUSTOMER', level: 'STOP' },
      { code: 'po', value: ' 44-118 ', visibility: 'CUSTOMER', level: 'ORDER' },
    ])).toBe('44-118')
    expect(invoicePoNumber([])).toBeNull()
  })

  it('comes from Ivan Cartage for asset loads and BCAT Logistics otherwise', () => {
    expect(invoiceCompanyName('ASSETS')).toBe('IVAN Cartage Co')
    expect(invoiceCompanyName('BROKERAGE')).toBe('BCAT Logistics Corporation')
    expect(invoiceCompanyName(null)).toBe('BCAT Logistics Corporation')
  })
})
