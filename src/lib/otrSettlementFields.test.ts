import { describe, it, expect } from 'vitest'
import { otrSettlementReadiness } from './otrSettlementFields'
import { buildPodIndex } from './podPresence'
import type { Load, Stop } from '@/types'
import type { CustomerRecord, LocationRecord } from '@/types/tms'

function stop(over: Partial<Stop> & { id: string; type: Stop['type'] }): Stop {
  return { appt: '2026-09-29T17:00:00Z', driverId: null, sequence: 0, ...over }
}

function load(over: Partial<Load> = {}): Load {
  return {
    id: 'load-1',
    aljexId: 'PRO123',
    tmsId: 'TMS-1',
    pickupNumber: 'PO-1',
    pickupAppt: '2026-09-28T09:00:00Z',
    deliveryAppt: '2026-09-29T17:00:00Z',
    pickupDriverId: 'drv-1',
    deliveryDriverId: 'drv-1',
    readyToInvoice: false,
    rate: 45000,
    customerId: 'cust-1',
    originCity: 'MESA, AZ',
    destinationCity: 'PHOENIX, AZ',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    createdBy: 'staff',
    updatedBy: 'staff',
    ...over,
  } as Load
}

function customer(over: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: 'cust-1',
    name: 'Broker',
    mcNumber: '123456',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as CustomerRecord
}

function location(over: Partial<LocationRecord> & { id: string }): LocationRecord {
  return { city: 'MESA', state: 'AZ', zip: '85212', ...over } as LocationRecord
}

const maps = (customers: CustomerRecord[], locations: LocationRecord[]) => ({
  customersById: new Map(customers.map((c) => [c.id, c])),
  locationsById: new Map(locations.map((l) => [l.id, l])),
})

describe('otrSettlementReadiness', () => {
  it('lifts a ZIP that only the linked Location has', () => {
    const l = load({
      stops: [
        stop({ id: 'pu', type: 'pickup', locationId: 'loc-pu', sequence: 0 }),
        stop({ id: 'de', type: 'delivery', locationId: 'loc-de', sequence: 1 }),
      ],
    })
    const { customersById, locationsById } = maps(
      [customer()],
      [location({ id: 'loc-pu', zip: '85212' }), location({ id: 'loc-de', zip: '85001' })],
    )
    const r = otrSettlementReadiness({ load: l, customersById, locationsById, podIndex: buildPodIndex({ jobsdoneLoadIds: ['load-1'], submissions: [] }) })
    expect(r.payload.FromZip).toBe('85212')
    expect(r.payload.ToZip).toBe('85001')
    expect(r.sources.FromZip).toBe('location')
  })

  it('recovers a state appended to originCity when no Location is linked', () => {
    const l = load({
      stops: [stop({ id: 'pu', type: 'pickup', sequence: 0 }), stop({ id: 'de', type: 'delivery', sequence: 1 })],
    })
    const { customersById, locationsById } = maps([customer()], [])
    const r = otrSettlementReadiness({ load: l, customersById, locationsById, podIndex: buildPodIndex({ jobsdoneLoadIds: ['load-1'], submissions: [] }) })
    expect(r.payload.FromCity).toBe('MESA')
    expect(r.payload.FromState).toBe('AZ')
  })

  it('reports a load blocked when the linked Customer has no MC number', () => {
    const l = load({
      stops: [
        stop({ id: 'pu', type: 'pickup', locationId: 'loc-pu', sequence: 0 }),
        stop({ id: 'de', type: 'delivery', locationId: 'loc-de', sequence: 1 }),
      ],
      rateConfirmKey: 'rate-confirms/x',
    })
    const { customersById, locationsById } = maps(
      [customer({ mcNumber: null })],
      [location({ id: 'loc-pu', zip: '85212' }), location({ id: 'loc-de', zip: '85001' })],
    )
    const r = otrSettlementReadiness({ load: l, customersById, locationsById, podIndex: buildPodIndex({ jobsdoneLoadIds: ['load-1'], submissions: [] }) })
    expect(r.ready).toBe(false)
    expect(r.missingFields).toEqual(['BrokerMC'])
  })

  it('reports a fully-resolved load as ready', () => {
    const l = load({
      stops: [
        stop({ id: 'pu', type: 'pickup', locationId: 'loc-pu', sequence: 0 }),
        stop({ id: 'de', type: 'delivery', locationId: 'loc-de', sequence: 1 }),
      ],
      rateConfirmKey: 'rate-confirms/x',
    })
    const { customersById, locationsById } = maps(
      [customer()],
      [location({ id: 'loc-pu', zip: '85212' }), location({ id: 'loc-de', zip: '85001' })],
    )
    const r = otrSettlementReadiness({ load: l, customersById, locationsById, podIndex: buildPodIndex({ jobsdoneLoadIds: ['load-1'], submissions: [] }) })
    expect(r.ready).toBe(true)
    expect(r.missingFields).toEqual([])
    expect(r.missingDocuments).toEqual([])
    expect(r.payload).toMatchObject({
      InvoiceNo: 'PRO123',
      PoNumber: 'PO-1',
      BrokerMC: '123456',
      InvoiceAmount: 450,
      InvoiceDate: '2026-09-29',
      FromCity: 'MESA',
      FromState: 'AZ',
      FromZip: '85212',
      ToCity: 'PHOENIX',
      ToState: 'AZ',
      ToZip: '85001',
    })
  })

  it('marks a load without a POD or rate confirmation blocked on documents', () => {
    const l = load({
      stops: [
        stop({ id: 'pu', type: 'pickup', locationId: 'loc-pu', sequence: 0 }),
        stop({ id: 'de', type: 'delivery', locationId: 'loc-de', sequence: 1 }),
      ],
    })
    const { customersById, locationsById } = maps(
      [customer()],
      [location({ id: 'loc-pu', zip: '85212' }), location({ id: 'loc-de', zip: '85001' })],
    )
    const r = otrSettlementReadiness({ load: l, customersById, locationsById, podIndex: buildPodIndex({ jobsdoneLoadIds: [], submissions: [] }) })
    expect(r.ready).toBe(false)
    expect(r.missingDocuments).toEqual(['POD', 'Rate confirmation'])
  })
})
