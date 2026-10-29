// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SEED_DIVISIONS } from '@/lib/ownership'
import type { DashboardData, DashboardFilters } from './types'
import { buildBusinessStrips } from './businessStrips'

const MONTH = '2026-10'
const DAY = `${MONTH}-02`
const PICKUP = `${DAY}T12:00:00.000Z`

function data(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    shipments: [],
    orders: [],
    loads: [],
    loadCarriers: [],
    samples: [],
    openInvoices: [],
    openBills: [],
    quotes: [],
    profiles: [],
    divisions: SEED_DIVISIONS as DashboardData['divisions'],
    now: PICKUP,
    ...overrides,
  }
}

const filters: DashboardFilters = {
  divisions: [],
  subdivisions: [],
  from: `${MONTH}-01`,
  to: `${MONTH}-31`,
  mode: null,
  status: null,
  customerId: null,
  carrierId: null,
  repId: null,
}

describe('buildBusinessStrips', () => {
  it('returns one strip per active top-level division, in sort order', () => {
    const strips = buildBusinessStrips(data(), filters, SEED_DIVISIONS)
    expect(strips.map((s) => s.code)).toEqual(['BROKERAGE', 'ASSETS', 'CAR_SHIPPING', 'COMPANY'])
    expect(strips[0]).toMatchObject({ code: 'BROKERAGE', name: 'BCAT Logistics', brand: 'BCAT Logistics' })
    expect(strips[1]).toMatchObject({ code: 'ASSETS', name: 'Ivan Cartage', brand: 'Ivan Cartage' })
  })

  it('puts an ASSETS/BOX_TRUCK shipment in the Assets strip and the Box Trucks sub-row', () => {
    const shipment = {
      id: 's1',
      number: 'P1001',
      status: 'IN_TRANSIT',
      customerId: 'c1',
      mode: 'TRUCKLOAD',
      source: 'MANUAL',
      pickupAppt: PICKUP,
      revDivision: 'ASSETS',
      revSubdivision: 'BOX_TRUCK',
      createdBy: 't',
      updatedBy: 't',
      createdAt: PICKUP,
      updatedAt: PICKUP,
    } as DashboardData['shipments'][number]

    const strips = buildBusinessStrips(data({ shipments: [shipment] }), filters, SEED_DIVISIONS)
    const assets = strips.find((s) => s.code === 'ASSETS')!
    const boxTrucks = assets.subdivisions.find((sub) => sub.code === 'BOX_TRUCK')!

    expect(assets.shipmentsByStatus).toEqual({ IN_TRANSIT: 1 })
    expect(boxTrucks.shipmentsByStatus).toEqual({ IN_TRANSIT: 1 })
  })

  it('renders empty figures, not zeros, for divisions with no data', () => {
    const shipment = {
      id: 's1',
      number: 'P1001',
      status: 'DELIVERED',
      customerId: 'c1',
      mode: 'TRUCKLOAD',
      source: 'MANUAL',
      pickupAppt: PICKUP,
      revDivision: 'BROKERAGE',
      createdBy: 't',
      updatedBy: 't',
      createdAt: PICKUP,
      updatedAt: PICKUP,
    } as DashboardData['shipments'][number]

    const strips = buildBusinessStrips(data({ shipments: [shipment] }), filters, SEED_DIVISIONS)
    const carShipping = strips.find((s) => s.code === 'CAR_SHIPPING')!

    expect(carShipping.shipmentsByStatus).toEqual({})
    expect(carShipping.revenueCents).toBeNull()
    expect(carShipping.profitCents).toBeNull()
    expect(carShipping.marginBps).toBeNull()
    expect(carShipping.arOpenCents).toBeNull()
    expect(carShipping.apOpenCents).toBeNull()
    expect(carShipping.trackedCount).toBeNull()
    expect(carShipping.podNeededCount).toBeNull()
  })

  it('sums revenue, profit and margin from priced samples', () => {
    const samples = [
      {
        id: 'lrs-1',
        laneKey: 'A>B',
        date: DAY,
        loadId: 'load-1',
        shipmentId: 's1',
        revDivision: 'BROKERAGE',
        revenueCents: 200_000,
        costCents: 150_000,
        profitCents: 50_000,
        source: 'LOAD',
        sampledAt: PICKUP,
        version: 1,
      },
      {
        id: 'lrs-2',
        laneKey: 'B>C',
        date: DAY,
        loadId: 'load-2',
        shipmentId: 's2',
        revDivision: 'BROKERAGE',
        revenueCents: 100_000,
        costCents: 120_000,
        profitCents: -20_000,
        source: 'LOAD',
        sampledAt: PICKUP,
        version: 1,
      },
    ] as DashboardData['samples']

    const strips = buildBusinessStrips(data({ samples }), filters, SEED_DIVISIONS)
    const brokerage = strips.find((s) => s.code === 'BROKERAGE')!

    expect(brokerage.revenueCents).toBe(300_000)
    expect(brokerage.profitCents).toBe(30_000)
    expect(brokerage.marginBps).toBe(1000)
  })

  it('leaves revenue/margin null when there are no priced samples', () => {
    const shipment = {
      id: 's1',
      number: 'P1001',
      status: 'OPEN',
      customerId: 'c1',
      mode: 'TRUCKLOAD',
      source: 'MANUAL',
      pickupAppt: PICKUP,
      revDivision: 'BROKERAGE',
      createdBy: 't',
      updatedBy: 't',
      createdAt: PICKUP,
      updatedAt: PICKUP,
    } as DashboardData['shipments'][number]

    const strips = buildBusinessStrips(data({ shipments: [shipment] }), filters, SEED_DIVISIONS)
    const brokerage = strips.find((s) => s.code === 'BROKERAGE')!

    expect(brokerage.shipmentsByStatus).toEqual({ OPEN: 1 })
    expect(brokerage.revenueCents).toBeNull()
    expect(brokerage.profitCents).toBeNull()
    expect(brokerage.marginBps).toBeNull()
  })

  it('narrows all strips when the division filter is set', () => {
    const samples = [
      {
        id: 'lrs-1',
        laneKey: 'A>B',
        date: DAY,
        loadId: 'load-1',
        shipmentId: 's1',
        revDivision: 'BROKERAGE',
        revenueCents: 100_000,
        costCents: 80_000,
        profitCents: 20_000,
        source: 'LOAD',
        sampledAt: PICKUP,
        version: 1,
      },
      {
        id: 'lrs-2',
        laneKey: 'B>C',
        date: DAY,
        loadId: 'load-2',
        shipmentId: 's2',
        revDivision: 'ASSETS',
        revenueCents: 50_000,
        costCents: 40_000,
        profitCents: 10_000,
        source: 'LOAD',
        sampledAt: PICKUP,
        version: 1,
      },
    ] as DashboardData['samples']

    const narrowed = buildBusinessStrips(data({ samples }), { ...filters, divisions: ['BROKERAGE'] }, SEED_DIVISIONS)
    const brokerage = narrowed.find((s) => s.code === 'BROKERAGE')!
    const assets = narrowed.find((s) => s.code === 'ASSETS')!

    expect(brokerage.revenueCents).toBe(100_000)
    expect(assets.revenueCents).toBeNull()
  })

  it('maps a shipment tagged directly with a child division into that sub-row', () => {
    // No revSubdivision: the shipment is tagged revDivision='BOX_TRUCK'. topLevelOf still
    // walks it up to ASSETS, and the child-code fallback puts it in the Box Trucks row.
    const shipment = {
      id: 's1',
      number: 'P1001',
      status: 'PICKED_UP',
      customerId: 'c1',
      mode: 'TRUCKLOAD',
      source: 'MANUAL',
      pickupAppt: PICKUP,
      revDivision: 'BOX_TRUCK',
      createdBy: 't',
      updatedBy: 't',
      createdAt: PICKUP,
      updatedAt: PICKUP,
    } as DashboardData['shipments'][number]

    const strips = buildBusinessStrips(data({ shipments: [shipment] }), filters, SEED_DIVISIONS)
    const assets = strips.find((s) => s.code === 'ASSETS')!
    const boxTrucks = assets.subdivisions.find((sub) => sub.code === 'BOX_TRUCK')!

    expect(assets.shipmentsByStatus).toEqual({ PICKED_UP: 1 })
    expect(boxTrucks.shipmentsByStatus).toEqual({ PICKED_UP: 1 })
  })
})
