import { describe, it, expect } from 'vitest'
import { bolData, loadSummaryData } from './documentData'
import type { Stop } from '../types'
import type {
  CustomerRecord, Division, LoadCarrierRecord, LoadChargeRecord, LoadCheckCallRecord,
  LoadFinancialsRecord, LocationRecord, OrderRecord, OrderReference, ShipmentBundle, ShipmentLoad,
  ShipmentRecord,
} from '../types/tms'

const WHO = { createdBy: 'dispatch@bcat.test', updatedBy: 'dispatch@bcat.test' }
const WHEN = { createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }

const references: OrderReference[] = [
  { code: 'PO', label: 'PO', value: 'PO-1', level: 'ORDER', visibility: 'CUSTOMER' },
  { code: 'BOL', label: 'BOL', value: 'BOL-9', level: 'ORDER', visibility: 'ALL' },
  { code: 'INTERNAL_REF', value: 'INT-7', level: 'ORDER', visibility: 'INTERNAL' },
  { code: 'PU', value: 'PU-5', level: 'STOP', stopId: 'st1', visibility: 'CARRIER' },
  { code: 'DEL', value: 'DEL-3', level: 'STOP', stopId: 'st2', visibility: 'ALL' },
]

const pickup: Stop = {
  id: 'st1', type: 'pickup', name: 'Chicago dock', sequence: 0, driverId: null,
  appt: '2026-02-02T15:00:00.000Z', arrivedAt: '2026-02-02T15:10:00.000Z', departedAt: '2026-02-02T16:30:00.000Z',
  address: { street: '10 Dock Rd', city: 'Chicago', state: 'IL', zip: '60601' },
  documentContact: { name: 'Dana Shipper', phone: '312-555-0100' },
  refs: [{ code: 'SEAL', value: 'SEAL-1', level: 'STOP', visibility: 'CUSTOMER' }],
}

const delivery: Stop = {
  id: 'st2', type: 'delivery', name: 'St. Louis DC', sequence: 1, driverId: null,
  appt: '2026-02-03T15:00:00.000Z',
  address: { street: '20 Depot Ave', city: 'St. Louis', state: 'MO', zip: '63101' },
  refs: [{ code: 'DOCK_NOTE', value: 'INTERNAL-STOP-NOTE', level: 'STOP', visibility: 'INTERNAL' }],
}

const load: ShipmentLoad = {
  id: 'l1', loadNumber: 'BC-1001-1', leg: 1, shipmentId: 's1', orderId: 'o1', status: 'DELIVERED',
  equipmentType: 'VAN', commodity: 'Paper goods', weight: 38_000, miles: 296, carrierName: 'Acme Trucking',
  stops: [pickup, delivery],
}

const order: OrderRecord = {
  id: 'o1', shipmentId: 's1', customerId: 'c1', mode: 'FTL', billToId: 'bt1',
  references, equipmentType: 'VAN', equipmentLengthFt: 53,
  specialRequirements: { team: true, tarps: false, straps: false, liftgate: false, hazmat: false },
  freight: [{ id: 'f1', handlingUnit: 'PALLET', qty: 24, description: 'Copy paper', weightLbs: 38_000 }],
  customerNotes: 'Dock 4, no early arrivals.',
  internalNotes: 'Thin margin — do not rebook this lane at this price.',
  customerRateCents: 230_000, revenueCents: 250_000,
  ...WHO, ...WHEN,
}

const bounced: LoadCarrierRecord = {
  id: 'lc1', loadId: 'l1', shipmentId: 's1', kind: 'CARRIER', status: 'BOUNCED', sequence: 1,
  carrierName: 'Bounce Freight', carrierMc: '111222', removalReason: 'CARRIER_BOUNCED',
  removalNote: 'Truck broke down the night before pickup.', bookedAt: '2026-02-01T12:00:00.000Z',
  ...WHO, ...WHEN,
}

const active: LoadCarrierRecord = {
  id: 'lc2', loadId: 'l1', shipmentId: 's1', kind: 'CARRIER', status: 'ACTIVE', sequence: 2,
  carrierName: 'Acme Trucking', carrierMc: '777888', driverName: 'Ray Driver',
  truckNumber: 'T-42', trailerNumber: 'TR-9', costCents: 200_000, bookedAt: '2026-02-01T18:00:00.000Z',
  ...WHO, ...WHEN,
}

const charges: LoadChargeRecord[] = [
  { id: 'ch1', shipmentId: 's1', side: 'CUSTOMER', loadId: 'l1', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 230_000, amountCents: 230_000, isRate: true, sortOrder: 0, createdBy: WHO.createdBy, ...WHEN },
  { id: 'ch2', shipmentId: 's1', side: 'CUSTOMER', loadId: 'l1', code: 'FSC', calculatedBy: 'FLAT', rateCents: 20_000, amountCents: 20_000, isRate: true, sortOrder: 1, createdBy: WHO.createdBy, ...WHEN },
  { id: 'ch3', shipmentId: 's1', side: 'CARRIER', loadId: 'l1', loadCarrierId: 'lc2', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 200_000, amountCents: 200_000, isRate: true, sortOrder: 0, createdBy: WHO.createdBy, ...WHEN },
]

const financials: LoadFinancialsRecord = {
  id: 'l1', loadId: 'l1', shipmentId: 's1', orderId: 'o1',
  customerRateCents: 250_000, revenueCents: 250_000, carrierRateCents: 200_000, costCents: 200_000,
  profitCents: 50_000, marginBps: 2000, updatedBy: WHO.updatedBy, version: 1, ...WHEN,
}

const shipment: ShipmentRecord = {
  id: 's1', number: 'BC-1001', status: 'DELIVERED', customerId: 'c1', customerName: 'Widget Co',
  mode: 'FTL', source: 'MANUAL', ...WHO, ...WHEN,
}

const customer: CustomerRecord = {
  id: 'c1', name: 'Widget Co', contactName: 'Pat Buyer', paymentTermsDays: 30,
  billToParties: [{ id: 'bt1', name: 'Widget Co AP', isDefault: true }],
  ...WHEN,
}

const division: Division = {
  id: 'd1', key: 'BCAT', name: 'BCAT', legalName: 'BCAT Logistics LLC', mcNumber: '123456',
  remitToAddress: { street: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601' },
  active: true, ...WHEN,
}

const locations: LocationRecord[] = []

const bundle: ShipmentBundle = {
  shipment, orders: [order], loads: [load], loadCarriers: [bounced, active], charges,
  financials: [financials], documents: [],
}

const checkCalls: LoadCheckCallRecord[] = [
  {
    id: 'cc1', loadId: 'l1', shipmentId: 's1', at: '2026-02-02T20:00:00.000Z', type: 'INCIDENT',
    source: 'MANUAL', incidentType: 'DETENTION', incidentOpen: 'OPEN', city: 'Springfield', state: 'IL',
    note: 'Two hours on the dock.', createdBy: WHO.createdBy,
  },
  {
    id: 'cc2', loadId: 'l1', shipmentId: 's1', at: '2026-02-02T22:00:00.000Z', type: 'INCIDENT',
    source: 'MANUAL', incidentType: 'DELAY', resolvedAt: '2026-02-02T23:00:00.000Z',
    note: 'Traffic, caught up.', createdBy: WHO.createdBy,
  },
]

/** Every key anywhere in a structure, so a money field cannot hide inside a nested one. */
function deepKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) deepKeys(item, found)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(key)
      deepKeys(child, found)
    }
  }
  return found
}

describe('bolData', () => {
  it('carries CUSTOMER and ALL references and never an INTERNAL or CARRIER one', () => {
    const bol = bolData(bundle, customer, division, locations)
    const values = [...bol.shipper.refs, ...bol.consignee.refs].map((ref) => ref.value)

    expect(values).toContain('PO-1')
    expect(values).toContain('BOL-9')
    expect(values).toContain('SEAL-1')
    expect(values).toContain('DEL-3')
    expect(values).not.toContain('INT-7')
    expect(values).not.toContain('PU-5')
    expect(values).not.toContain('INTERNAL-STOP-NOTE')
  })

  it('puts the delivery reference on the consignee and the order references on the shipper', () => {
    const bol = bolData(bundle, customer, division, locations)

    expect(bol.shipper.refs.map((ref) => ref.value)).toEqual(['PO-1', 'BOL-9', 'SEAL-1'])
    expect(bol.consignee.refs.map((ref) => ref.value)).toEqual(['DEL-3'])
  })

  it('has no money field at all, and prints no internal note', () => {
    const bol = bolData(bundle, customer, division, locations)
    const keys = deepKeys(bol)

    expect(keys.filter((key) => /cent|margin|revenue|cost|profit|charge|rate/i.test(key))).toEqual([])
    const serialized = JSON.stringify(bol)
    expect(serialized).not.toContain('250000')
    expect(serialized).not.toContain('200000')
    expect(serialized).not.toContain('Thin margin')
  })

  it('takes the ends of the move, the BOL number and the carrier that is actually on it', () => {
    const bol = bolData(bundle, customer, division, locations)

    expect(bol.shipmentNumber).toBe('BC-1001')
    expect(bol.bolNumber).toBe('BOL-9')
    expect(bol.shipper.name).toBe('Chicago dock')
    expect(bol.shipper.contact).toBe('Dana Shipper · 312-555-0100')
    expect(bol.consignee.name).toBe('St. Louis DC')
    expect(bol.customer).toEqual({ name: 'Widget Co', billTo: 'Widget Co AP' })
    expect(bol.carrier).toEqual({
      name: 'Acme Trucking', mc: '777888', driverName: 'Ray Driver',
      truckNumber: 'T-42', trailerNumber: 'TR-9',
    })
    expect(bol.specialRequirements).toEqual(['Team'])
    expect(bol.customerNotes).toBe('Dock 4, no early arrivals.')
  })

  it('falls back to the shipment number when nobody issued a BOL number', () => {
    const withoutBol = {
      ...bundle,
      orders: [{ ...order, references: references.filter((ref) => ref.code !== 'BOL') }],
    }

    expect(bolData(withoutBol, customer, division, locations).bolNumber).toBe('BC-1001')
  })
})

describe('loadSummaryData', () => {
  it('reports the cached revenue, cost and margin rather than re-adding the lines', () => {
    const summary = loadSummaryData(bundle, customer, null, checkCalls)

    expect(summary.revenueCents).toBe(financials.revenueCents)
    expect(summary.costCents).toBe(financials.costCents)
    expect(summary.profitCents).toBe(financials.profitCents)
    expect(summary.marginBps).toBe(financials.marginBps)
  })

  it('keeps both sides of the money and labels a charge from the catalog', () => {
    const summary = loadSummaryData(bundle, customer, [{ code: 'FSC', label: 'Fuel surcharge', calculatedBy: 'FLAT' }], checkCalls)

    expect(summary.customerCharges.map((charge) => charge.amountCents)).toEqual([230_000, 20_000])
    expect(summary.customerCharges[1].label).toBe('Fuel surcharge')
    expect(summary.carrierCharges.map((charge) => charge.amountCents)).toEqual([200_000])
  })

  it('keeps a bounced assignment in the history, with why it ended', () => {
    const summary = loadSummaryData(bundle, customer, null, checkCalls)
    const history = summary.assignments.map((assignment) => `${assignment.sequence}:${assignment.status}`)

    expect(history).toEqual(['1:BOUNCED', '2:ACTIVE'])
    const bouncedRow = summary.assignments[0]
    expect(bouncedRow.carrierName).toBe('Bounce Freight')
    expect(bouncedRow.removalReason).toBe('CARRIER_BOUNCED')
    expect(bouncedRow.loadNumber).toBe('BC-1001-1')
  })

  it('shows the stop clocks, every reference and only the incidents still open', () => {
    const summary = loadSummaryData(bundle, customer, null, checkCalls)

    expect(summary.stops[0].arrivedAt).toBe('2026-02-02T15:10:00.000Z')
    expect(summary.stops[0].departedAt).toBe('2026-02-02T16:30:00.000Z')
    expect(summary.stops[1].refs.map((ref) => ref.visibility)).toEqual(['INTERNAL'])
    expect(summary.references.map((ref) => ref.value)).toEqual(['PO-1', 'BOL-9', 'INT-7'])
    expect(summary.incidents.map((incident) => incident.type)).toEqual(['DETENTION'])
    expect(summary.internalNotes).toBe('Thin margin — do not rebook this lane at this price.')
  })
})
