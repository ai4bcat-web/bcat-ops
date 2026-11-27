import { describe, expect, it } from 'vitest'
import {
  autoShipperCsv, bothPaid, buildAutoShipperRows, carrierAction, carrierRollupOf, customerAction, carrierUnpaid, customerUnpaid, inRange, inTab, isAutoShipperCustomer,
  isAutoShipperShipment, payerText, rangeStart, summarize, tabCounts, vehicleText, type AutoShipperInput, type AutoShipperRow,
} from './autoShipperLoads'
import type { CarrierBillRecord, InvoiceRecord, LoadCarrierRecord, OrderRecord, ShipmentRecord } from '@/types/tms'
import type { CarShippingData } from '@/lib/squareInvoicing'

const ASOF = '2026-11-27'

const ship = (id: string, number: string, extra: Partial<ShipmentRecord> = {}): ShipmentRecord => ({
  id, number, status: 'DELIVERED', customerId: 'c-auto', customerName: 'AUTO SHIPPER', pickupAppt: '2026-11-20T15:00:00Z', deliveryAppt: '2026-11-24T15:00:00Z',
  originCity: 'Chicago', destinationCity: 'Dallas', ...extra,
} as ShipmentRecord)

const order = (shipmentId: string, extra: Partial<OrderRecord> = {}): OrderRecord => ({ id: `o-${shipmentId}`, shipmentId, customerId: 'c-auto', revenueCents: 120900, ...extra } as OrderRecord)

const invoice = (shipmentId: string, extra: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id: `inv-${shipmentId}`, number: shipmentId.toUpperCase(), shipmentId, customerId: 'c-auto', status: 'ISSUED', invoiceDate: '2026-11-22', issuedAt: '2026-11-22T10:00:00Z',
  totalCents: 120900, paidCents: 0, balanceCents: 120900, ...extra,
} as InvoiceRecord)

const leg = (id: string, shipmentId: string, extra: Partial<LoadCarrierRecord> = {}): LoadCarrierRecord => ({
  id, shipmentId, loadId: `l-${shipmentId}`, kind: 'CARRIER', status: 'ACTIVE', carrierId: `car-${id}`, carrierName: `Carrier ${id}`, carrierRateCents: 90000, ...extra,
} as LoadCarrierRecord)

const bill = (id: string, loadCarrierId: string, shipmentId: string, extra: Partial<CarrierBillRecord> = {}): CarrierBillRecord => ({
  id, loadCarrierId, shipmentId, loadId: `l-${shipmentId}`, carrierId: `car-${loadCarrierId}`, carrierName: `Carrier ${loadCarrierId}`, payeeKind: 'CARRIER',
  status: 'IN_REVIEW', recordedAt: '2026-11-23T10:00:00Z', netCents: 90000, balanceCents: 90000, ...extra,
} as CarrierBillRecord)

const car = (extra: Partial<CarShippingData> = {}): CarShippingData => ({
  payer: { name: 'Pat Doe', email: 'pat@example.com', phone: '5555550100' },
  vehicle: { year: '2021', make: 'Honda', model: 'Accord' },
  ...extra,
})

function build(over: Partial<AutoShipperInput> = {}): AutoShipperRow[] {
  return buildAutoShipperRows({
    shipments: [], orders: [], invoices: [], legs: [], bills: [], carShipping: new Map(), asOf: ASOF, showAr: true, showAp: true, ...over,
  })
}

describe('which customers and shipments are auto shipper', () => {
  it('matches the Square-channel customer and the customer named AUTO SHIPPER, in any spelling', () => {
    expect(isAutoShipperCustomer({ name: 'AUTO SHIPPER', invoiceChannel: null })).toBe(true)
    expect(isAutoShipperCustomer({ name: 'auto shipper', invoiceChannel: null })).toBe(true)
    expect(isAutoShipperCustomer({ name: 'Auto-Shipper', invoiceChannel: null })).toBe(true)
    expect(isAutoShipperCustomer({ name: 'Auto Shipper Inc', invoiceChannel: null })).toBe(false)
    expect(isAutoShipperCustomer({ name: 'Danisco USA', invoiceChannel: 'SQUARE' })).toBe(true)
    expect(isAutoShipperCustomer({ name: 'Danisco USA', invoiceChannel: null })).toBe(false)
    expect(isAutoShipperCustomer(null)).toBe(false)
  })

  it('matches a shipment by customer id, or by name only while no customer is resolved', () => {
    const ids = new Set(['c-auto'])
    expect(isAutoShipperShipment({ customerId: 'c-auto', customerName: 'x' }, ids)).toBe(true)
    expect(isAutoShipperShipment({ customerId: 'c-other', customerName: 'AUTO SHIPPER' }, ids)).toBe(false)
    expect(isAutoShipperShipment({ customerId: null, customerName: 'AUTO SHIPPER' }, ids)).toBe(true)
    expect(isAutoShipperShipment({ customerId: null, customerName: 'Other' }, ids)).toBe(false)
  })
})

describe('the shipment columns', () => {
  it('reads the payer, vehicle, route and dates', () => {
    const [row] = build({ shipments: [ship('s1', '14730')], orders: [order('s1')], carShipping: new Map([['s1', car()]]) })
    expect(row).toMatchObject({ pro: '14730', payer: 'Pat Doe', vehicle: '2021 Honda Accord', route: 'Chicago → Dallas', pickup: '2026-11-20', delivery: '2026-11-24', delivered: true })
  })

  it('prefers the payer company, and falls back to the customer name when no details were entered', () => {
    expect(payerText(car({ payer: { name: 'Pat Doe', company: 'Doe Motors', email: 'a@b.co', phone: '1' } }), 'AUTO SHIPPER')).toBe('Doe Motors')
    expect(payerText(null, 'AUTO SHIPPER')).toBe('AUTO SHIPPER')
    expect(vehicleText(null)).toBe('')
  })

  it('leaves out voided and canceled shipments, newest pickup first', () => {
    const rows = build({
      shipments: [ship('a', '1', { pickupAppt: '2026-11-01T00:00:00Z' }), ship('b', '2', { pickupAppt: '2026-11-10T00:00:00Z' }),
        ship('c', '3', { voidedAt: '2026-11-11T00:00:00Z' }), ship('d', '4', { status: 'CANCELED' })],
    })
    expect(rows.map((r) => r.pro)).toEqual(['2', '1'])
  })
})

describe('what the customer owes', () => {
  const stateOf = (invoices: InvoiceRecord[], orders: OrderRecord[] = [order('s1')]) =>
    build({ shipments: [ship('s1', '14730')], orders, invoices })[0].customer!

  it('is not invoiced, owing the whole price, until an invoice exists', () => {
    expect(stateOf([])).toMatchObject({ state: 'NOT_INVOICED', owedCents: 120900, invoiceNumber: null, daysOutstanding: null })
  })

  it('reads invoiced-unpaid, partly paid and paid off the invoice, with days since the invoice date', () => {
    expect(stateOf([invoice('s1')])).toMatchObject({ state: 'UNPAID', owedCents: 120900, daysOutstanding: 5 })
    expect(stateOf([invoice('s1', { status: 'PARTIAL', paidCents: 50000, balanceCents: 70900 })])).toMatchObject({ state: 'PARTIAL', owedCents: 70900 })
    expect(stateOf([invoice('s1', { status: 'PAID', paidCents: 120900, balanceCents: 0 })])).toMatchObject({ state: 'PAID', owedCents: 0, daysOutstanding: null })
  })

  it('ignores a void invoice and uses the latest live one', () => {
    const rows = stateOf([
      invoice('s1', { id: 'old', number: 'OLD', status: 'VOID', issuedAt: '2026-11-25T00:00:00Z' }),
      invoice('s1', { id: 'new', number: 'NEW', issuedAt: '2026-11-23T00:00:00Z' }),
    ])
    expect(rows.invoiceNumber).toBe('NEW')
  })

  it('falls back to the order\'s cached AR fields when no invoice was read', () => {
    expect(stateOf([], [order('s1', { invoiceNumber: '14730', invoiceId: 'i1', arStatus: 'UNPAID', arBalanceCents: 120900, invoicedAt: '2026-11-22T10:00:00Z' })]))
      .toMatchObject({ state: 'UNPAID', owedCents: 120900, invoiceNumber: '14730', daysOutstanding: 5 })
    expect(stateOf([], [order('s1', { invoiceNumber: '14730', invoiceId: 'i1', arStatus: 'PAID' })])).toMatchObject({ state: 'PAID', owedCents: 0 })
  })

  it('shows the Square status once the shipment carries it', () => {
    const [row] = build({
      shipments: [ship('s1', '14730')], orders: [order('s1')], invoices: [invoice('s1')],
      carShipping: new Map([['s1', car({ square: { status: 'PAID' } })]]),
    })
    expect(row.customer?.squareStatus).toBe('PAID')
    expect(row.customer?.squareLabel).toBeTruthy()
  })
})

describe('what each carrier is owed', () => {
  const carriersOf = (legs: LoadCarrierRecord[], bills: CarrierBillRecord[] = []) =>
    build({ shipments: [ship('s1', '14730')], orders: [order('s1')], legs, bills })[0]

  it('has no carrier until one is assigned', () => {
    const row = carriersOf([])
    expect(row.carriers).toEqual([])
    expect(row.carrierRollup).toBe('NO_CARRIER')
    expect(carrierUnpaid(row)).toBe(false)
  })

  it('reads no bill yet, owing the leg\'s carrier rate', () => {
    const row = carriersOf([leg('L1', 's1')])
    expect(row.carriers![0]).toMatchObject({ state: 'NO_BILL', owedCents: 90000, amountCents: 90000, billId: null })
    expect(row.carrierRollup).toBe('UNPAID')
  })

  it('follows the bill: recorded, approved, scheduled, partly paid, paid', () => {
    const stateFor = (b: Partial<CarrierBillRecord>) => carriersOf([leg('L1', 's1')], [bill('b1', 'L1', 's1', b)]).carriers![0]
    expect(stateFor({ status: 'IN_REVIEW' })).toMatchObject({ state: 'BILL_RECORDED', billId: 'b1' })
    expect(stateFor({ status: 'TO_BE_PAID' }).state).toBe('APPROVED')
    expect(stateFor({ status: 'TO_BE_PAID', selectedForPayment: true }).state).toBe('SCHEDULED')
    expect(stateFor({ status: 'PARTIAL', balanceCents: 40000 })).toMatchObject({ state: 'PARTIAL', owedCents: 40000 })
    expect(stateFor({ status: 'PAID', balanceCents: 0, paidAt: '2026-11-26T12:00:00Z' })).toMatchObject({ state: 'PAID', owedCents: 0, paidAt: '2026-11-26T12:00:00Z' })
  })

  it('ignores a void bill and a bounced leg', () => {
    const row = carriersOf(
      [leg('L1', 's1'), leg('L2', 's1', { status: 'BOUNCED' })],
      [bill('b1', 'L1', 's1', { status: 'VOID' })],
    )
    expect(row.carriers).toHaveLength(1)
    expect(row.carriers![0].state).toBe('NO_BILL')
  })

  it('names who is paid, from the payee the AP page uses', () => {
    const row = build({
      shipments: [ship('s1', '14730')], orders: [order('s1')], legs: [leg('L1', 's1')], bills: [bill('b1', 'L1', 's1')], payTo: () => 'RTS FINANCIAL',
    })[0]
    expect(row.carriers![0].payTo).toBe('RTS FINANCIAL')
  })

  it('an own truck is never payable here', () => {
    const row = carriersOf([leg('L1', 's1', { kind: 'OWN_ASSET', carrierId: null, carrierName: null, driverName: 'Sam' })])
    expect(row.carriers![0].state).toBe('OWN_TRUCK')
    expect(row.carrierRollup).toBe('OWN_TRUCK')
  })

  it('rolls several carriers up: unpaid while any is unpaid, paid once all are', () => {
    const paid = (n: string) => bill(`b${n}`, `L${n}`, 's1', { status: 'PAID', balanceCents: 0 })
    const mixed = carriersOf([leg('L1', 's1', { sequence: 1 }), leg('L2', 's1', { sequence: 2 })], [paid('1')])
    expect(mixed.carrierRollup).toBe('UNPAID')
    const all = carriersOf([leg('L1', 's1'), leg('L2', 's1')], [paid('1'), paid('2')])
    expect(all.carrierRollup).toBe('PAID')
    expect(carrierRollupOf([])).toBe('NO_CARRIER')
  })
})

describe('access: money is not built for a viewer without the grant', () => {
  const inputs = { shipments: [ship('s1', '14730')], orders: [order('s1')], invoices: [invoice('s1')], legs: [leg('L1', 's1')], bills: [bill('b1', 'L1', 's1')] }

  it('without AR there is no price or customer payment', () => {
    const [row] = build({ ...inputs, showAr: false })
    expect(row.priceCents).toBeNull()
    expect(row.customer).toBeNull()
    expect(row.carriers).not.toBeNull()
  })

  it('without AP there is no carrier money at all', () => {
    const [row] = build({ ...inputs, showAp: false })
    expect(row.carriers).toBeNull()
    expect(row.carrierRollup).toBeNull()
    expect(row.customer).not.toBeNull()
  })

  it('without either, the CSV has no money columns and the JSON of the row has no money', () => {
    const rows = build({ ...inputs, showAr: false, showAp: false })
    const csv = autoShipperCsv(rows, { showAr: false, showAp: false })
    expect(csv.split('\r\n')[0]).toBe('PRO,Payer,Pickup,Delivery,Route,Vehicle,Shipment status')
    expect(JSON.stringify(rows)).not.toMatch(/90000|120900|Carrier L1|owed/)
    expect(rows[0]).toMatchObject({ priceCents: null, customer: null, carriers: null })
  })
})

describe('tabs, range and totals', () => {
  const rows = build({
    shipments: [ship('a', '1'), ship('b', '2'), ship('c', '3'), ship('d', '4', { status: 'IN_TRANSIT' })],
    orders: ['a', 'b', 'c', 'd'].map((s) => order(s)),
    invoices: [
      invoice('a', { status: 'PAID', paidCents: 120900, balanceCents: 0 }),
      invoice('b'),
      invoice('c', { status: 'PARTIAL', paidCents: 20900, balanceCents: 100000 }),
    ],
    legs: [leg('La', 'a'), leg('Lb', 'b'), leg('Lc', 'c'), leg('Ld', 'd')],
    bills: [
      bill('ba', 'La', 'a', { status: 'PAID', balanceCents: 0 }),
      bill('bb', 'Lb', 'b', { status: 'TO_BE_PAID', balanceCents: 90000 }),
      bill('bc', 'Lc', 'c', { status: 'PAID', balanceCents: 0 }),
    ],
  })
  const byPro = (pro: string) => rows.find((r) => r.pro === pro)!

  it('puts each load in the tabs it belongs in', () => {
    expect(inTab(byPro('1'), 'paid')).toBe(true)
    expect(bothPaid(byPro('1'))).toBe(true)
    expect(customerUnpaid(byPro('2'))).toBe(true)
    expect(carrierUnpaid(byPro('2'))).toBe(true)
    expect(customerUnpaid(byPro('3'))).toBe(true)
    expect(carrierUnpaid(byPro('3'))).toBe(false)
    expect(customerUnpaid(byPro('4'))).toBe(true)
    expect(tabCounts(rows)).toEqual({ all: 4, 'customer-unpaid': 3, 'carrier-unpaid': 2, paid: 1 })
  })

  it('totals what customers owe and what carriers are still owed on delivered loads', () => {
    const s = summarize(rows)
    expect(s.customersOwe).toEqual({ count: 3, cents: 120900 + 100000 + 120900 })
    expect(s.notInvoiced).toBe(1)
    // Load 4 is not delivered, so its unpaid carrier is not "to pay" yet.
    expect(s.carriersToPay).toEqual({ count: 1, cents: 90000 })
    expect(s.carriersPaid).toBe(2)
  })

  it('keeps a load with no pickup date in every range', () => {
    const row = { ...byPro('1'), pickup: null }
    expect(inRange(row, 'last30', ASOF)).toBe(true)
    expect(inRange({ ...row, pickup: '2026-01-05' }, 'last30', ASOF)).toBe(false)
    expect(inRange({ ...row, pickup: '2026-11-05' }, 'month', ASOF)).toBe(true)
    expect(rangeStart('year', ASOF)).toBe('2026-01-01')
    expect(rangeStart('all', ASOF)).toBeNull()
  })
})

describe('the CSV', () => {
  it('writes the filtered rows with money for a viewer who may see it, quoting commas', () => {
    const rows = build({
      shipments: [ship('s1', '14730')], orders: [order('s1')], invoices: [invoice('s1')], legs: [leg('L1', 's1', { carrierName: 'Smith, Jones & Co' })],
      bills: [bill('b1', 'L1', 's1')], carShipping: new Map([['s1', car()]]),
    })
    const [head, line] = autoShipperCsv(rows, { showAr: true, showAp: true }).split('\r\n')
    expect(head).toContain('Customer owes')
    expect(head).toContain('Carrier payment')
    expect(line).toContain('"Smith, Jones & Co"')
    expect(line).toContain('1209.00')
    expect(line).toContain('Bill recorded')
  })
})


describe('row actions: where Mark paid and Pay carrier go', () => {
  const rowFor = (over: Partial<AutoShipperInput>) => build({ shipments: [ship('s1', '14730')], orders: [order('s1')], ...over })[0]!

  it('Mark paid opens Payments Received on the invoice, with the way back', () => {
    const row = rowFor({ invoices: [invoice('s1')] })
    const a = customerAction(row)!
    expect(a.label).toBe('Mark paid')
    const q = new URLSearchParams(a.to!.split('?')[1])
    expect(a.to!.startsWith('/tms/payments-received?')).toBe(true)
    expect(q.get('record')).toBe('1')
    expect(q.get('customer')).toBe('c-auto')
    expect(q.getAll('invoice')).toEqual(['inv-s1'])
    expect(q.get('from')).toBe('auto-shipper-loads')
  })

  it('a partly paid invoice still says Mark paid; a paid one has no button', () => {
    expect(customerAction(rowFor({ invoices: [invoice('s1', { paidCents: 50000, balanceCents: 70900 })] }))?.label).toBe('Mark paid')
    expect(customerAction(rowFor({ invoices: [invoice('s1', { status: 'PAID', paidCents: 120900, balanceCents: 0 })] }))).toBeNull()
  })

  it('a load not invoiced yet has no Mark paid, and points at Mark invoiced', () => {
    const a = customerAction(rowFor({}))!
    expect(a.to).toBeNull()
    expect(a.label).toBe('Not invoiced yet')
    expect(a.helpTo).toBe('/tms/invoicing?tab=ready')
    expect(a.helpLabel).toBe('Mark invoiced')
  })

  it('has no customer action without the AR grant', () => {
    expect(customerAction(rowFor({ showAr: false, invoices: [invoice('s1')] }))).toBeNull()
  })

  it('a load with no customer on it explains why instead of linking', () => {
    const a = customerAction({ customer: { state: 'UNPAID', invoiceId: 'i', invoiceNumber: '1' } as never, customerId: null })!
    expect(a.to).toBeNull()
    expect(a.note).toMatch(/no customer/i)
  })

  it('a carrier with no bill goes to Record bill on its leg, in Accounts Payable', () => {
    const row = rowFor({ legs: [leg('L1', 's1')] })
    const a = carrierAction(row.carriers![0]!, 's1')!
    expect(a.label).toBe('Record bill')
    const q = new URLSearchParams(a.to!.split('?')[1])
    expect(a.to!.startsWith('/tms/invoicing/payable?')).toBe(true)
    expect(q.get('recordLeg')).toBe('L1')
    expect(q.get('tab')).toBe('expected')
    expect(q.get('from')).toBe('auto-shipper-loads')
  })

  it('a bill still in review goes to the bill, to approve it first; an approved or scheduled one goes to Pay', () => {
    const inReview = rowFor({ legs: [leg('L1', 's1')], bills: [bill('b1', 'L1', 's1')] })
    expect(carrierAction(inReview.carriers![0]!, 's1')).toMatchObject({ label: 'Review bill' })
    expect(new URLSearchParams(carrierAction(inReview.carriers![0]!, 's1')!.to!.split('?')[1]).get('openBill')).toBe('b1')
    for (const extra of [{ status: 'TO_BE_PAID' as const }, { status: 'TO_BE_PAID' as const, selectedForPayment: true }, { status: 'PARTIAL' as const, balanceCents: 40000 }]) {
      const row = rowFor({ legs: [leg('L1', 's1')], bills: [bill('b1', 'L1', 's1', extra)] })
      const a = carrierAction(row.carriers![0]!, 's1')!
      expect(a.label).toBe('Pay carrier')
      expect(new URLSearchParams(a.to!.split('?')[1]).get('payBill')).toBe('b1')
    }
  })

  it('a paid carrier and an own truck have no button, and there are none without the AP grant', () => {
    const paid = rowFor({ legs: [leg('L1', 's1')], bills: [bill('b1', 'L1', 's1', { status: 'PAID', balanceCents: 0, paidAt: '2026-11-26T12:00:00Z' })] })
    expect(carrierAction(paid.carriers![0]!, 's1')).toBeNull()
    const own = rowFor({ legs: [leg('L1', 's1', { kind: 'OWN_ASSET', driverName: 'Sam' })] })
    expect(carrierAction(own.carriers![0]!, 's1')).toBeNull()
    expect(rowFor({ showAp: false, legs: [leg('L1', 's1')] }).carriers).toBeNull()
  })
})
