// @vitest-environment jsdom
/**
 * The hook's own work is the projection: five reads collapsed into one row per
 * shipment. The cases that matter are the ones a careless join would get wrong — a
 * bounced assignment answering for the truck that is actually on the load, a carrier
 * offer counted as the quote the shipment was sold off, and "the backend sent no stop
 * list" flattened into "this shipment has no stops".
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { LoadCarrierRecord, OrderRecord, QuoteRecord, ShipmentRecord } from '@/types/tms'
import type { LoadBoardSummary } from '@/lib/apiClient'
import { useShipments, type ShipmentListRow } from './useShipments'

const { data } = vi.hoisted(() => ({
  data: {
    shipments: [] as unknown[],
    orders: [] as unknown[],
    loads: [] as unknown[],
    loadCarriers: [] as unknown[],
    quotes: [] as unknown[],
  },
}))

vi.mock('@/lib/apiClient', () => ({
  listShipments: async () => data.shipments,
  listShipmentsByStatus: async () => data.shipments,
  listShipmentsByCustomer: async () => data.shipments,
  listShipmentsByMonth: async () => data.shipments,
  listOrders: async () => data.orders,
  listLoadSummaries: async () => data.loads,
  listLoadCarriers: async () => data.loadCarriers,
  listQuotes: async () => data.quotes,
}))

const shipment = (id: string, patch: Partial<ShipmentRecord> = {}): ShipmentRecord => ({
  id,
  number: id,
  status: 'IN_TRANSIT',
  customerId: 'cust-1',
  mode: 'FTL',
  source: 'MANUAL',
  createdBy: 'a@b.c',
  updatedBy: 'a@b.c',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  ...patch,
})

async function rowsFor(): Promise<ShipmentListRow[]> {
  const { result } = renderHook(() => useShipments())
  await waitFor(() => expect(result.current.loading).toBe(false))
  return result.current.shipments
}

describe('useShipments projection', () => {
  it('reads the carrier, driver, truck and AP rung off the ACTIVE assignment only', async () => {
    data.shipments = [shipment('shp-1')]
    data.orders = []
    data.loads = [{ id: 'lod-1', shipmentId: 'shp-1', assignmentType: 'OWN_ASSET' } satisfies LoadBoardSummary]
    data.loadCarriers = [
      {
        id: 'lc-bounced', loadId: 'lod-1', shipmentId: 'shp-1', status: 'BOUNCED',
        carrierName: 'Bay Logistics', apStatus: 'PAID', createdAt: '2026-03-01T00:00:00.000Z',
      },
      {
        id: 'lc-active', loadId: 'lod-1', shipmentId: 'shp-1', status: 'ACTIVE',
        carrierName: null, driverName: 'Pavel K', truckNumber: '117', apStatus: 'AWAITING_INVOICE',
        createdAt: '2026-03-02T00:00:00.000Z',
      },
    ] as LoadCarrierRecord[]
    data.quotes = []

    const [row] = await rowsFor()
    expect(row.driverName).toBe('Pavel K')
    expect(row.truckNumber).toBe('117')
    expect(row.carrierName).toBeNull()
    expect(row.apStatus).toBe('AWAITING_INVOICE')
  })

  it('counts the stops on the route, and says nothing when no load sent a stop list', async () => {
    data.shipments = [shipment('shp-1'), shipment('shp-2')]
    data.orders = []
    data.loads = [
      { id: 'lod-1', shipmentId: 'shp-1', stops: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] },
      { id: 'lod-2', shipmentId: 'shp-2' },
    ] as LoadBoardSummary[]
    data.loadCarriers = []
    data.quotes = []

    const rows = await rowsFor()
    expect(rows[0].stopCount).toBe(3)
    expect(rows[1].stopCount).toBeNull()
  })

  it('takes the reference and the rep off the order, and the quote off the sell side only', async () => {
    data.shipments = [shipment('shp-1')]
    data.orders = [{
      id: 'ord-1', shipmentId: 'shp-1', customerId: 'cust-1', mode: 'FTL',
      customerRepId: 'dennis',
      references: [{ code: 'PO', value: '' }, { code: 'BOL', value: 'PO-4471' }],
      createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    }] as OrderRecord[]
    data.loads = []
    data.loadCarriers = []
    data.quotes = [
      { id: 'offer-1', side: 'BUY', shipmentId: 'shp-1' },
      { id: 'quote-1', side: 'SELL', shipmentId: 'shp-1' },
    ] as QuoteRecord[]

    const [row] = await rowsFor()
    expect(row.reference).toBe('PO-4471')
    expect(row.customerRepId).toBe('dennis')
    expect(row.quoteId).toBe('quote-1')
  })

  it('folds a multi-leg shipment into one tracking line', async () => {
    data.shipments = [shipment('shp-1')]
    data.orders = []
    data.loads = [
      {
        id: 'lod-1', shipmentId: 'shp-1', openIncidentCount: 1,
        lastKnownAt: '2026-03-02T00:00:00.000Z', lastKnownCity: 'Joliet', lastKnownState: 'IL',
        nextCheckCallAt: '2026-03-04T00:00:00.000Z', trackingProvider: 'MOTIVE',
      },
      {
        id: 'lod-2', shipmentId: 'shp-1', openIncidentCount: 2,
        lastKnownAt: '2026-03-03T00:00:00.000Z', lastKnownCity: 'Gary', lastKnownState: 'IN',
        nextCheckCallAt: '2026-03-03T12:00:00.000Z',
      },
    ] as LoadBoardSummary[]
    data.loadCarriers = []
    data.quotes = []

    const [row] = await rowsFor()
    expect(row.lastUpdatePlace).toBe('Gary, IN')
    expect(row.nextCheckCallAt).toBe('2026-03-03T12:00:00.000Z')
    expect(row.openIncidentCount).toBe(3)
    expect(row.trackingProvider).toBe('MOTIVE')
  })
})
