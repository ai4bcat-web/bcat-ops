import { describe, expect, it } from 'vitest'
import {
  SQUARE_CHANNEL,
  dateOnly,
  idempotencyKey,
  invoiceDescription,
  isSquareChannel,
  mirrorActionFor,
  normalizeCarShipping,
  phoneToE164,
  squareBaseUrl,
  squareBodyLeaks,
  squareCardState,
  squareCustomerBody,
  squareInvoiceBody,
  squareInvoiceNumber,
  squareOrderBody,
} from './squareInvoicing'

const good = {
  payer: { name: 'Pat Example', email: 'Pat@Example.com', phone: '(847) 555-0100' },
  vehicle: { year: '2018', make: 'Honda', model: 'Civic' },
}

describe('normalizeCarShipping', () => {
  it('accepts the six things the form collects and tidies them', () => {
    const r = normalizeCarShipping({ ...good, vehicle: { ...good.vehicle, vin: ' 1hgcm82633a004352 ' } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.payer.email).toBe('pat@example.com')
      expect(r.value.vehicle.vin).toBe('1HGCM82633A004352')
    }
  })

  it.each([
    [{ ...good, payer: { ...good.payer, name: ' ' } }, /name/],
    [{ ...good, payer: { ...good.payer, email: 'nope' } }, /e-mail/],
    [{ ...good, payer: { ...good.payer, phone: '555' } }, /phone/],
    [{ ...good, vehicle: { ...good.vehicle, year: '18' } }, /year/],
    [{ ...good, vehicle: { ...good.vehicle, make: '' } }, /make/],
    [{ ...good, vehicle: { ...good.vehicle, model: '' } }, /model/],
    [null, /missing/],
  ])('refuses incomplete details %#', (input, message) => {
    const r = normalizeCarShipping(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(message)
  })
})

describe('phoneToE164', () => {
  it('takes 10 digits or 11 with a leading 1', () => {
    expect(phoneToE164('(847) 555-0100')).toBe('+18475550100')
    expect(phoneToE164('1-847-555-0100')).toBe('+18475550100')
    expect(phoneToE164('555-0100')).toBeNull()
  })
})

describe('the channel', () => {
  it('is only the Square channel', () => {
    expect(isSquareChannel({ invoiceChannel: SQUARE_CHANNEL })).toBe(true)
    expect(isSquareChannel({ invoiceChannel: null })).toBe(false)
    expect(isSquareChannel(null)).toBe(false)
  })
  it('points each environment at its own Square host', () => {
    expect(squareBaseUrl('SANDBOX')).toBe('https://connect.squareupsandbox.com')
    expect(squareBaseUrl('PRODUCTION')).toBe('https://connect.squareup.com')
  })
})

describe('invoice text and numbers', () => {
  it('puts the vehicle and the route in the description', () => {
    expect(invoiceDescription({ year: '2018', make: 'Honda', model: 'Civic' }, { pickup: 'Chicago, IL', delivery: 'Newton, IA' }))
      .toBe('2018 Honda Civic · Chicago, IL → Newton, IA')
  })
  it('numbers a reissue <PRO>-2', () => {
    expect(squareInvoiceNumber('14730', 0)).toBe('14730')
    expect(squareInvoiceNumber('14730', null)).toBe('14730')
    expect(squareInvoiceNumber('14730', 1)).toBe('14730-2')
  })
  it('derives idempotency keys from the shipment and step so a retry cannot double-create', () => {
    expect(idempotencyKey('shp-1', 'inv')).toBe(idempotencyKey('shp-1', 'inv'))
    expect(idempotencyKey('shp-1', 'inv')).not.toBe(idempotencyKey('shp-1', 'pub'))
    expect(idempotencyKey('shp-1', 'inv', 0)).not.toBe(idempotencyKey('shp-1', 'inv', 1))
  })
  it('cuts a date-time to a date', () => {
    expect(dateOnly('2026-11-27T10:00')).toBe('2026-11-27')
    expect(dateOnly('')).toBeNull()
  })
})

describe('the Square request bodies', () => {
  const customer = squareCustomerBody({ name: 'Pat Q Example', company: 'Example LLC', email: 'pat@example.com', phone: '8475550100' }, 'shp-1', '14730')
  const order = squareOrderBody({ locationId: 'LOC', customerId: 'CUST', pro: '14730', shipmentId: 'shp-1', amountCents: 120900, description: '2018 Honda Civic · Chicago, IL → Newton, IA' })
  const invoice = squareInvoiceBody({
    locationId: 'LOC', orderId: 'ORD', customerId: 'CUST', invoiceNumber: '14730', shipmentId: 'shp-1',
    serviceDate: '2026-10-23', dueDate: '2026-10-27', description: 'x',
  })

  it('makes one "auto transport" line at the full price', () => {
    expect(order.order.line_items).toHaveLength(1)
    expect(order.order.line_items[0]).toMatchObject({ name: 'auto transport', quantity: '1', base_price_money: { amount: 120900, currency: 'USD' } })
  })

  it('is a draft due on receipt, e-mailed by Square, numbered with the PRO, service date = pickup', () => {
    expect(invoice.invoice).toMatchObject({
      invoice_number: '14730',
      delivery_method: 'EMAIL',
      sale_or_service_date: '2026-10-23',
      payment_requests: [{ request_type: 'BALANCE', due_date: '2026-10-27' }],
    })
  })

  it('accepts card always, and bank transfer or Cash App only when switched on', () => {
    expect(invoice.invoice.accepted_payment_methods).toEqual({ card: true, bank_account: false, cash_app_pay: false })
    const more = squareInvoiceBody({
      locationId: 'LOC', orderId: 'ORD', customerId: 'CUST', invoiceNumber: '14730', shipmentId: 'shp-1',
      serviceDate: null, dueDate: '2026-10-27', description: 'x', methods: { bankTransfer: true, cashApp: true },
    })
    expect(more.invoice.accepted_payment_methods).toEqual({ card: true, bank_account: true, cash_app_pay: true })
    expect('sale_or_service_date' in more.invoice).toBe(false)
  })

  it('splits the payer name and keeps a company', () => {
    expect(customer).toMatchObject({ given_name: 'Pat Q', family_name: 'Example', company_name: 'Example LLC', phone_number: '+18475550100' })
  })

  it('never carries carrier pay, cost, margin or a rate con in any body', () => {
    for (const body of [customer, order, invoice]) expect(squareBodyLeaks(body)).toBeNull()
  })

  it('spots a forbidden key anywhere in a body', () => {
    expect(squareBodyLeaks({ order: { line_items: [{ carrierPayCents: 5 }] } })).toContain('carrierPayCents')
    expect(squareBodyLeaks({ invoice: { marginCents: 1 } })).toContain('marginCents')
    expect(squareBodyLeaks({ note: 'Costco Wholesale' })).toBeNull()
  })
})

describe('status mapping', () => {
  it.each([
    ['DRAFT', 'NONE'], ['UNPAID', 'OPEN'], ['SCHEDULED', 'OPEN'], ['PAYMENT_PENDING', 'OPEN'],
    ['PARTIALLY_PAID', 'PARTIAL'], ['PAID', 'PAID'], ['CANCELED', 'VOID'],
    ['FAILED', 'REVIEW'], ['PARTIALLY_REFUNDED', 'REVIEW'], ['REFUNDED', 'REVIEW'], ['???', 'NONE'],
  ])('%s → %s', (status, action) => {
    expect(mirrorActionFor(status)).toBe(action)
  })

  it('leads the card with where the Square side stands', () => {
    expect(squareCardState(undefined)).toBe('NOT_CREATED')
    expect(squareCardState({ invoiceId: 'i', status: 'DRAFT' })).toBe('DRAFT')
    expect(squareCardState({ invoiceId: 'i', status: 'UNPAID' })).toBe('SENT')
    expect(squareCardState({ invoiceId: 'i', status: 'PAID' })).toBe('PAID')
    expect(squareCardState({ invoiceId: 'i', status: 'REFUNDED' })).toBe('REVIEW')
    expect(squareCardState({ invoiceId: 'i', status: 'UNPAID', reviewFlag: 'refund' })).toBe('REVIEW')
  })
})
