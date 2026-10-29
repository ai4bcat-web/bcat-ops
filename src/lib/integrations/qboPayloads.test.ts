import { describe, it, expect } from 'vitest'
import {
  centsToDecimal,
  qboBillFor,
  qboCustomerFor,
  qboInvoiceFor,
  qboMappingsValid,
  qboPaymentFor,
  type QboMappings,
} from './qboPayloads'

describe('centsToDecimal', () => {
  it('converts integer cents to an exact two-decimal string', () => {
    expect(centsToDecimal(0)).toBe('0.00')
    expect(centsToDecimal(5)).toBe('0.05')
    expect(centsToDecimal(50)).toBe('0.50')
    expect(centsToDecimal(100)).toBe('1.00')
    expect(centsToDecimal(123456)).toBe('1234.56')
    expect(centsToDecimal(1005)).toBe('10.05')
  })

  it('keeps the sign on a negative amount (a credit line)', () => {
    expect(centsToDecimal(-5)).toBe('-0.05')
    expect(centsToDecimal(-123456)).toBe('-1234.56')
    expect(centsToDecimal(-100)).toBe('-1.00')
  })

  it('is exact where a float divide is not', () => {
    // 1.005, 2.675 and friends: the classic float-rounding traps.
    expect(centsToDecimal(10050)).toBe('100.50')
    expect(centsToDecimal(2675)).toBe('26.75')
    expect(centsToDecimal(81)).toBe('0.81')
    // Every cent from 0..999 round-trips back to the same integer.
    for (let cents = 0; cents < 1000; cents++) {
      const text = centsToDecimal(cents)
      expect(Math.round(Number(text) * 100)).toBe(cents)
      expect(text).toMatch(/^\d+\.\d{2}$/)
    }
  })

  it('refuses a non-integer amount rather than silently rounding', () => {
    expect(() => centsToDecimal(10.5)).toThrow(/integer cents/)
    expect(() => centsToDecimal(Number.NaN)).toThrow(/integer cents/)
  })
})

const MAPPINGS: QboMappings = {
  arAccountRef: '84',
  apAccountRef: '33',
  depositAccountRef: '35',
  expenseAccountRef: '54',
  chargeCodeItems: { LINEHAUL: '1', FUEL: '2', DETENTION: '3' },
  customerRefs: { 'cust-1': '58' },
  vendorRefs: { 'carr-1': '77' },
}

describe('qboInvoiceFor', () => {
  const invoice = {
    number: 'INV-1042',
    invoiceDate: '2026-03-04',
    dueAt: '2026-04-03',
    customerId: 'cust-1',
    customerName: 'BATORY FOODS',
    termsText: 'Net 30',
    lines: [
      { code: 'LINEHAUL', label: 'Linehaul', amountCents: 250000, count: 1, rateCents: 250000 },
      { code: 'FUEL', label: 'Fuel surcharge', amountCents: 37550 },
      { code: 'DETENTION', label: 'Detention', amountCents: 7505 },
    ],
    totalCents: 295055,
  }

  it('totals exactly what the invoice says, and the lines add to it', () => {
    const payload = qboInvoiceFor(invoice, MAPPINGS)
    expect(payload.TotalAmt).toBe('2950.55')
    const lineSum = payload.Line.reduce((sum, line) => sum + Math.round(Number(line.Amount) * 100), 0)
    expect(lineSum).toBe(invoice.totalCents)
    expect(payload.Line.map((l) => l.Amount)).toEqual(['2500.00', '375.50', '75.05'])
  })

  it('carries the mapped customer and item refs', () => {
    const payload = qboInvoiceFor(invoice, MAPPINGS)
    expect(payload.CustomerRef).toEqual({ value: '58', name: 'BATORY FOODS' })
    expect(payload.Line[0].SalesItemLineDetail?.ItemRef.value).toBe('1')
    expect(payload.Line[0].SalesItemLineDetail?.UnitPrice).toBe('2500.00')
    expect(payload.DocNumber).toBe('INV-1042')
    expect(payload.DueDate).toBe('2026-04-03')
    expect(payload.CustomerMemo).toEqual({ value: 'Net 30' })
  })

  it('leaves unmapped refs empty rather than inventing an id', () => {
    const payload = qboInvoiceFor({ ...invoice, customerId: 'cust-unknown' }, null)
    expect(payload.CustomerRef.value).toBe('')
    expect(payload.Line[0].SalesItemLineDetail?.ItemRef.value).toBe('')
  })

  it('handles a credit line without losing the sign', () => {
    const payload = qboInvoiceFor(
      {
        ...invoice,
        lines: [{ code: 'LINEHAUL', label: 'Linehaul', amountCents: 100000 }, { code: 'FUEL', label: 'Adjustment', amountCents: -2505 }],
        totalCents: 97495,
      },
      MAPPINGS,
    )
    expect(payload.Line[1].Amount).toBe('-25.05')
    expect(payload.TotalAmt).toBe('974.95')
  })
})

describe('qboCustomerFor', () => {
  it('maps the billing address and contact fields', () => {
    const payload = qboCustomerFor({
      id: 'cust-1',
      name: 'BATORY FOODS',
      billingEmail: 'ap@batory.com',
      phone: '630-555-0100',
      billingAddress: { street: '1 Oakley Dr', city: 'Chicago', state: 'IL', zip: '60632', country: 'US' },
    })
    expect(payload.DisplayName).toBe('BATORY FOODS')
    expect(payload.PrimaryEmailAddr).toEqual({ Address: 'ap@batory.com' })
    expect(payload.BillAddr).toEqual({
      Line1: '1 Oakley Dr',
      City: 'Chicago',
      CountrySubDivisionCode: 'IL',
      PostalCode: '60632',
      Country: 'US',
    })
  })

  it('omits an address nobody filled in', () => {
    const payload = qboCustomerFor({ id: 'c', name: 'ACME', billingAddress: { street: '  ' } })
    expect(payload.BillAddr).toBeUndefined()
    expect(payload.PrimaryEmailAddr).toBeUndefined()
  })
})

describe('qboPaymentFor', () => {
  it('links each allocation to its invoice and totals the receipt', () => {
    const payload = qboPaymentFor(
      {
        id: 'pay-1',
        customerId: 'cust-1',
        receivedAt: '2026-03-20T12:00:00.000Z',
        method: 'ACH',
        reference: 'ACH-99',
        amountCents: 295055,
      },
      [
        { invoiceId: 'INV-1042', amountCents: 200000 },
        { invoiceId: 'INV-1043', amountCents: 95055 },
      ],
      MAPPINGS,
    )
    expect(payload.TxnDate).toBe('2026-03-20')
    expect(payload.TotalAmt).toBe('2950.55')
    expect(payload.PaymentRefNum).toBe('ACH-99')
    expect(payload.DepositToAccountRef).toEqual({ value: '35' })
    expect(payload.Line).toEqual([
      { Amount: '2000.00', LinkedTxn: [{ TxnId: 'INV-1042', TxnType: 'Invoice' }] },
      { Amount: '950.55', LinkedTxn: [{ TxnId: 'INV-1043', TxnType: 'Invoice' }] },
    ])
    const allocated = payload.Line.reduce((sum, l) => sum + Math.round(Number(l.Amount) * 100), 0)
    expect(allocated).toBe(295055)
  })
})

describe('qboBillFor', () => {
  it('builds an AP bill against the mapped vendor and accounts', () => {
    const payload = qboBillFor(
      {
        id: 'cb:lc-1:1',
        carrierId: 'carr-1',
        carrierName: 'SWIFT',
        billNumber: 'SW-500',
        billDate: '2026-03-05',
        dueAt: '2026-04-04',
        lines: [{ code: 'CARRIER_LINEHAUL', label: 'Linehaul', amountCents: 180000 }],
        netCents: 180000,
      },
      MAPPINGS,
    )
    expect(payload.VendorRef).toEqual({ value: '77', name: 'SWIFT' })
    expect(payload.APAccountRef).toEqual({ value: '33' })
    expect(payload.DocNumber).toBe('SW-500')
    expect(payload.TotalAmt).toBe('1800.00')
    expect(payload.Line[0].AccountBasedExpenseLineDetail).toEqual({ AccountRef: { value: '54' } })
  })
})

describe('qboMappingsValid', () => {
  it('accepts a mapping that covers every used charge code', () => {
    expect(qboMappingsValid(MAPPINGS, ['LINEHAUL', 'FUEL', 'LINEHAUL'])).toEqual({ ok: true })
  })

  it('refuses a mapping missing a code that is actually billed', () => {
    const result = qboMappingsValid(MAPPINGS, ['LINEHAUL', 'LUMPER'])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected invalid')
    expect(result.errors).toEqual(['Charge code LUMPER has no QuickBooks item mapping'])
  })

  it('refuses a mapping with no AR account', () => {
    const result = qboMappingsValid({ ...MAPPINGS, arAccountRef: '  ' }, ['LINEHAUL'])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected invalid')
    expect(result.errors).toContain('No accounts-receivable account is mapped')
  })

  it('is unbothered by codes nobody bills', () => {
    expect(qboMappingsValid({ arAccountRef: '84', chargeCodeItems: {} }, [])).toEqual({ ok: true })
  })
})
