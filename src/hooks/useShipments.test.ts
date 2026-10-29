// @vitest-environment jsdom
/**
 * The hook's own work is the projection: five reads collapsed into one row per
 * shipment. The cases that matter are the ones a careless join would get wrong — a
 * bounced assignment answering for the truck that is actually on the load, a carrier
 * offer counted as the quote the shipment was sold off, and "the backend sent no stop
 * list" flattened into "this shipment has no stops".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type {
  CarrierRecord, CustomerRecord, LoadCarrierRecord, LoadFinancialsRecord, OrderRecord, QuoteRecord, ShipmentRecord,
  UserProfileRecord,
} from '@/types/tms'
import type { LoadBoardSummary } from '@/lib/apiClient'
import { useShipments, type ShipmentListRow } from './useShipments'

const { data } = vi.hoisted(() => ({
  data: {
    shipments: [] as unknown[],
    orders: [] as unknown[],
    loads: [] as unknown[],
    loadCarriers: [] as unknown[],
    quotes: [] as unknown[],
    loadFinancials: [] as unknown[],
    userProfiles: [] as unknown[],
    customers: [] as unknown[],
    carriers: [] as unknown[],
    drivers: [] as unknown[],
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
  listLoadFinancials: async () => data.loadFinancials,
  listUserProfiles: async () => data.userProfiles,
  listCustomers: async () => data.customers,
  listCarriers: async () => data.carriers,
  listDrivers: async () => data.drivers,
}))

beforeEach(() => {
  data.shipments = []
  data.orders = []
  data.loads = []
  data.loadCarriers = []
  data.quotes = []
  data.loadFinancials = []
  data.userProfiles = []
  data.customers = []
  data.carriers = []
  data.drivers = []
})

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

  it('projects LoadFinancials money onto the row and derives margin from revenue', async () => {
    data.shipments = [shipment('shp-1')]
    data.orders = []
    data.loads = [{ id: 'lod-1', shipmentId: 'shp-1' } as LoadBoardSummary]
    data.loadFinancials = [{
      id: 'lod-1', loadId: 'lod-1', shipmentId: 'shp-1', orderId: 'ord-1',
      customerRateCents: 250_000, revenueCents: 250_000, carrierRateCents: 200_000,
      costCents: 200_000, profitCents: 50_000, marginBps: 2000,
      updatedBy: 'a@b.c', version: 1, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    }] as LoadFinancialsRecord[]

    const [row] = await rowsFor()
    expect(row.revenueCents).toBe(250_000)
    expect(row.costCents).toBe(200_000)
    expect(row.profitCents).toBe(50_000)
    expect(row.marginBps).toBe(2000)
  })

  it('leaves marginBps null instead of 0 when revenue is unknown', async () => {
    data.shipments = [shipment('shp-1')]
    data.orders = []
    data.loads = [{ id: 'lod-1', shipmentId: 'shp-1' } as LoadBoardSummary]
    data.loadFinancials = []

    const [row] = await rowsFor()
    expect(row.revenueCents).toBeNull()
    expect(row.profitCents).toBeNull()
    expect(row.marginBps).toBeNull()
  })

  it('reports null money for a multi-leg shipment when any leg lacks financials', async () => {
    data.shipments = [shipment('shp-1', { loadIds: ['lod-1', 'lod-2'] })]
    data.orders = []
    data.loads = [
      { id: 'lod-1', shipmentId: 'shp-1' } as LoadBoardSummary,
      { id: 'lod-2', shipmentId: 'shp-1' } as LoadBoardSummary,
    ]
    data.loadFinancials = [{
      id: 'fin-1', loadId: 'lod-1', shipmentId: 'shp-1', orderId: 'ord-1',
      customerRateCents: 250_000, revenueCents: 250_000, carrierRateCents: 200_000,
      costCents: 200_000, profitCents: 50_000, marginBps: 2000,
      updatedBy: 'a@b.c', version: 1, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    }] as LoadFinancialsRecord[]

    const [row] = await rowsFor()
    expect(row.revenueCents).toBeNull()
    expect(row.costCents).toBeNull()
    expect(row.profitCents).toBeNull()
    expect(row.marginBps).toBeNull()
  })

  it('sums money across every load when all legs have financials', async () => {
    data.shipments = [shipment('shp-1', { loadIds: ['lod-1', 'lod-2'] })]
    data.orders = []
    data.loads = [
      { id: 'lod-1', shipmentId: 'shp-1' } as LoadBoardSummary,
      { id: 'lod-2', shipmentId: 'shp-1' } as LoadBoardSummary,
    ]
    data.loadFinancials = [
      {
        id: 'fin-1', loadId: 'lod-1', shipmentId: 'shp-1', orderId: 'ord-1',
        customerRateCents: 150_000, revenueCents: 150_000, carrierRateCents: 100_000,
        costCents: 100_000, profitCents: 50_000, marginBps: 3333,
        updatedBy: 'a@b.c', version: 1, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
      },
      {
        id: 'fin-2', loadId: 'lod-2', shipmentId: 'shp-1', orderId: 'ord-1',
        customerRateCents: 100_000, revenueCents: 100_000, carrierRateCents: 80_000,
        costCents: 80_000, profitCents: 20_000, marginBps: 2000,
        updatedBy: 'a@b.c', version: 1, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ] as LoadFinancialsRecord[]

    const [row] = await rowsFor()
    expect(row.revenueCents).toBe(250_000)
    expect(row.costCents).toBe(180_000)
    expect(row.profitCents).toBe(70_000)
    expect(row.marginBps).toBe(2800)
  })

  it('reads pickup, consignee and both states from the stop array', async () => {
    data.shipments = [shipment('shp-1', { loadIds: ['lod-1'] })]
    data.orders = []
    data.loads = [{
      id: 'lod-1', shipmentId: 'shp-1',
      stops: [
        { id: 's1', type: 'pickup', sequence: 0, appt: '2026-03-01T10:00:00.000Z', driverId: null, name: 'Acme Shipping', city: 'Dallas, TX' },
        { id: 's2', type: 'delivery', sequence: 1, appt: '2026-03-02T10:00:00.000Z', driverId: null, name: 'Beta Receiving', city: 'Austin, TX' },
      ],
    } as LoadBoardSummary]

    const [row] = await rowsFor()
    expect(row.pickupName).toBe('Acme Shipping')
    expect(row.consigneeName).toBe('Beta Receiving')
    expect(row.fromState).toBe('TX')
    expect(row.toState).toBe('TX')
    expect(row.stops).toHaveLength(2)
  })

  it('falls back to the load mirror city string for states when there are no stops', async () => {
    data.shipments = [shipment('shp-1', { loadIds: ['lod-1'] })]
    data.orders = []
    data.loads = [{
      id: 'lod-1', shipmentId: 'shp-1',
      originName: 'Acme Shipping', originCity: 'Dallas, TX',
      destinationName: 'Beta Receiving', destinationCity: 'Chicago, IL',
    } as LoadBoardSummary]

    const [row] = await rowsFor()
    expect(row.pickupName).toBe('Acme Shipping')
    expect(row.consigneeName).toBe('Beta Receiving')
    expect(row.fromState).toBe('TX')
    expect(row.toState).toBe('IL')
    expect(row.stops).toBeNull()
  })

  it('resolves officeTeamKeys from the sales rep profile and stays null for an unknown rep', async () => {
    data.shipments = [
      shipment('shp-1', { salesRepId: 'rep@bcat.io' }),
      shipment('shp-2', { salesRepId: 'unknown@bcat.io' }),
    ]
    data.orders = []
    data.loads = []
    data.userProfiles = [{
      id: 'rep@bcat.io', email: 'rep@bcat.io', teamKeys: ['TEAM-A', 'TEAM-B'],
      createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    }] as UserProfileRecord[]

    const rows = await rowsFor()
    expect(rows[0].officeTeamKeys).toEqual(['TEAM-A', 'TEAM-B'])
    expect(rows[1].officeTeamKeys).toBeNull()
  })

  it('breaks the order references out and projects the order and quote facts', async () => {
    data.shipments = [shipment('shp-1')]
    data.orders = [{
      id: 'ord-1', shipmentId: 'shp-1', customerId: 'cust-1', mode: 'FTL',
      billToId: 'bt-1', costCenter: 'CC-9', rateType: 'CONTRACT',
      references: [
        { code: 'PO', value: 'PO-1', level: 'ORDER', visibility: 'ALL' },
        { code: 'PU', value: 'PU-2', level: 'ORDER', visibility: 'ALL' },
        { code: 'DEL', value: 'DEL-3', level: 'ORDER', visibility: 'ALL' },
        { code: 'BOL', value: 'BOL-4', level: 'ORDER', visibility: 'ALL' },
      ],
      freight: [
        { id: 'f1', handlingUnit: 'PALLET', qty: 4, description: 'Paper', weightLbs: 20000 },
        { id: 'f2', handlingUnit: 'BOX', qty: 10, description: 'Labels', weightLbs: 1000 },
      ],
      customerRateCents: 250_000, revenueCents: 260_000, invoiceNumber: 'INV-9',
      arBalanceCents: 260_000, docsRequired: ['POD', 'BOL'],
      createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    } as OrderRecord]
    data.customers = [{
      id: 'cust-1', name: 'Acme Freight', mcNumber: 'MC-1', dotNumber: 'DOT-2',
      factored: true, paymentTermsDays: 30, creditLimitCents: 500_000_00, creditHoldFlag: false,
      status: 'ACTIVE', serviceTier: 'GOLD', teamKey: 'TEAM-A',
      accountOwnerIds: ['rep@bcat.io'], defaultSalesRepId: 'rep@bcat.io', invoiceFrequency: 'WEEKLY',
      billToParties: [{ id: 'bt-1', name: 'Acme Billing LLC' }],
      createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    }] as CustomerRecord[]
    data.userProfiles = [{
      id: 'rep@bcat.io', email: 'rep@bcat.io', name: 'Dennis',
      createdBy: 'a@b.c', updatedBy: 'a@b.c', version: 1, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    }] as UserProfileRecord[]
    data.quotes = [{ id: 'Q000012', side: 'SELL', shipmentId: 'shp-1', amountCents: 240_000 } as QuoteRecord]

    const [row] = await rowsFor()
    expect(row.refPo).toBe('PO-1')
    expect(row.refPu).toBe('PU-2')
    expect(row.refDelivery).toBe('DEL-3')
    expect(row.refBol).toBe('BOL-4')
    expect(row.billToName).toBe('Acme Billing LLC')
    expect(row.rateType).toBe('CONTRACT')
    expect(row.orderCommodity).toBe('Paper, Labels')
    expect(row.freightWeightLbs).toBe(21000)
    expect(row.freightPieces).toBe(14)
    expect(row.freightPallets).toBe(4)
    expect(row.customerRateCents).toBe(250_000)
    expect(row.orderRevenueCents).toBe(260_000)
    expect(row.invoiceNumber).toBe('INV-9')
    expect(row.arBalanceCents).toBe(260_000)
    expect(row.docsRequired).toEqual(['POD', 'BOL'])
    expect(row.quoteNumber).toBe('Q000012')
    expect(row.quoteAmountCents).toBe(240_000)
    // Customer directory, with owners and the default rep resolved to names.
    expect(row.customerMc).toBe('MC-1')
    expect(row.customerFactored).toBe(true)
    expect(row.customerPaymentTermsDays).toBe(30)
    expect(row.creditLimitCents).toBe(50_000_000)
    expect(row.customerOwnerNames).toBe('Dennis')
    expect(row.defaultSalesRepName).toBe('Dennis')
  })

  it('folds the legs and the ACTIVE assignment into the carrier-leg and load facts', async () => {
    data.shipments = [shipment('shp-1', { loadIds: ['lod-1'] })]
    data.loads = [{
      id: 'lod-1', shipmentId: 'shp-1',
      aljexId: '14556', tmsId: '212666394', pickupNumber: '1749123',
      miles: 412, weight: 41000, pieces: 22, piecesUnit: 'pallets', hot: true,
      readyToInvoice: true, rateConfirmKey: 'rate-confirms/lod-1/rc.pdf', divisionKey: 'BROKERAGE',
      cargoValueCents: 100_000_00, notes: 'Call ahead', podNotes: 'One page',
      nextCheckCallAt: '2026-03-04T00:00:00.000Z', nextCheckCallNote: 'Ask about I-40',
      lastCheckCallAt: '2026-03-02T00:00:00.000Z', lastCheckCallType: 'DEPARTED',
      lastKnownAt: '2026-03-02T01:00:00.000Z', lastKnownCity: 'Joliet', lastKnownState: 'IL', lastKnownSource: 'LINK',
      deliveredAt: '2026-03-03T00:00:00.000Z',
    } as LoadBoardSummary]
    data.loadCarriers = [{
      id: 'lc-1', loadId: 'lod-1', shipmentId: 'shp-1', kind: 'CARRIER', status: 'ACTIVE',
      carrierId: 'car-1', carrierName: 'Bay Logistics', carrierMc: 'MC-55',
      dispatcherName: 'Sam', dispatcherPhone: '555-1', dispatcherEmail: 'sam@bay.example',
      driverName: 'Pavel K', driverPhone: '555-2', driver2Name: 'Ivan', driver2Phone: '555-3',
      truckNumber: '88', trailerNumber: 'TRL-9', plates: 'P-1', vin: 'VIN-1', sealNumber: 'SEAL-1', tripNumber: 'T-7',
      rateConStatus: 'SIGNED', rateConSentAt: '2026-03-01T00:00:00.000Z', rateConSignedAt: '2026-03-01T01:00:00.000Z',
      carrierRateCents: 200_000, costCents: 210_000, apBalanceCents: 210_000,
      quickPay: true, quickPayDays: 2, quickPayFeeBps: 150, paymentTermsDays: 21,
      bookedAt: '2026-02-28T00:00:00.000Z', dispatchedAt: '2026-03-01T02:00:00.000Z',
      podRequestedAt: '2026-03-03T01:00:00.000Z', docsMissing: [], ratingStars: 4,
      createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    } as LoadCarrierRecord]
    data.carriers = [{
      id: 'car-1', name: 'Bay Logistics', type: 'TL', status: 'ACTIVE',
      mcNumber: 'MC-55', dotNumber: 'DOT-9', scac: 'BAYL',
      authorityStatus: 'ACTIVE', safetyRating: 'SATISFACTORY',
      insurancePolicies: [
        { id: 'p1', type: 'CARGO', expiresAt: '2027-01-01T00:00:00.000Z' },
        { id: 'p2', type: 'AUTO_LIABILITY', expiresAt: '2026-12-01T00:00:00.000Z' },
      ],
      highwayStatus: 'PASS', rmisStatus: 'INCOMPLETE', mcpStatus: 'REGISTERED',
      quickPayEligible: true, teamKey: 'TEAM-C', loadCount: 17, lastLoadAt: '2026-02-20T00:00:00.000Z',
      createdBy: 'a@b.c', updatedBy: 'a@b.c', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    }] as CarrierRecord[]

    const [row] = await rowsFor()
    expect(row.loadAljexId).toBe('14556')
    expect(row.loadTmsId).toBe('212666394')
    expect(row.pickupNumber).toBe('1749123')
    expect(row.miles).toBe(412)
    expect(row.weightLbs).toBe(41000)
    expect(row.pieces).toBe(22)
    expect(row.hot).toBe(true)
    expect(row.readyToInvoice).toBe(true)
    expect(row.rateConOnFile).toBe(true)
    expect(row.cargoValueCents).toBe(10_000_000)
    expect(row.loadNotes).toBe('Call ahead')
    expect(row.podNotes).toBe('One page')
    expect(row.nextCheckCallNote).toBe('Ask about I-40')
    expect(row.lastCheckCallType).toBe('DEPARTED')
    expect(row.lastKnownSource).toBe('LINK')
    expect(row.loadDeliveredAt).toBe('2026-03-03T00:00:00.000Z')
    // The ACTIVE LoadCarrier.
    expect(row.carrierMc).toBe('MC-55')
    expect(row.carrierDispatcherName).toBe('Sam')
    expect(row.driver2Name).toBe('Ivan')
    expect(row.trailerNumber).toBe('TRL-9')
    expect(row.rateConStatus).toBe('SIGNED')
    expect(row.carrierRateCents).toBe(200_000)
    expect(row.legCostCents).toBe(210_000)
    expect(row.apBalanceCents).toBe(210_000)
    expect(row.quickPayDays).toBe(2)
    expect(row.quickPayFeeBps).toBe(150)
    expect(row.bookedAt).toBe('2026-02-28T00:00:00.000Z')
    expect(row.legDocsMissing).toEqual([])
    expect(row.ratingStars).toBe(4)
    // The carrier directory.
    expect(row.carrierScac).toBe('BAYL')
    expect(row.authorityStatus).toBe('ACTIVE')
    expect(row.cargoInsuranceExpiresAt).toBe('2027-01-01T00:00:00.000Z')
    expect(row.liabilityInsuranceExpiresAt).toBe('2026-12-01T00:00:00.000Z')
    expect(row.highwayStatus).toBe('PASS')
    expect(row.carrierLoadCount).toBe(17)
  })

  it('leaves the catalog null when the shipment has no order, load or assignment', async () => {
    data.shipments = [shipment('shp-1')]

    const [row] = await rowsFor()
    expect(row.refPo).toBeNull()
    expect(row.billToName).toBeNull()
    expect(row.loadAljexId).toBeNull()
    expect(row.miles).toBeNull()
    expect(row.hot).toBeNull()
    expect(row.readyToInvoice).toBeNull()
    expect(row.carrierMc).toBeNull()
    expect(row.quickPay).toBeNull()
    expect(row.customerFactored).toBeNull()
    expect(row.cargoInsuranceExpiresAt).toBeNull()
  })

  it('leaves R2 facets null and still returns rows when financials and profiles are unavailable', async () => {
    data.shipments = [shipment('shp-1', { salesRepId: 'rep@bcat.io', loadIds: ['lod-1'] })]
    data.orders = []
    data.loads = [{ id: 'lod-1', shipmentId: 'shp-1', equipmentType: 'VAN', commodity: 'widgets' } as LoadBoardSummary]
    data.loadFinancials = []
    data.userProfiles = []

    const [row] = await rowsFor()
    expect(row.revenueCents).toBeNull()
    expect(row.costCents).toBeNull()
    expect(row.profitCents).toBeNull()
    expect(row.marginBps).toBeNull()
    expect(row.officeTeamKeys).toBeNull()
    expect(row.equipmentType).toBe('VAN')
    expect(row.id).toBe('shp-1')
  })
})
