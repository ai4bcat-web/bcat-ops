import { describe, it, expect } from 'vitest'
import {
  DEFAULT_INVOICE_NUMBER_FORMAT,
  billingRecipients,
  defaultInvoiceAttachments,
  dueDateFor,
  formatInvoiceNumber,
  invoiceCcRecipients,
  invoiceData,
  invoiceLinesFor,
  invoiceNumberFormatError,
  invoiceReadiness,
  invoiceTermsDays,
  missingRequiredReferences,
  remitToFor,
} from './invoiceBuild'
import type { InvoiceDataInput, InvoiceReadinessInput } from './invoiceBuild'
import type {
  CustomerContact,
  CustomerRecord,
  Division,
  LoadChargeRecord,
  OrderReference,
  ShipmentDocumentRecord,
} from '../types/tms'
import type { Stop } from '../types'

function charge(overrides: Partial<LoadChargeRecord> = {}): LoadChargeRecord {
  return {
    id: 'chg-1',
    shipmentId: 'shp-1',
    side: 'CUSTOMER',
    orderId: 'ord-1',
    loadId: 'ld-1',
    code: 'LINEHAUL',
    label: 'Linehaul',
    calculatedBy: 'FLAT',
    rateCents: 120000,
    count: 1,
    amountCents: 120000,
    isRate: true,
    sortOrder: 0,
    createdBy: 'ops@bcat.test',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  }
}

function contact(overrides: Partial<CustomerContact> = {}): CustomerContact {
  return {
    id: 'cc-1',
    name: 'Billing desk',
    email: 'ap@acme.test',
    types: ['BILLING'],
    notifications: [],
    active: true,
    ...overrides,
  }
}

function doc(overrides: Partial<ShipmentDocumentRecord> = {}): ShipmentDocumentRecord {
  return {
    id: 'sdoc-pod',
    shipmentId: 'shp-1',
    orderId: 'ord-1',
    type: 'POD',
    name: 'pod.pdf',
    s3Key: 'shipment-docs/shp-1/sdoc-pod.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    source: 'UPLOAD',
    audience: 'ALL',
    status: 'ACTIVE',
    version: 1,
    reviewStatus: 'ACCEPTED',
    uploadedBy: 'ops@bcat.test',
    uploadedAt: '2026-03-02T12:00:00.000Z',
    createdBy: 'ops@bcat.test',
    ...overrides,
  }
}

const PO: OrderReference = { code: 'PO', label: 'PO number', value: '44821', level: 'ORDER', visibility: 'CUSTOMER' }

function readinessInput(overrides: Partial<InvoiceReadinessInput> = {}): InvoiceReadinessInput {
  return {
    order: {
      id: 'ord-1',
      arStatus: 'UNBILLED',
      revenueCents: 120000,
      references: [PO],
    },
    shipment: { number: 'B-1042', status: 'DELIVERED', deletedAt: null },
    customer: { requiredReferences: [{ code: 'PO', label: 'PO number', level: 'ORDER', display: true, countOnNewOrder: 1 }] },
    settings: { defaultRequiredReferences: null },
    charges: [charge()],
    gate: { missing: [] },
    ...overrides,
  }
}

describe('invoiceTermsDays', () => {
  it('takes the bill-to terms over the customer and the org', () => {
    expect(invoiceTermsDays({ paymentTermsDays: 45 }, { paymentTermsDays: 15 }, { defaultPaymentTermsDays: 60 })).toBe(15)
  })

  it('falls through to the customer when the bill-to has no usable terms', () => {
    expect(invoiceTermsDays({ paymentTermsDays: 45 }, { paymentTermsDays: 0 }, { defaultPaymentTermsDays: 60 })).toBe(45)
    expect(invoiceTermsDays({ paymentTermsDays: 45 }, null, { defaultPaymentTermsDays: 60 })).toBe(45)
  })

  it('falls through to the org default when the customer has none', () => {
    expect(invoiceTermsDays({ paymentTermsDays: null }, null, { defaultPaymentTermsDays: 60 })).toBe(60)
  })

  it('bills Net 30 when nobody has chosen terms', () => {
    expect(invoiceTermsDays(null, null, null)).toBe(30)
    expect(invoiceTermsDays({ paymentTermsDays: Number.NaN }, { paymentTermsDays: -7 }, { defaultPaymentTermsDays: 0 })).toBe(30)
  })
})

describe('dueDateFor', () => {
  it('crosses a month end', () => {
    expect(dueDateFor('2026-03-20', 15)).toBe('2026-04-04')
  })

  it('crosses a year end', () => {
    expect(dueDateFor('2026-12-18', 30)).toBe('2027-01-17')
  })

  it('counts February 29 in a leap year', () => {
    expect(dueDateFor('2028-02-20', 10)).toBe('2028-03-01')
    expect(dueDateFor('2027-02-20', 10)).toBe('2027-03-02')
  })

  it('is the same day at zero terms', () => {
    expect(dueDateFor('2026-03-20', 0)).toBe('2026-03-20')
  })
})

describe('formatInvoiceNumber', () => {
  it('zero-pads the counter to the requested width', () => {
    expect(formatInvoiceNumber(DEFAULT_INVOICE_NUMBER_FORMAT, { prefix: 'INV-', n: 42, date: '2026-03-20' }))
      .toBe('INV-000042')
  })

  it('prints the year of the invoice date', () => {
    expect(formatInvoiceNumber('{prefix}{yyyy}-{n:4}', { prefix: 'BC', n: 7, date: '2026-03-20' }))
      .toBe('BC2026-0007')
  })

  it('leaves a token nobody recognises verbatim', () => {
    expect(formatInvoiceNumber('{prefix}{month}{n}', { prefix: 'INV-', n: 9, date: '2026-03-20' }))
      .toBe('INV-{month}9')
  })
})

describe('invoiceNumberFormatError', () => {
  it('refuses a format with no counter, and says so once', () => {
    expect(invoiceNumberFormatError('{prefix}{yyyy}')).toBe('The invoice number format needs an {n} token')
    expect(invoiceNumberFormatError('INV-{n:99}')).toBe('The invoice number format needs an {n} token')
  })

  it('accepts a format that can number an invoice', () => {
    expect(invoiceNumberFormatError(DEFAULT_INVOICE_NUMBER_FORMAT)).toBeNull()
    expect(invoiceNumberFormatError('{yyyy}-{n}')).toBeNull()
  })
})

describe('invoiceLinesFor', () => {
  it('takes only this order\u2019s customer rows, in sort order, and sums them', () => {
    const result = invoiceLinesFor(
      [
        charge({ id: 'chg-fsc', code: 'FSC', sortOrder: 1, rateCents: 1500, amountCents: 15000, count: 10 }),
        charge({ id: 'chg-lh', sortOrder: 0 }),
        charge({ id: 'chg-carrier', side: 'CARRIER', amountCents: 90000, sortOrder: 0 }),
        charge({ id: 'chg-other-order', orderId: 'ord-2', amountCents: 50000, sortOrder: 0 }),
      ],
      'ord-1',
    )

    expect(result.lines.map((line) => line.chargeId)).toEqual(['chg-lh', 'chg-fsc'])
    expect(result.subtotalCents).toBe(135000)
  })

  it('counts a line with no count as one', () => {
    const { lines } = invoiceLinesFor([charge({ count: null })], 'ord-1')
    expect(lines[0].count).toBe(1)
  })
})

describe('missingRequiredReferences', () => {
  it('counts a blank value as missing and falls back to the org list', () => {
    const required = [{ code: 'PO', label: 'PO number', level: 'ORDER' as const, display: true, countOnNewOrder: 1 }]
    expect(missingRequiredReferences(null, { defaultRequiredReferences: required }, [{ ...PO, value: '  ' }]))
      .toEqual(['PO number'])
    expect(missingRequiredReferences(null, { defaultRequiredReferences: required }, [PO])).toEqual([])
  })
})

describe('invoiceReadiness', () => {
  it('passes a complete order', () => {
    expect(invoiceReadiness(readinessInput())).toEqual({ ready: true, reasons: [] })
  })

  it('refuses an order that is not UNBILLED, and names the status it has', () => {
    const { ready, reasons } = invoiceReadiness(
      readinessInput({ order: { ...readinessInput().order, arStatus: 'DOCS_NEEDED' } }),
    )
    expect(ready).toBe(false)
    expect(reasons).toEqual(["This order's AR status is DOCS_NEEDED; only an UNBILLED order can be invoiced."])
  })

  it('refuses a canceled shipment', () => {
    const { reasons } = invoiceReadiness(
      readinessInput({ shipment: { number: 'B-1042', status: 'CANCELED', deletedAt: null } }),
    )
    expect(reasons).toEqual(['Shipment B-1042 is canceled; it cannot be invoiced.'])
  })

  it('refuses a soft-deleted shipment', () => {
    const { reasons } = invoiceReadiness(
      readinessInput({ shipment: { number: 'B-1042', status: 'DELIVERED', deletedAt: '2026-03-10T00:00:00.000Z' } }),
    )
    expect(reasons).toEqual(['Shipment B-1042 is deleted; restore it before invoicing.'])
  })

  it('refuses an order with no revenue', () => {
    const { reasons } = invoiceReadiness(
      readinessInput({ order: { ...readinessInput().order, revenueCents: 0 }, charges: [] }),
    )
    expect(reasons).toEqual(['This order has no revenue to bill; add the customer charges first.'])
  })

  it('refuses lines that do not sum to the order revenue, and says both numbers', () => {
    const { reasons } = invoiceReadiness({ ...readinessInput(), charges: [charge({ amountCents: 119000 })] })
    expect(reasons).toEqual([
      "The customer charge lines total $1,190.00 but the order's revenue is $1,200.00; recalculate the charges.",
    ])
  })

  it('refuses each missing required reference on its own line', () => {
    const { reasons } = invoiceReadiness(
      readinessInput({
        order: { ...readinessInput().order, references: [] },
        customer: {
          requiredReferences: [
            { code: 'PO', label: 'PO number', level: 'ORDER', display: true, countOnNewOrder: 1 },
            { code: 'BOL', level: 'ORDER', display: true, countOnNewOrder: 1 },
          ],
        },
      }),
    )
    expect(reasons).toEqual([
      'PO number is a required reference and this order does not have one.',
      'BOL is a required reference and this order does not have one.',
    ])
  })

  it('refuses a missing document, with no way to override it', () => {
    const { reasons } = invoiceReadiness(readinessInput({ gate: { missing: ['POD'] } }))
    expect(reasons).toEqual([
      'Required documents are missing: Proof of delivery. Attach them before invoicing.',
    ])
  })
})

describe('remitToFor', () => {
  const division: Pick<Division, 'name' | 'legalName' | 'remitToName' | 'remitToAddress' | 'remitToEmail'> = {
    name: 'BCAT Logistics',
    legalName: 'BCAT Corp',
    remitToName: 'BCAT Corp',
    remitToAddress: { street: '1 Dock Rd', city: 'Elgin', state: 'IL', zip: '60120' },
    remitToEmail: 'ar@bcat.test',
  }
  const settings = {
    factorRemitTo: {
      name: 'TBS Factoring',
      address: { street: 'PO Box 1', city: 'Oklahoma City', state: 'OK', zip: '73101' },
      email: 'remit@tbs.test',
      noticeText: 'This invoice has been assigned to TBS Factoring Service.',
    },
  }

  it('sends a factored customer to the factor, with its notice', () => {
    expect(remitToFor(division, { factored: true }, settings)).toEqual({
      name: 'TBS Factoring',
      address: settings.factorRemitTo.address,
      email: 'remit@tbs.test',
      noticeText: 'This invoice has been assigned to TBS Factoring Service.',
    })
  })

  it('switches on factored === true only', () => {
    const divisionRemit = {
      name: 'BCAT Corp',
      address: division.remitToAddress,
      email: 'ar@bcat.test',
      noticeText: null,
    }
    expect(remitToFor(division, { factored: null }, settings)).toEqual(divisionRemit)
    expect(remitToFor(division, { factored: false }, settings)).toEqual(divisionRemit)
    expect(remitToFor(division, null, settings)).toEqual(divisionRemit)
  })

  it('stays with the division when no factor remit-to is configured', () => {
    expect(remitToFor(division, { factored: true }, { factorRemitTo: null }).name).toBe('BCAT Corp')
  })
})

describe('billingRecipients', () => {
  const customer: Pick<CustomerRecord, 'contacts' | 'billingEmail'> = {
    billingEmail: 'Accounts@Acme.test',
    contacts: [
      contact({ id: 'cc-bt', email: 'BillTo@acme.test', billToId: 'bt-1' }),
      contact({ id: 'cc-bt-dupe', email: 'billto@acme.test', billToId: 'bt-1' }),
      contact({ id: 'cc-free', email: 'ap@acme.test' }),
      contact({ id: 'cc-inactive', email: 'old@acme.test', billToId: 'bt-1', active: false }),
      contact({ id: 'cc-ops', email: 'ops@acme.test', types: ['OPERATIONS'] }),
    ],
  }

  it('prefers the contacts assigned to that bill-to, de-duplicated and lowercased', () => {
    expect(billingRecipients(customer, 'bt-1')).toEqual(['billto@acme.test'])
  })

  it('falls back to the unassigned billing contacts', () => {
    expect(billingRecipients(customer, 'bt-9')).toEqual(['ap@acme.test'])
  })

  it('falls back again to the billing e-mail on the customer', () => {
    expect(billingRecipients({ billingEmail: 'Accounts@Acme.test', contacts: [] }, 'bt-1'))
      .toEqual(['accounts@acme.test'])
  })

  it('resolves nobody when the customer has nowhere to send a bill', () => {
    expect(billingRecipients({ billingEmail: '  ', contacts: null }, null)).toEqual([])
    expect(billingRecipients(null, null)).toEqual([])
  })
})

describe('invoiceCcRecipients', () => {
  it('returns the active subscribers to INVOICE_SENT, de-duplicated', () => {
    expect(
      invoiceCcRecipients({
        contacts: [
          contact({ id: 'cc-a', email: 'Watcher@acme.test', notifications: ['INVOICE_SENT'] }),
          contact({ id: 'cc-b', email: 'watcher@acme.test', notifications: ['INVOICE_SENT', 'DELIVERED'] }),
          contact({ id: 'cc-c', email: 'off@acme.test', notifications: ['INVOICE_SENT'], active: false }),
          contact({ id: 'cc-d', email: 'quiet@acme.test', notifications: ['DELIVERED'] }),
        ],
      }),
    ).toEqual(['watcher@acme.test'])
  })
})

describe('defaultInvoiceAttachments', () => {
  it('attaches the customer\u2019s required docs and the org list, and nothing it may not send', () => {
    const ids = defaultInvoiceAttachments(
      [
        doc({ id: 'sdoc-pod' }),
        doc({ id: 'sdoc-bol', type: 'BOL', orderId: null, loadId: 'ld-1' }),
        doc({ id: 'sdoc-pending', type: 'WEIGHT_TICKET', reviewStatus: 'PENDING' }),
        doc({ id: 'sdoc-internal', type: 'LUMPER_RECEIPT', audience: 'INTERNAL' }),
        doc({ id: 'sdoc-void', type: 'BOL', status: 'VOID' }),
        doc({ id: 'sdoc-other-order', type: 'POD', orderId: 'ord-2', loadId: 'ld-9' }),
        doc({ id: 'sdoc-not-wanted', type: 'PHOTO' }),
      ],
      { id: 'ord-1', loadIds: ['ld-1'] },
      { requiredDocsForInvoice: ['POD', 'WEIGHT_TICKET', 'LUMPER_RECEIPT'] },
      { defaultRequiredDocs: null, invoiceAttachTypes: null },
    )
    expect(ids).toEqual(['sdoc-pod', 'sdoc-bol'])
  })
})

function dataInput(overrides: Partial<InvoiceDataInput> = {}): InvoiceDataInput {
  const stops: Stop[] = [
    {
      id: 'st-1',
      type: 'pickup',
      name: 'Acme Plant',
      city: 'Elgin, IL',
      appt: '2026-03-18T13:00:00.000Z',
      driverId: null,
      sequence: 0,
    },
    {
      id: 'st-2',
      type: 'delivery',
      name: 'Acme DC',
      address: { city: 'Columbus', state: 'OH' },
      appt: '2026-03-19T15:00:00.000Z',
      driverId: null,
      sequence: 1,
    },
  ]
  return {
    invoice: {
      number: 'INV-000042',
      orderId: 'ord-1',
      invoiceDate: '2026-03-20',
      dueAt: '2026-04-19',
      termsDays: 30,
      shipmentNumber: 'B-1042',
      customerName: 'Acme Freight',
      billTo: { name: 'Acme Freight AP', address: { city: 'Elgin', state: 'IL' }, email: 'ap@acme.test' },
      remitTo: { name: 'BCAT Corp', address: null, email: 'ar@bcat.test', noticeText: null },
      lines: [
        { chargeId: 'chg-lh', loadId: 'ld-1', code: 'LINEHAUL', label: 'Linehaul', calculatedBy: 'FLAT', rateCents: 120000, count: 1, amountCents: 120000 },
      ],
      references: [
        PO,
        { code: 'MARGIN_NOTE', label: 'Margin note', value: 'cost 90000, margin 30000', level: 'ORDER', visibility: 'INTERNAL' },
        { code: 'CARRIER_PRO', label: 'Carrier pro', value: 'PRO-9', level: 'ORDER', visibility: 'CARRIER' },
      ],
      subtotalCents: 120000,
      totalCents: 120000,
      factored: false,
    },
    bundle: { shipment: { number: 'B-1042' }, loads: [{ id: 'ld-1', orderId: 'ord-1', stops }] },
    customer: { name: 'Acme Freight', factored: false, billingAddress: null, billingEmail: 'ap@acme.test' },
    division: {
      name: 'BCAT Logistics',
      legalName: 'BCAT Corp',
      mcNumber: 'MC123456',
      dotNumber: '7654321',
      remitToName: 'BCAT Corp',
      remitToAddress: { street: '1 Dock Rd', city: 'Elgin', state: 'IL', zip: '60120' },
      remitToEmail: 'ar@bcat.test',
    },
    settings: { factorRemitTo: null, invoiceTerms: 'Payable in US funds. Interest at 1.5% per month after the due date.' },
    ...overrides,
  }
}

describe('invoiceData', () => {
  it('carries the route, the customer references, the lines and the terms', () => {
    const data = invoiceData(dataInput())

    expect(data.number).toBe('INV-000042')
    expect(data.shipmentNumber).toBe('B-1042')
    expect(data.dueAt).toBe('2026-04-19')
    expect(data.termsDays).toBe(30)
    expect(data.termsText).toBe('Payable in US funds. Interest at 1.5% per month after the due date.')
    expect(data.broker.mcNumber).toBe('MC123456')
    expect(data.remitTo.name).toBe('BCAT Corp')
    expect(data.billTo.name).toBe('Acme Freight AP')
    expect(data.stops).toEqual([
      { kind: 'PICKUP', name: 'Acme Plant', city: 'Elgin', state: 'IL', apptAt: '2026-03-18T13:00:00.000Z' },
      { kind: 'DELIVERY', name: 'Acme DC', city: 'Columbus', state: 'OH', apptAt: '2026-03-19T15:00:00.000Z' },
    ])
    expect(data.references.map((ref) => ref.code)).toEqual(['PO'])
    expect(data.subtotalCents).toBe(120000)
    expect(data.totalCents).toBe(120000)
    expect(data.factored).toBe(false)
    expect(data.factorNoticeText).toBeNull()
  })

  it('prints the factor notice for a factored invoice', () => {
    const base = dataInput()
    const data = invoiceData({
      ...base,
      invoice: {
        ...base.invoice,
        factored: true,
        remitTo: { name: 'TBS Factoring', address: null, email: 'remit@tbs.test', noticeText: 'Assigned to TBS.' },
      },
    })
    expect(data.factored).toBe(true)
    expect(data.factorNoticeText).toBe('Assigned to TBS.')
  })

  it('carries no cost, carrier pay, margin or INTERNAL reference', () => {
    const serialized = JSON.stringify(invoiceData(dataInput()))

    for (const forbidden of ['cost', 'margin', 'carrierPay', 'INTERNAL', 'CARRIER', 'profit']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
    expect(serialized).toContain('120000')
    expect(serialized).not.toContain('90000')
  })

  it('falls back to Net terms when the org has written no terms text', () => {
    const base = dataInput()
    expect(invoiceData({ ...base, settings: { factorRemitTo: null, invoiceTerms: null } }).termsText).toBe('Net 30')
  })
})
