/**
 * Send to Factor writes a row the OTR submit path already knows how to read.
 *
 * The whole point of this module is that `manageOtr submit` did not have to change: the
 * row it builds has to be indistinguishable from one the invoice-email intake wrote, down
 * to the id being the PRO. These tests pin the handful of values that decide whether a
 * submit succeeds — the id, the amount OTR is asked to buy, the ZIPs it validates, and
 * the PO the broker will look for — plus every reason the office is told no.
 */
import { describe, it, expect } from 'vitest'
import { factoringRowFor, invoicePoNumber, otrFieldsFor, whyNotFactorable } from './factorHandoff'
import type { FactorLoadSlice } from './factorHandoff'
import type { FactoringItem, Stop } from '../types'
import type {
  CustomerRecord,
  InvoiceRecord,
  OrderRecord,
  ShipmentRecord,
} from '../types/tms'

const NOW = '2026-10-28T15:00:00.000Z'

function stop(over: Partial<Stop> & Pick<Stop, 'type' | 'sequence'>): Stop {
  return {
    id: `st-${over.sequence}`,
    appt: '2026-10-20T13:00:00.000Z',
    driverId: null,
    ...over,
  }
}

const STOPS: Stop[] = [
  stop({
    type: 'pickup',
    sequence: 0,
    city: 'Mesa, AZ',
    address: { street: '1 Dock Rd', city: 'Mesa', state: 'az', zip: '85212-2171' },
  }),
  stop({
    type: 'delivery',
    sequence: 1,
    city: 'Reno, NV',
    address: { city: 'Reno', state: 'NV', zip: '89501' },
  }),
  stop({
    type: 'delivery',
    sequence: 2,
    city: 'Sparks, NV',
    address: { city: 'Sparks', state: 'NV', zip: '89431' },
  }),
]

function invoice(over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: 'INV-000412',
    number: 'INV-000412',
    orderId: 'ord-1',
    shipmentId: 'shp-1',
    shipmentNumber: 'BC-10045',
    customerId: 'cus-1',
    status: 'ISSUED',
    invoiceDate: '2026-10-26',
    issuedAt: '2026-10-26T18:00:00.000Z',
    issuedBy: 'ryne@bcat.com',
    dueAt: '2026-11-25',
    termsDays: 30,
    invoiceMonth: '2026-10',
    references: [
      { code: 'MARGIN', value: 'NEVER-LEAVES', level: 'ORDER', visibility: 'INTERNAL' },
      { code: 'PO', value: '44-118', level: 'ORDER', visibility: 'CUSTOMER' },
    ],
    subtotalCents: 185_000,
    totalCents: 185_000,
    paidCents: 0,
    writtenOffCents: 0,
    balanceCents: 185_000,
    arOpen: 'OPEN',
    createdBy: 'ryne@bcat.com',
    updatedBy: 'ryne@bcat.com',
    version: 1,
    ...over,
  }
}

function order(over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'ord-1',
    shipmentId: 'shp-1',
    customerId: 'cus-1',
    mode: 'FTL',
    arStatus: 'UNPAID',
    invoiceId: 'INV-000412',
    createdBy: 'ryne@bcat.com',
    updatedBy: 'ryne@bcat.com',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-26T18:00:00.000Z',
    ...over,
  }
}

function shipment(over: Partial<ShipmentRecord> = {}): ShipmentRecord {
  return {
    id: 'shp-1',
    number: 'BC-10045',
    status: 'DELIVERED',
    customerId: 'cus-1',
    mode: 'FTL',
    source: 'MANUAL',
    createdBy: 'ryne@bcat.com',
    updatedBy: 'ryne@bcat.com',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-26T18:00:00.000Z',
    ...over,
  }
}

function customer(over: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: 'cus-1',
    name: 'AmeriFreight',
    mcNumber: '145382',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

const LOAD: FactorLoadSlice = { id: 'ld-1', aljexId: 'BC-10045-1', shipmentId: 'shp-1' }

function row(over: Partial<Parameters<typeof factoringRowFor>[0]> = {}): FactoringItem {
  return factoringRowFor({
    invoice: invoice(),
    order: order(),
    load: LOAD,
    stops: STOPS,
    customer: customer(),
    caller: 'ryne@bcat.com',
    now: NOW,
    ...over,
  })
}

describe('the queue row Send to Factor writes', () => {
  it('is filed under the load’s PRO, which is what submit resolves', () => {
    /*
     * `id` IS the PRO for every intake-written row, and submit scans Load.aljexId to
     * find the load behind it. A row keyed on anything else — the invoice number, a
     * uuid — would be unresolvable and could never be submitted.
     */
    const r = row()
    expect(r.id).toBe('BC-10045-1')
    expect(r.proNumber).toBe('BC-10045-1')
    expect(r.loadId).toBe('ld-1')
  })

  it('carries the intake’s three e-mail fields, filled from the invoice and the caller', () => {
    const r = row()
    expect(r.subject).toBe('Invoice INV-000412 · BC-10045')
    expect(r.fromEmail).toBe('ryne@bcat.com')
    // Deterministic, so pressing the button twice cannot raise a second row.
    expect(r.messageId).toBe('tms:INV-000412')
    expect(r.receivedAt).toBe(NOW)
    expect(r.status).toBe('NEED_TO_FACTOR')
  })

  it('marks itself as ours and names the invoice, order and shipment it bills', () => {
    const r = row()
    expect(r.source).toBe('TMS')
    expect(r.invoiceId).toBe('INV-000412')
    expect(r.orderId).toBe('ord-1')
    expect(r.shipmentId).toBe('shp-1')
    expect(r.customerId).toBe('cus-1')
  })

  it('prefills all eleven OTR fields as strings', () => {
    const fields = row().otrManualFields ?? {}
    expect(Object.keys(fields).sort()).toEqual([
      'BrokerMC', 'FromCity', 'FromState', 'FromZip', 'InvoiceAmount', 'InvoiceDate',
      'InvoiceNo', 'PoNumber', 'ToCity', 'ToState', 'ToZip',
    ])
    for (const v of Object.values(fields)) expect(typeof v).toBe('string')
  })

  it('states the amount in dollars with two decimals, from the invoice’s cents', () => {
    // OTR bills in dollars; 185000 cents submitted as "185000" would buy a $185,000 load.
    expect(row().otrManualFields?.InvoiceAmount).toBe('1850.00')
    expect(
      otrFieldsFor({ invoice: invoice({ totalCents: 40_500 }), load: LOAD, stops: STOPS, customer: customer() })
        .InvoiceAmount,
    ).toBe('405.00')
  })

  it('sends the five-digit base of a ZIP+4', () => {
    // "85212-2171" is valid on a tender; OTR validates five digits and rejects the rest.
    const fields = row().otrManualFields ?? {}
    expect(fields.FromZip).toBe('85212')
    expect(fields.ToZip).toBe('89431')
  })

  it('takes the first pickup and the LAST delivery, with the state uppercased', () => {
    const fields = row().otrManualFields ?? {}
    expect(fields.FromCity).toBe('Mesa')
    expect(fields.FromState).toBe('AZ')
    // Reno is stop 1; the run ends at Sparks.
    expect(fields.ToCity).toBe('Sparks')
    expect(fields.ToState).toBe('NV')
  })

  it('reads the PO off the customer reference and never an internal one', () => {
    expect(row().otrManualFields?.PoNumber).toBe('44-118')
    expect(invoicePoNumber(invoice({
      references: [{ code: 'PO', value: 'OURS-ONLY', level: 'ORDER', visibility: 'INTERNAL' }],
    }))).toBeUndefined()
    expect(invoicePoNumber(invoice({
      references: [{ code: 'PO', value: 'SHARED-9', level: 'ORDER', visibility: 'ALL' }],
    }))).toBe('SHARED-9')
  })

  it('omits a field it cannot fill rather than writing an empty string', () => {
    /*
     * assembleOtrInvoice treats a present field as answered. An empty PO would therefore
     * be submitted as the broker's PO number, and a blank ZIP would fail OTR's validation
     * with no hint on the row about which value is missing.
     */
    const fields = otrFieldsFor({
      invoice: invoice({ references: [], totalCents: 0 }),
      load: LOAD,
      stops: [stop({ type: 'pickup', sequence: 0 })],
      customer: customer({ mcNumber: '  ' }),
    })
    expect('PoNumber' in fields).toBe(false)
    expect('BrokerMC' in fields).toBe(false)
    expect('InvoiceAmount' in fields).toBe(false)
    expect('FromZip' in fields).toBe(false)
    expect('ToCity' in fields).toBe(false)
    expect(fields.InvoiceNo).toBe('INV-000412')
  })

  it('recovers the state from a "City, ST" stop with no address snapshot', () => {
    const fields = otrFieldsFor({
      invoice: invoice(),
      load: LOAD,
      customer: customer(),
      stops: [
        stop({ type: 'pickup', sequence: 0, city: 'Mesa, AZ' }),
        stop({ type: 'delivery', sequence: 1, city: 'Reno, NV' }),
      ],
    })
    expect(fields.FromState).toBe('AZ')
    expect(fields.ToCity).toBe('Reno')
    expect(fields.ToState).toBe('NV')
  })
})

describe('refusing to send an invoice to the factor', () => {
  const clean = {
    invoice: invoice(),
    order: order(),
    shipment: shipment(),
    customer: customer(),
    load: LOAD,
  }

  it('lets a clean, delivered, unpaid invoice through', () => {
    expect(whyNotFactorable(clean)).toBeNull()
    // An untouched queue row (resolved, never submitted) is not a blocker either.
    expect(whyNotFactorable({
      ...clean,
      existingRow: { proNumber: 'BC-10045-1' } as FactoringItem,
    })).toBeNull()
  })

  it('refuses a voided invoice', () => {
    expect(whyNotFactorable({ ...clean, invoice: invoice({ status: 'VOID' }) }))
      .toMatch(/void/i)
  })

  it('refuses an invoice that is already paid', () => {
    expect(whyNotFactorable({ ...clean, invoice: invoice({ status: 'PAID' }) }))
      .toMatch(/already paid/i)
  })

  it('refuses an invoice the order has since replaced', () => {
    // A void-and-reissue leaves the old invoice readable; factoring it would sell a bill
    // the customer was never sent.
    expect(whyNotFactorable({ ...clean, order: order({ invoiceId: 'INV-000500' }) }))
      .toMatch(/INV-000500/)
  })

  it('refuses a broker with no MC number', () => {
    expect(whyNotFactorable({ ...clean, customer: customer({ mcNumber: null }) }))
      .toMatch(/MC number/i)
  })

  it('refuses freight that has not delivered', () => {
    expect(whyNotFactorable({ ...clean, shipment: shipment({ status: 'IN_TRANSIT' }) }))
      .toMatch(/IN_TRANSIT/)
  })

  it('refuses when there is no load, or the load has no PRO', () => {
    expect(whyNotFactorable({ ...clean, load: null })).toMatch(/no load/i)
    expect(whyNotFactorable({ ...clean, load: { id: 'ld-1', aljexId: null } }))
      .toMatch(/no PRO number/i)
  })

  it('refuses a PRO already submitted, and says which OTR invoice it became', () => {
    const existingRow = { proNumber: 'BC-10045-1', otrInvoiceId: '99812' } as FactoringItem
    expect(whyNotFactorable({ ...clean, existingRow }))
      .toMatch(/already submitted to OTR as invoice 99812/)
  })
})
