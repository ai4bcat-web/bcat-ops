import { describe, it, expect } from 'vitest'
import {
  bolChips, bolFilename, bolScopeOptions, bolSlot, buildBolModel, BOL_RECEIPT_LINE_ES,
} from './bolModel'
import type { BolBuildOptions } from './bolModel'
import type { Stop } from '../types'
import type {
  CustomerRecord, Division, LoadCarrierRecord, LoadChargeRecord, LocationRecord, OrderRecord,
  OrderReference, ShipmentBundle, ShipmentLoad, ShipmentRecord,
} from '../types/tms'

const WHO = { createdBy: 'dispatch@bcat.test', updatedBy: 'dispatch@bcat.test' }
const WHEN = { createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }

const references: OrderReference[] = [
  { code: 'REF', label: 'Ref', value: 'REF-2', level: 'ORDER', visibility: 'ALL' },
  { code: 'PO', label: 'PO', value: 'PO-1', level: 'ORDER', visibility: 'CUSTOMER' },
  { code: 'BOL', label: 'BOL', value: 'CUST-BOL-9', level: 'ORDER', visibility: 'ALL' },
  { code: 'DUP', label: 'Ref', value: 'REF-2', level: 'ORDER', visibility: 'CUSTOMER' },
  { code: 'INTERNAL_REF', value: 'INT-7', level: 'ORDER', visibility: 'INTERNAL' },
  { code: 'CARRIER_REF', value: 'CAR-ONLY-8', level: 'ORDER', visibility: 'CARRIER' },
  { code: 'DEL', value: 'DEL-3', level: 'STOP', stopId: 'st2', visibility: 'ALL' },
]

const pickup: Stop = {
  id: 'st1', type: 'pickup', name: 'Chicago dock', sequence: 0, driverId: null,
  appt: '2026-02-02T15:00:00.000Z',
  address: { street: '10 Dock Rd', city: 'Chicago', state: 'IL', zip: '60601' },
  documentContact: { name: 'Dana Shipper', phone: '312-555-0100' },
  refs: [{ code: 'SEAL', value: 'SEAL-1', level: 'STOP', visibility: 'CUSTOMER' }],
}
const pickup2: Stop = {
  id: 'st1b', type: 'pickup', name: 'Gary yard', sequence: 1, driverId: null, appt: '2026-02-02T17:00:00.000Z',
  address: { city: 'Gary', state: 'IN' },
}
const delivery1: Stop = {
  id: 'st2', type: 'delivery', name: 'Kroger', sequence: 2, driverId: null, appt: '2026-02-03T15:00:00.000Z',
  address: { street: '20 Depot Ave', city: 'Dallas', state: 'TX', zip: '75001' },
  pieces: 10, weightLbs: 9_000,
  refs: [
    { code: 'DOCK', value: 'DOCK-4', level: 'STOP', visibility: 'ALL' },
    { code: 'NOTE', value: 'INTERNAL-STOP-NOTE', level: 'STOP', visibility: 'INTERNAL' },
  ],
}
const delivery2: Stop = {
  id: 'st3', type: 'delivery', name: 'Walmart', sequence: 3, driverId: null, appt: '2026-02-04T15:00:00.000Z',
  address: { street: '5 Main', city: 'Austin', state: 'TX', zip: '73301' },
  contact: { name: 'Gil Dock', phone: '512-555-0188' },
}

const load: ShipmentLoad = {
  id: 'l1', loadNumber: 'BC-1001-1', leg: 1, shipmentId: 's1', orderId: 'o1', status: 'DELIVERED',
  equipmentType: 'VAN', commodity: 'Paper goods', weight: 38_000, pieces: 24, piecesUnit: 'CARTONS',
  cargoValueCents: 12_345_600, stops: [pickup, pickup2, delivery1, delivery2],
}

const order: OrderRecord = {
  id: 'o1', shipmentId: 's1', customerId: 'c1', mode: 'FTL', billToId: 'bt1', references,
  specialRequirements: {
    hazmat: true, team: true, tarps: true, straps: true, liftgate: false, inside: true,
    tempControl: true, tempF: { target: 36, min: 34, max: 38 }, palletExchange: true, palletsIn: 2, palletsOut: 3,
    permit: true, fsma: true, oversize: true, escort: true, sealRequired: true, blind: true, customsBond: 'CB-1',
    labor: true, highRisk: true, massRelease: true, noBroker: true,
    form: { v: 1, ship: { tarpSize: '8ft' }, instructions: { special: 'Call before arrival' } },
  },
  freight: [
    { id: 'frt-main', handlingUnit: 'PALLET', qty: 24, description: 'Copy paper', weightLbs: 30_000, freightClass: '70' },
    { id: 'f2', handlingUnit: 'CRATE', qty: 2, description: 'Solvent', weightLbs: 8_000, hazmat: { un: '1993', hazClass: '3', emergencyContact: '1' } },
  ],
  customerNotes: 'Dock 4, no early arrivals.',
  internalNotes: 'Thin margin — do not rebook this lane',
  customerRateCents: 230_000, revenueCents: 250_000,
  ...WHO, ...WHEN,
}

const active: LoadCarrierRecord = {
  id: 'lc2', loadId: 'l1', shipmentId: 's1', kind: 'CARRIER', status: 'ACTIVE', sequence: 2,
  carrierName: 'Acme Trucking', carrierMc: '777888', driverName: 'Ray Driver', driverPhone: '555-0100',
  truckNumber: 'T-42', trailerNumber: 'TR-9', sealNumber: 'S-77', costCents: 200_000, ...WHO, ...WHEN,
}
const bounced: LoadCarrierRecord = { ...active, id: 'lc1', status: 'BOUNCED', carrierName: 'Bounce Freight', sequence: 1 }

const charge = (id: string, side: 'CUSTOMER' | 'CARRIER', label: string, amountCents: number): LoadChargeRecord => ({
  id, shipmentId: 's1', side, loadId: 'l1', code: label.toUpperCase(), label, calculatedBy: 'FLAT',
  rateCents: amountCents, amountCents, isRate: true, sortOrder: 0, createdBy: WHO.createdBy, ...WHEN,
})
const charges = [
  charge('c1', 'CUSTOMER', 'Linehaul', 230_000),
  charge('c2', 'CUSTOMER', 'Fuel surcharge', 20_000),
  charge('c3', 'CARRIER', 'Carrier haul secret', 199_999),
]

const shipment: ShipmentRecord = {
  id: 's1', number: '14913', status: 'DELIVERED', customerId: 'c1', customerName: 'Widget Co',
  mode: 'FTL', source: 'MANUAL', ...WHO, ...WHEN,
}
const customer: CustomerRecord = {
  id: 'c1', name: 'Widget Co', billToParties: [{ id: 'bt1', name: 'Widget Co AP', isDefault: true }], ...WHEN,
}
const division: Division = {
  id: 'd1', key: 'BCAT', name: 'BCAT', legalName: 'BCAT Logistics LLC', mcNumber: '123456', dotNumber: '654',
  physicalAddress: { street: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601' },
  phone: '312-555-0000', logoKey: 'brand/logo.png', active: true, ...WHEN,
}
const locations: LocationRecord[] = []

const bundle: ShipmentBundle = {
  shipment, orders: [order], loads: [load], loadCarriers: [bounced, active], charges, financials: [], documents: [],
}

const master: BolBuildOptions = { scope: { kind: 'MASTER' }, includeRates: false, language: 'EN' }
const deliveryTwo: BolBuildOptions = { ...master, scope: { kind: 'STOP', stopId: 'st3' } }

function deepKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => deepKeys(item, found))
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(key)
      deepKeys(child, found)
    }
  }
  return found
}

describe('freight lines', () => {
  it('prints every Items line, unit from the load for the form default pallet', () => {
    const model = buildBolModel(bundle, customer, division, locations, master)
    expect(model.lines.map((l) => [l.qty, l.unit, l.description])).toEqual([
      [24, 'CARTONS', 'Copy paper'],
      [2, 'CRATE', 'Solvent'],
    ])
    expect(model.lines[1].hazmat).toBe('UN1993 · 3')
    expect(model.totals).toEqual({ pieces: 26, weightLbs: 38_000 })
    expect(model.declaredValue).toBe('$123,456.00')
  })

  it('makes one line from the load when there are no Items, and never an empty table', () => {
    const bare = { ...bundle, orders: [{ ...order, freight: [] }] }
    const model = buildBolModel(bare, customer, division, locations, master)
    expect(model.lines).toEqual([{
      qty: 24, unit: 'CARTONS', description: 'Paper goods', weightLbs: 38_000,
      freightClass: null, nmfc: null, hazmat: 'Hazmat — see shipper paperwork',
    }])

    const legacy = {
      ...bundle,
      orders: [{ ...order, freight: null, specialRequirements: null }],
      loads: [{ ...load, commodity: null, weight: null, pieces: null, piecesUnit: null }],
    }
    const empty = buildBolModel(legacy, customer, division, locations, master)
    expect(empty.lines).toHaveLength(1)
    expect(empty.lines[0].description).not.toBe('')
  })
})

describe('scope', () => {
  it('lists every stop on the master and the intermediate ones too', () => {
    const model = buildBolModel(bundle, customer, division, locations, master)
    expect(model.stops.map((s) => [s.seq, s.kind, s.name])).toEqual([
      [1, 'PICKUP', 'Chicago dock'], [2, 'PICKUP', 'Gary yard'], [3, 'DELIVERY', 'Kroger'], [4, 'DELIVERY', 'Walmart'],
    ])
    expect(model.shipper.name).toBe('Chicago dock')
    expect(model.shipper.alsoPickedUp).toEqual(['Gary yard, Gary IN'])
    expect(model.consignee.name).toBe('Walmart')
    expect(model.stops.find((s) => s.name === 'Kroger')?.refs.map((r) => r.value)).toEqual(['DEL-3', 'DOCK-4'])
  })

  it('builds one delivery with its own consignee, refs and contact', () => {
    const one = buildBolModel(bundle, customer, division, locations, {
      ...master, scope: { kind: 'STOP', stopId: 'st2', n: 1 },
    })
    expect(one.stops).toEqual([])
    expect(one.consignee.name).toBe('Kroger')
    expect(one.consignee.refs.map((r) => r.value)).toEqual(['DEL-3', 'DOCK-4'])
    expect(one.shipper.refs.map((r) => r.value)).toEqual(['SEAL-1'])
    expect(one.scopeLabel).toContain('Delivery 1 of 2')
    expect(one.scopeLabel).toContain('Kroger, Dallas TX')

    const two = buildBolModel(bundle, customer, division, locations, deliveryTwo)
    expect(two.consignee.name).toBe('Walmart')
    expect(two.consignee.contact).toBe('Gil Dock · 512-555-0188')
  })

  it("uses the stop's own pieces and weight, or the shipment total with a note", () => {
    const one = buildBolModel(bundle, customer, division, locations, { ...master, scope: { kind: 'STOP', stopId: 'st2' } })
    expect(one.lines).toHaveLength(1)
    expect(one.lines[0]).toMatchObject({ qty: 10, weightLbs: 9_000, description: 'Copy paper' })
    expect(one.linesNote).toBeNull()

    const two = buildBolModel(bundle, customer, division, locations, deliveryTwo)
    expect(two.lines).toHaveLength(2)
    expect(two.linesNote).toMatch(/master/i)
  })

  it('refuses a stop that is not a delivery of the shipment', () => {
    expect(() => buildBolModel(bundle, customer, division, locations, {
      ...master, scope: { kind: 'STOP', stopId: 'st1' },
    })).toThrow()
  })

  it('offers only the master for one delivery, and a list for two', () => {
    expect(bolScopeOptions(bundle).map((o) => o.scope.kind)).toEqual(['MASTER', 'STOP', 'STOP'])
    const oneDelivery = { ...bundle, loads: [{ ...load, stops: [pickup, delivery1] }] }
    expect(bolScopeOptions(oneDelivery)).toHaveLength(1)
  })

  it('gives each scope its own slot and filename', () => {
    expect(bolSlot({ kind: 'MASTER' }, false)).toEqual({ stopId: null, loadCarrierId: null, rated: false })
    expect(bolSlot({ kind: 'STOP', stopId: 'st3' }, true)).toEqual({ stopId: 'st3', loadCarrierId: null, rated: true })
    expect(bolFilename('14913', 1, { kind: 'MASTER' }, false)).toBe('bol-14913-v1.pdf')
    expect(bolFilename('14913', 2, { kind: 'STOP', stopId: 'st3', n: 2 }, false)).toBe('bol-14913-d2-v2.pdf')
    expect(bolFilename('14913', 1, { kind: 'MASTER' }, true)).toBe('bol-14913-rated-v1.pdf')
  })
})

describe('references', () => {
  const model = buildBolModel(bundle, customer, division, locations, master)

  it('prints PO first, only CUSTOMER and ALL refs, without duplicates', () => {
    expect(model.references.map((r) => r.value)).toEqual(['PO-1', 'REF-2', 'CUST-BOL-9'])
    expect(model.customer.poRef).toBe('PO-1')
    const serialized = JSON.stringify(model)
    for (const hidden of ['INT-7', 'CAR-ONLY-8', 'INTERNAL-STOP-NOTE']) expect(serialized).not.toContain(hidden)
  })

  it('uses the PRO as the BOL number even when the customer has their own', () => {
    expect(model.bolNumber).toBe('14913')
    expect(model.references.find((r) => r.value === 'CUST-BOL-9')?.label).toMatch(/BOL/)
  })
})

describe('chips', () => {
  it('prints the allow-listed requirements in order and nothing office-only', () => {
    const chips = bolChips(order)
    expect(chips).toEqual([
      'Hazmat', 'Team', 'Tarps 8ft', 'Straps/Chains', 'Inside delivery', 'Temp control 34–38°F',
      'Pallet exchange in 2 / out 3', 'Permits', 'FSMA', 'Oversize', 'Escorts', 'Seal required', 'Blind',
      'Customs bonded', 'Labor', 'High risk', 'Mass release',
    ])
    expect(chips.join(' ')).not.toMatch(/broker|hot|tonu|osd/i)
  })

  it('prints plain tarps and no chips for an order without requirements', () => {
    expect(bolChips({ specialRequirements: { tarps: true } })).toEqual(['Tarps'])
    expect(bolChips(null)).toEqual([])
  })
})

describe('header, carriers and notes', () => {
  const model = buildBolModel(bundle, customer, division, locations, master)

  it('takes the letterhead from the division and the phone from the division first', () => {
    expect(model.broker).toEqual({
      legalName: 'BCAT Logistics LLC', address: '1 Main St\nChicago, IL 60601', phone: '312-555-0000',
      mc: '123456', dot: '654', logoKey: 'brand/logo.png',
    })
    const fallback = buildBolModel(bundle, customer, { ...division, phone: null }, locations, { ...master, brokerPhone: '800-555-1' })
    expect(fallback.broker.phone).toBe('800-555-1')
  })

  it('lists only active carriers, with seal, and carries notes and instructions', () => {
    expect(model.carriers).toHaveLength(1)
    expect(model.carriers[0]).toMatchObject({ name: 'Acme Trucking', driverName: 'Ray Driver', sealNumber: 'S-77', truckNumber: 'T-42' })
    expect(model.bolNotes).toBe('Dock 4, no early arrivals.')
    expect(model.specialInstructions).toBe('Call before arrival')
    expect(model.customer).toEqual({ name: 'Widget Co', billTo: 'Widget Co AP', poRef: 'PO-1' })
  })

  it('tolerates a missing customer, division and locations', () => {
    const bare = buildBolModel({ ...bundle, loadCarriers: [] }, null, null, [], master)
    expect(bare.broker.legalName).toBe('Broker')
    expect(bare.customer.name).toBe('Widget Co')
    expect(bare.carriers).toEqual([])
  })

  it('adds the Spanish receipt line only when asked', () => {
    expect(model.receiptLineEs).toBeNull()
    expect(buildBolModel(bundle, customer, division, locations, { ...master, language: 'EN_ES' }).receiptLineEs)
      .toBe(BOL_RECEIPT_LINE_ES)
  })
})

describe('money', () => {
  it('has no money by default', () => {
    const model = buildBolModel(bundle, customer, division, locations, master)
    expect(deepKeys(model).filter((key) => /cent|margin|revenue|cost|profit|charge|rate/i.test(key))).toEqual([])
    expect('rates' in model).toBe(false)
    const serialized = JSON.stringify(model)
    for (const secret of ['250000', '230000', '199999', 'Thin margin']) expect(serialized).not.toContain(secret)
  })

  it('carries customer lines only on a rated copy', () => {
    const model = buildBolModel(bundle, customer, division, locations, { ...master, includeRates: true })
    expect(model.rates).toEqual({
      lines: [{ label: 'Linehaul', amountCents: 230_000 }, { label: 'Fuel surcharge', amountCents: 20_000 }],
      totalCents: 250_000,
    })
    const serialized = JSON.stringify(model)
    expect(serialized).not.toContain('Carrier haul secret')
    expect(serialized).not.toContain('199999')
  })
})
