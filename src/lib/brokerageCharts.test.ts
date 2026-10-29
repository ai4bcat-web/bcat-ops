import { describe, expect, it } from 'vitest'

import type {
  DashboardData,
  DashboardFilters,
  LoadSummaryRecord,
} from '@/features/tms/dashboard/types'
import {
  apByRep,
  arByRep,
  DAT_EMPTY_NOTE,
  datPosted,
  percentile,
  POD_NEEDED_CLEAR_NOTE,
  podNeeded,
  podTiming,
  repLeaderboard,
  statusCounts,
  TRACKING_HISTORY_EMPTY_NOTE,
  trackingHistory,
  trackingLive,
} from '@/lib/brokerageCharts'
import type {
  CarrierBillRecord,
  InvoiceRecord,
  LaneRateSampleRecord,
  LoadCarrierRecord,
  OrderRecord,
  OwnershipDivisionRecord,
  ShipmentMode,
  ShipmentRecord,
  ShipmentStatus,
  UserProfileRecord,
} from '@/types/tms'

// ── The fixture ──────────────────────────────────────────────────────────────
//
// One October window: 15 shipments over three divisions and six statuses, 10 priced
// lane samples carrying the Step R tracking / POD facts, six board loads, four open
// invoices, three open carrier bills, three user profiles. Every expectation below is
// an exact number counted off this table.

const NOW = '2026-10-28T12:00:00.000Z'

const OCTOBER: DashboardFilters = {
  divisions: [],
  subdivisions: [],
  from: '2026-10-01',
  to: '2026-10-31',
  mode: null,
  status: null,
  customerId: null,
  carrierId: null,
  repId: null,
}

const BROKERAGE_ONLY: DashboardFilters = { ...OCTOBER, divisions: ['BROKERAGE'] }

function division(code: string, name: string, parentId: string | null = null): OwnershipDivisionRecord {
  return {
    id: code,
    code,
    name,
    brand: null,
    parentId,
    color: null,
    sortOrder: 0,
    active: true,
    owners: null,
    flows: null,
    createdBy: 'seed',
    updatedBy: 'seed',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function profile(id: string, email: string, name: string): UserProfileRecord {
  return { id, email, name, createdBy: 'seed', updatedBy: 'seed', version: 1 }
}

interface ShipmentSeed {
  id: string
  number: string
  status: ShipmentStatus
  division: string | null
  subdivision?: string | null
  rep: string | null
  pickup: string
  customerId: string
  customerName: string
  datPostedAt?: string | null
  deliveredAt?: string | null
  voidedAt?: string | null
}

function shipmentOf(seed: ShipmentSeed): ShipmentRecord {
  return {
    id: seed.id,
    number: seed.number,
    status: seed.status,
    customerId: seed.customerId,
    customerName: seed.customerName,
    mode: 'FTL' as ShipmentMode,
    source: 'MANUAL',
    pickupAppt: seed.pickup,
    deliveredAt: seed.deliveredAt ?? null,
    revDivision: seed.division,
    revSubdivision: seed.subdivision ?? null,
    revTagSource: 'RULE',
    salesRepId: seed.rep,
    datPostedAt: seed.datPostedAt ?? null,
    voidedAt: seed.voidedAt ?? null,
    createdBy: 'seed',
    updatedBy: 'seed',
    createdAt: seed.pickup,
    updatedAt: seed.pickup,
  }
}

const SHIPMENT_SEEDS: ShipmentSeed[] = [
  { id: 's01', number: 'S1001', status: 'DELIVERED', division: 'BROKERAGE', rep: 'rep-amy', pickup: '2026-10-02T08:00:00.000Z', customerId: 'c-acme', customerName: 'Acme Foods' },
  { id: 's02', number: 'S1002', status: 'DELIVERED', division: 'BROKERAGE', rep: 'rep-amy', pickup: '2026-10-03T08:00:00.000Z', customerId: 'c-acme', customerName: 'Acme Foods' },
  { id: 's03', number: 'S1003', status: 'DELIVERED', division: 'BROKERAGE', rep: 'rep-ben', pickup: '2026-10-04T08:00:00.000Z', customerId: 'c-acme', customerName: 'Acme Foods', deliveredAt: '2026-10-06T08:00:00.000Z' },
  { id: 's04', number: 'S1004', status: 'IN_TRANSIT', division: 'BROKERAGE', rep: 'rep-ben', pickup: '2026-10-20T08:00:00.000Z', customerId: 'c-nord', customerName: 'Nord Steel', datPostedAt: '2026-10-19T10:00:00.000Z' },
  { id: 's05', number: 'S1005', status: 'IN_TRANSIT', division: 'BROKERAGE', rep: 'rep-amy', pickup: '2026-10-21T08:00:00.000Z', customerId: 'c-nord', customerName: 'Nord Steel' },
  { id: 's06', number: 'S1006', status: 'DISPATCHED', division: 'BROKERAGE', rep: 'rep-cia', pickup: '2026-10-22T08:00:00.000Z', customerId: 'c-nord', customerName: 'Nord Steel' },
  { id: 's07', number: 'S1007', status: 'OPEN', division: 'BROKERAGE', rep: 'rep-cia', pickup: '2026-10-23T08:00:00.000Z', customerId: 'c-acme', customerName: 'Acme Foods' },
  { id: 's08', number: 'S1008', status: 'DELIVERED', division: 'BROKERAGE', rep: 'rep-cia', pickup: '2026-10-10T08:00:00.000Z', customerId: 'c-acme', customerName: 'Acme Foods' },
  { id: 's09', number: 'S1009', status: 'DELIVERED', division: 'ASSETS', subdivision: 'BOX_TRUCK', rep: 'rep-ben', pickup: '2026-10-05T08:00:00.000Z', customerId: 'c-nord', customerName: 'Nord Steel' },
  { id: 's10', number: 'S1010', status: 'DELIVERED', division: 'ASSETS', subdivision: 'BOX_TRUCK', rep: 'rep-ben', pickup: '2026-10-06T08:00:00.000Z', customerId: 'c-nord', customerName: 'Nord Steel' },
  { id: 's11', number: 'S1011', status: 'UNLOADING', division: 'ASSETS', subdivision: 'LOCAL', rep: 'rep-amy', pickup: '2026-10-25T08:00:00.000Z', customerId: 'c-nord', customerName: 'Nord Steel', datPostedAt: '2026-10-24T10:00:00.000Z' },
  { id: 's12', number: 'S1012', status: 'DELIVERED', division: 'CAR_SHIPPING', rep: 'rep-cia', pickup: '2026-10-07T08:00:00.000Z', customerId: 'c-vega', customerName: 'Vega Motors' },
  { id: 's13', number: 'S1013', status: 'DELIVERED', division: 'CAR_SHIPPING', rep: 'rep-cia', pickup: '2026-10-11T08:00:00.000Z', customerId: 'c-vega', customerName: 'Vega Motors' },
  { id: 's14', number: 'S1014', status: 'DELIVERED', division: 'BROKERAGE', rep: 'old@bcatcorp.com', pickup: '2026-10-09T08:00:00.000Z', customerId: 'c-acme', customerName: 'Acme Foods', datPostedAt: '2026-10-09T09:00:00.000Z' },
  // Voided: keeps its PRO and its DAT stamp, counts nowhere.
  { id: 's15', number: 'S1015', status: 'OPEN', division: 'BROKERAGE', rep: 'rep-amy', pickup: '2026-10-26T08:00:00.000Z', customerId: 'c-acme', customerName: 'Acme Foods', datPostedAt: '2026-10-26T09:00:00.000Z', voidedAt: '2026-10-27T09:00:00.000Z' },
]

interface SampleSeed {
  id: string
  shipmentId: string
  division: string
  subdivision?: string | null
  rep: string
  carrierId: string
  carrierName: string
  date: string
  deliveredAt: string
  podReceivedAt: string | null
  revenue: number
  cost: number
  provider: string | null
  firstPingAt: string | null
  due: number | null
  met: number | null
}

const SAMPLE_SEEDS: SampleSeed[] = [
  { id: 'm01', shipmentId: 's01', division: 'BROKERAGE', rep: 'rep-amy', carrierId: 'car-a', carrierName: 'Alpha Freight', date: '2026-10-04', deliveredAt: '2026-10-04T08:00:00.000Z', podReceivedAt: '2026-10-05T08:00:00.000Z', revenue: 200_000, cost: 150_000, provider: 'LINK', firstPingAt: '2026-10-02T14:00:00.000Z', due: 4, met: 4 },
  { id: 'm02', shipmentId: 's02', division: 'BROKERAGE', rep: 'rep-amy', carrierId: 'car-b', carrierName: 'Beta Lines', date: '2026-10-05', deliveredAt: '2026-10-05T08:00:00.000Z', podReceivedAt: null, revenue: 100_000, cost: 80_000, provider: 'MANUAL', firstPingAt: null, due: 2, met: 1 },
  { id: 'm03', shipmentId: 's09', division: 'ASSETS', subdivision: 'BOX_TRUCK', rep: 'rep-ben', carrierId: 'car-i', carrierName: 'Ivan Cartage', date: '2026-10-07', deliveredAt: '2026-10-07T08:00:00.000Z', podReceivedAt: '2026-10-07T12:00:00.000Z', revenue: 300_000, cost: 200_000, provider: 'DRIVER_APP', firstPingAt: '2026-10-05T10:00:00.000Z', due: 3, met: 3 },
  { id: 'm04', shipmentId: 's10', division: 'ASSETS', subdivision: 'BOX_TRUCK', rep: 'rep-ben', carrierId: 'car-i', carrierName: 'Ivan Cartage', date: '2026-10-08', deliveredAt: '2026-10-08T08:00:00.000Z', podReceivedAt: null, revenue: 120_000, cost: 90_000, provider: 'NONE', firstPingAt: null, due: 2, met: 0 },
  { id: 'm05', shipmentId: 's12', division: 'CAR_SHIPPING', rep: 'rep-cia', carrierId: 'car-a', carrierName: 'Alpha Freight', date: '2026-10-09', deliveredAt: '2026-10-09T08:00:00.000Z', podReceivedAt: '2026-10-11T08:00:00.000Z', revenue: 90_000, cost: 60_000, provider: 'MOTIVE', firstPingAt: '2026-10-07T20:00:00.000Z', due: 1, met: 1 },
  { id: 'm06', shipmentId: 's14', division: 'BROKERAGE', rep: 'old@bcatcorp.com', carrierId: 'car-a', carrierName: 'Alpha Freight', date: '2026-10-10', deliveredAt: '2026-10-10T08:00:00.000Z', podReceivedAt: '2026-10-10T20:00:00.000Z', revenue: 50_000, cost: 40_000, provider: 'LINK', firstPingAt: '2026-10-09T12:00:00.000Z', due: 2, met: 2 },
  { id: 'm07', shipmentId: 's08', division: 'BROKERAGE', rep: 'rep-cia', carrierId: 'car-b', carrierName: 'Beta Lines', date: '2026-10-12', deliveredAt: '2026-10-12T08:00:00.000Z', podReceivedAt: '2026-10-13T14:00:00.000Z', revenue: 150_000, cost: 100_000, provider: 'LINK', firstPingAt: '2026-10-10T16:00:00.000Z', due: 3, met: 2 },
  { id: 'm08', shipmentId: 's13', division: 'CAR_SHIPPING', rep: 'rep-cia', carrierId: 'car-b', carrierName: 'Beta Lines', date: '2026-10-13', deliveredAt: '2026-10-13T08:00:00.000Z', podReceivedAt: '2026-10-14T08:00:00.000Z', revenue: 80_000, cost: 70_000, provider: 'NONE', firstPingAt: null, due: null, met: null },
  // Delivered in the window off a September pickup: the shipment read does not carry it,
  // so the sample's own tag is what the card groups on.
  { id: 'm09', shipmentId: 's90', division: 'BROKERAGE', rep: 'rep-amy', carrierId: 'car-a', carrierName: 'Alpha Freight', date: '2026-10-15', deliveredAt: '2026-10-15T08:00:00.000Z', podReceivedAt: '2026-10-15T14:00:00.000Z', revenue: 60_000, cost: 45_000, provider: 'LINK', firstPingAt: null, due: null, met: null },
  { id: 'm10', shipmentId: 's91', division: 'BROKERAGE', rep: 'rep-ben', carrierId: 'car-g', carrierName: 'Gamma Transit', date: '2026-10-16', deliveredAt: '2026-10-16T08:00:00.000Z', podReceivedAt: '2026-10-19T08:00:00.000Z', revenue: 70_000, cost: 50_000, provider: 'MOTIVE', firstPingAt: null, due: 4, met: 2 },
]

function sampleOf(seed: SampleSeed): LaneRateSampleRecord {
  return {
    id: seed.id,
    laneKey: 'CHICAGO|IL>DANVILLE|IL',
    date: seed.date,
    loadId: `l-${seed.id}`,
    shipmentId: seed.shipmentId,
    customerId: 'c-acme',
    carrierId: seed.carrierId,
    carrierName: seed.carrierName,
    revenueCents: seed.revenue,
    costCents: seed.cost,
    profitCents: seed.revenue - seed.cost,
    marginBps: Math.round(((seed.revenue - seed.cost) / seed.revenue) * 10_000),
    source: 'LOAD',
    sampledAt: seed.deliveredAt,
    version: 1,
    revDivision: seed.division,
    revSubdivision: seed.subdivision ?? null,
    salesRepId: seed.rep,
    deliveredAt: seed.deliveredAt,
    podReceivedAt: seed.podReceivedAt,
    trackingProvider: seed.provider,
    firstPingAt: seed.firstPingAt,
    checkCallsDue: seed.due,
    checkCallsMet: seed.met,
  }
}

interface LoadSeed {
  id: string
  shipmentId: string
  status: LoadSummaryRecord['status']
  division: string
  subdivision?: string | null
  rep: string
  pickup: string
  carrierName: string | null
  provider?: string | null
  lastKnownAt?: string | null
  nextCheckCallAt?: string | null
}

const LOAD_SEEDS: LoadSeed[] = [
  { id: 'l02', shipmentId: 's02', status: 'DELIVERED', division: 'BROKERAGE', rep: 'rep-amy', pickup: '2026-10-03T08:00:00.000Z', carrierName: 'Beta Lines' },
  { id: 'l03', shipmentId: 's03', status: 'DELIVERED', division: 'BROKERAGE', rep: 'rep-ben', pickup: '2026-10-04T08:00:00.000Z', carrierName: 'Gamma Transit' },
  { id: 'l04', shipmentId: 's04', status: 'IN_TRANSIT', division: 'BROKERAGE', rep: 'rep-ben', pickup: '2026-10-20T08:00:00.000Z', carrierName: 'Alpha Freight', provider: 'LINK', lastKnownAt: '2026-10-28T06:00:00.000Z', nextCheckCallAt: '2026-10-28T18:00:00.000Z' },
  { id: 'l05', shipmentId: 's05', status: 'IN_TRANSIT', division: 'BROKERAGE', rep: 'rep-amy', pickup: '2026-10-21T08:00:00.000Z', carrierName: 'Beta Lines', provider: 'MANUAL', lastKnownAt: '2026-10-28T09:00:00.000Z', nextCheckCallAt: '2026-10-28T06:00:00.000Z' },
  { id: 'l06', shipmentId: 's06', status: 'DISPATCHED', division: 'BROKERAGE', rep: 'rep-cia', pickup: '2026-10-22T08:00:00.000Z', carrierName: 'Alpha Freight', provider: 'MOTIVE', lastKnownAt: '2026-10-25T06:00:00.000Z', nextCheckCallAt: '2026-10-27T00:00:00.000Z' },
  { id: 'l07', shipmentId: 's07', status: 'SOURCING', division: 'BROKERAGE', rep: 'rep-cia', pickup: '2026-10-23T08:00:00.000Z', carrierName: null },
  { id: 'l10', shipmentId: 's10', status: 'DELIVERED', division: 'ASSETS', subdivision: 'BOX_TRUCK', rep: 'rep-ben', pickup: '2026-10-06T08:00:00.000Z', carrierName: 'Ivan Cartage' },
  { id: 'l11', shipmentId: 's11', status: 'UNLOADING', division: 'ASSETS', subdivision: 'LOCAL', rep: 'rep-amy', pickup: '2026-10-25T08:00:00.000Z', carrierName: 'Ivan Cartage', provider: 'DRIVER_APP', lastKnownAt: '2026-10-28T11:00:00.000Z' },
  // Voided shipment's load: tracked and fresh, and still counted nowhere.
  { id: 'l15', shipmentId: 's15', status: 'IN_TRANSIT', division: 'BROKERAGE', rep: 'rep-amy', pickup: '2026-10-26T08:00:00.000Z', carrierName: 'Alpha Freight', provider: 'LINK', lastKnownAt: '2026-10-28T10:00:00.000Z' },
]

function loadOf(seed: LoadSeed, shipments: ShipmentRecord[]): LoadSummaryRecord {
  const shipment = shipments.find((s) => s.id === seed.shipmentId)
  return {
    id: seed.id,
    shipmentId: seed.shipmentId,
    status: seed.status,
    revDivision: seed.division,
    revSubdivision: seed.subdivision ?? null,
    salesRepId: seed.rep,
    pickupAppt: seed.pickup,
    carrierName: seed.carrierName,
    trackingProvider: seed.provider ?? null,
    lastKnownAt: seed.lastKnownAt ?? null,
    nextCheckCallAt: seed.nextCheckCallAt ?? null,
    customerId: shipment?.customerId ?? null,
    customerName: shipment?.customerName ?? null,
    shipmentStatus: shipment?.status ?? null,
    voidedAt: shipment?.voidedAt ?? null,
  }
}

function orderOf(shipment: ShipmentRecord, docsMissing: string[] | null = null): OrderRecord {
  return {
    id: `o-${shipment.id}`,
    shipmentId: shipment.id,
    customerId: shipment.customerId,
    customerName: shipment.customerName,
    customerRepId: shipment.salesRepId ?? null,
    mode: shipment.mode,
    docsMissing,
    createdBy: 'seed',
    updatedBy: 'seed',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function invoiceOf(id: string, shipmentId: string, customerId: string, balanceCents: number): InvoiceRecord {
  return {
    id,
    number: `INV-${id}`,
    orderId: `o-${shipmentId}`,
    shipmentId,
    customerId,
    status: 'ISSUED',
    invoiceDate: '2026-10-20',
    issuedAt: '2026-10-20T12:00:00.000Z',
    issuedBy: 'seed',
    dueAt: '2026-11-19',
    termsDays: 30,
    invoiceMonth: '2026-10',
    subtotalCents: balanceCents,
    totalCents: balanceCents,
    paidCents: 0,
    writtenOffCents: 0,
    balanceCents,
    arOpen: 'OPEN',
    createdBy: 'seed',
    updatedBy: 'seed',
    version: 1,
  }
}

function billOf(id: string, loadCarrierId: string, loadId: string, shipmentId: string, carrierId: string, balanceCents: number): CarrierBillRecord {
  return {
    id,
    loadCarrierId,
    loadId,
    shipmentId,
    carrierId,
    payeeKind: 'CARRIER',
    status: 'TO_BE_PAID',
    billDate: '2026-10-20',
    billMonth: '2026-10',
    recordedAt: '2026-10-20T12:00:00.000Z',
    recordedBy: 'seed',
    dueAt: '2026-11-19',
    termsDays: 30,
    grossCents: balanceCents,
    quickPayFeeCents: 0,
    netCents: balanceCents,
    billedCents: balanceCents,
    varianceCents: 0,
    paidCents: 0,
    creditedCents: 0,
    balanceCents,
    apOpen: 'OPEN',
    createdBy: 'seed',
    updatedBy: 'seed',
    version: 1,
  }
}

function legOf(id: string, loadId: string, shipmentId: string, carrierId: string, carrierName: string, carrierRepId: string | null): LoadCarrierRecord {
  return { id, loadId, shipmentId, kind: 'CARRIER', status: 'ACTIVE', carrierId, carrierName, carrierRepId }
}

function fixture(): DashboardData {
  const shipments = SHIPMENT_SEEDS.map(shipmentOf)
  const orders = shipments.map((s) => orderOf(s, s.id === 's03' ? ['POD'] : []))
  return {
    shipments,
    orders,
    loads: LOAD_SEEDS.map((seed) => loadOf(seed, shipments)),
    loadCarriers: [
      legOf('lc02', 'l02', 's02', 'car-b', 'Beta Lines', null),
      legOf('lc03', 'l03', 's03', 'car-g', 'Gamma Transit', null),
      legOf('lc04', 'l04', 's04', 'car-a', 'Alpha Freight', 'rep-cia'),
      legOf('lc10', 'l10', 's10', 'car-i', 'Ivan Cartage', 'rep-ben'),
    ],
    samples: SAMPLE_SEEDS.map(sampleOf),
    openInvoices: [
      invoiceOf('i1', 's01', 'c-acme', 250_000),
      invoiceOf('i2', 's02', 'c-acme', 100_000),
      invoiceOf('i3', 's09', 'c-nord', 300_000),
      invoiceOf('i4', 's14', 'c-acme', 75_000),
    ],
    openBills: [
      billOf('b1', 'lc04', 'l04', 's04', 'car-a', 120_000),
      billOf('b2', 'lc02', 'l02', 's02', 'car-b', 80_000),
      billOf('b3', 'lc10', 'l10', 's10', 'car-i', 60_000),
    ],
    quotes: [],
    profiles: [
      profile('rep-amy', 'amy@bcatcorp.com', 'Amy Diaz'),
      profile('rep-ben', 'ben@bcatcorp.com', 'Ben Cole'),
      profile('rep-cia', 'cia@bcatcorp.com', 'Cia Park'),
    ],
    divisions: [
      division('BROKERAGE', 'BCAT Logistics'),
      division('ASSETS', 'Ivan Cartage'),
      division('CAR_SHIPPING', 'Best Care Auto Transport'),
      division('BOX_TRUCK', 'Box Trucks', 'ASSETS'),
      division('LOCAL', 'Local Drivers', 'ASSETS'),
    ],
    now: NOW,
  }
}

function rowValue(series: { rows: Array<{ label: string; values: Record<string, number> }> }, label: string, group = 'total'): number {
  const row = series.rows.find((r) => r.label === label)
  if (!row) throw new Error(`no row ${label} in ${series.rows.map((r) => r.label).join(', ')}`)
  return row.values[group]
}

// ── percentile ───────────────────────────────────────────────────────────────

describe('percentile (nearest rank)', () => {
  it('takes an observed value, never an interpolation, on odd and even sizes', () => {
    expect(percentile([3, 1, 2], 50)).toBe(2)
    expect(percentile([4, 1, 2, 3], 50)).toBe(2)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9)
    expect(percentile([1, 2, 3, 4, 5], 90)).toBe(5)
  })

  it('answers 0 for no observations and the single value for one', () => {
    expect(percentile([], 50)).toBe(0)
    expect(percentile([7], 90)).toBe(7)
  })
})

// ── 1. status-counts ─────────────────────────────────────────────────────────

describe('statusCounts', () => {
  it('keeps a row for all 17 statuses and counts the 14 live shipments', () => {
    const series = statusCounts(fixture(), OCTOBER, null)
    expect(series.rows).toHaveLength(17)
    expect(rowValue(series, 'DEL')).toBe(9)
    expect(rowValue(series, 'INTRAN')).toBe(2)
    expect(rowValue(series, 'DISP')).toBe(1)
    expect(rowValue(series, 'UNL')).toBe(1)
    expect(rowValue(series, 'OPEN')).toBe(1)
    // The voided shipment was OPEN and is counted nowhere.
    expect(series.rows.reduce((sum, r) => sum + r.values.total, 0)).toBe(14)
    expect(rowValue(series, 'HOLD')).toBe(0)
  })

  it('splits every status by division and keeps the zero rows', () => {
    const series = statusCounts(fixture(), OCTOBER, 'DIVISION')
    expect(series.groups).toEqual(['BCAT Logistics', 'Ivan Cartage', 'Best Care Auto Transport'])
    expect(rowValue(series, 'DEL', 'BCAT Logistics')).toBe(5)
    expect(rowValue(series, 'DEL', 'Ivan Cartage')).toBe(2)
    expect(rowValue(series, 'DEL', 'Best Care Auto Transport')).toBe(2)
    expect(rowValue(series, 'UNL', 'BCAT Logistics')).toBe(0)
    expect(rowValue(series, 'UNL', 'Ivan Cartage')).toBe(1)
  })

  it('drops the other two businesses under a Brokerage filter', () => {
    const series = statusCounts(fixture(), BROKERAGE_ONLY, null)
    expect(series.rows.reduce((sum, r) => sum + r.values.total, 0)).toBe(9)
    expect(rowValue(series, 'DEL')).toBe(5)
  })
})

// ── 2. dat-posted ────────────────────────────────────────────────────────────

describe('datPosted', () => {
  it('counts the three stamped shipments and never the voided one', () => {
    const series = datPosted(fixture(), OCTOBER, null)
    expect(series.rows).toEqual([{ label: 'Posted to DAT', values: { total: 3 } }])
    expect(series.note).toBeNull()
  })

  it('groups the stamps by division', () => {
    const series = datPosted(fixture(), OCTOBER, 'DIVISION')
    expect(series.rows).toEqual([
      { label: 'BCAT Logistics', values: { total: 2 } },
      { label: 'Ivan Cartage', values: { total: 1 } },
    ])
  })

  it('says why it is zero when no shipment in the window carries a stamp', () => {
    const series = datPosted(fixture(), { ...OCTOBER, from: '2026-11-01', to: '2026-11-30' }, null)
    expect(rowValue(series, 'Posted to DAT')).toBe(0)
    expect(series.note).toBe(DAT_EMPTY_NOTE)
  })
})

// ── 3/4. money by rep ────────────────────────────────────────────────────────

describe('arByRep', () => {
  it('sums the open balances against the shipment\u2019s sales rep, biggest first', () => {
    const series = arByRep(fixture(), OCTOBER, null)
    expect(series.valueFormat).toBe('cents')
    expect(series.rows).toEqual([
      { label: 'Amy Diaz', values: { total: 350_000 } },
      { label: 'Ben Cole', values: { total: 300_000 } },
      { label: 'old@bcatcorp.com', values: { total: 75_000 } },
    ])
  })

  it('stacks a rep\u2019s AR by division', () => {
    const series = arByRep(fixture(), OCTOBER, 'DIVISION')
    expect(series.groups).toEqual(['BCAT Logistics', 'Ivan Cartage'])
    expect(rowValue(series, 'Amy Diaz', 'BCAT Logistics')).toBe(350_000)
    expect(rowValue(series, 'Amy Diaz', 'Ivan Cartage')).toBe(0)
    expect(rowValue(series, 'Ben Cole', 'Ivan Cartage')).toBe(300_000)
  })

  it('leaves another business\u2019s money out under a Brokerage filter', () => {
    const series = arByRep(fixture(), BROKERAGE_ONLY, null)
    expect(series.rows.map((r) => r.label)).toEqual(['Amy Diaz', 'old@bcatcorp.com'])
    expect(rowValue(series, 'Amy Diaz')).toBe(350_000)
  })
})

describe('apByRep', () => {
  it('bills the leg\u2019s carrier rep, falling back to the shipment\u2019s sales rep', () => {
    const series = apByRep(fixture(), OCTOBER, null)
    expect(series.rows).toEqual([
      // lc04 names Cia; lc02 names nobody, so s02's Amy owns it; lc10 names Ben.
      { label: 'Cia Park', values: { total: 120_000 } },
      { label: 'Amy Diaz', values: { total: 80_000 } },
      { label: 'Ben Cole', values: { total: 60_000 } },
    ])
  })

  it('drops the Ivan Cartage bill under a Brokerage filter', () => {
    const series = apByRep(fixture(), BROKERAGE_ONLY, null)
    expect(series.rows.map((r) => r.label)).toEqual(['Cia Park', 'Amy Diaz'])
  })
})

// ── 5. rep-leaderboard ───────────────────────────────────────────────────────

describe('repLeaderboard', () => {
  it('ranks reps by profit with real margin bps and their open AR', () => {
    const series = repLeaderboard(fixture(), OCTOBER)
    expect(series.columns?.map((c) => c.key)).toEqual(['shipments', 'revenue', 'profit', 'marginBps', 'openAr'])
    expect(series.rows.map((r) => r.label)).toEqual(['Ben Cole', 'Cia Park', 'Amy Diaz', 'old@bcatcorp.com'])
    expect(series.rows[0].values).toEqual({
      shipments: 3,
      revenue: 490_000,
      profit: 150_000,
      marginBps: 3061,
      openAr: 300_000,
    })
    expect(series.rows[2].values).toEqual({
      shipments: 3,
      revenue: 360_000,
      profit: 85_000,
      marginBps: 2361,
      openAr: 350_000,
    })
    // The legacy e-mail rep id has no profile, so it prints as the e-mail.
    expect(series.rows[3].values.openAr).toBe(75_000)
  })

  it('never counts a canceled or TONU\u2019d sample', () => {
    const data = fixture()
    data.samples = data.samples.map((s) => (s.id === 'm03' ? { ...s, excluded: true } : s))
    const series = repLeaderboard(data, OCTOBER)
    const ben = series.rows.find((r) => r.label === 'Ben Cole')
    expect(ben?.values).toMatchObject({ shipments: 2, revenue: 190_000, profit: 50_000 })
  })
})

// ── 6. tracking-live ─────────────────────────────────────────────────────────

describe('trackingLive', () => {
  it('counts a load as tracked only on an automatic ping inside 24 hours', () => {
    const series = trackingLive(fixture(), OCTOBER, null)
    expect(series.kpis).toEqual([
      // l04 LINK 6h ago and l11 DRIVER_APP 1h ago are live; l05 is MANUAL and
      // l06's MOTIVE position is three days old.
      { label: 'Tracked now', value: '2', sub: 'of 4 moving' },
      { label: 'In transit untracked', value: '2', sub: 'no automatic position in 24h' },
      { label: 'Overdue check calls', value: '2', sub: 'next check call is past due' },
    ])
    expect(series.rows).toEqual([{ label: 'Tracked now', values: { total: 2 } }])
  })

  it('groups the tracked loads by division', () => {
    const series = trackingLive(fixture(), OCTOBER, 'DIVISION')
    expect(series.rows).toEqual([
      { label: 'BCAT Logistics', values: { total: 1 } },
      { label: 'Ivan Cartage', values: { total: 1 } },
    ])
  })

  it('narrows the live picture to Brokerage', () => {
    const series = trackingLive(fixture(), BROKERAGE_ONLY, null)
    expect(series.kpis?.map((k) => k.value)).toEqual(['1', '2', '2'])
  })
})

// ── 7. tracking-history ──────────────────────────────────────────────────────

describe('trackingHistory', () => {
  it('reports the real share tracked, compliance and median time to first ping', () => {
    const series = trackingHistory(fixture(), OCTOBER)
    expect(series.kpis).toEqual([
      // 4 LINK + 2 MOTIVE + 1 DRIVER_APP of 10; NONE and MANUAL are not tracking.
      { label: 'Share tracked', value: '70%', sub: '7 of 10 shipments' },
      // 15 of the 21 check calls the schedule asked for landed.
      { label: 'Check-call compliance', value: '71.4%', sub: '15 of 21 check calls' },
      // Hours pickup → first ping: 6, 2, 12, 4, 8 → nearest-rank median 6.
      { label: 'Median hours to first ping', value: '6', sub: '5 shipments pinged' },
    ])
    expect(series.note).toBeNull()
  })

  it('breaks the window down by tracking source', () => {
    const series = trackingHistory(fixture(), OCTOBER)
    expect(series.rows).toEqual([
      { label: 'LINK', values: { total: 4 } },
      { label: 'MOTIVE', values: { total: 2 } },
      { label: 'NONE', values: { total: 2 } },
      { label: 'DRIVER_APP', values: { total: 1 } },
      { label: 'MANUAL', values: { total: 1 } },
    ])
  })

  it('shows honest zeros and says the facts are still filling in', () => {
    const data = fixture()
    data.samples = data.samples.map((s) => ({
      ...s,
      trackingProvider: null,
      firstPingAt: null,
      checkCallsDue: null,
      checkCallsMet: null,
    }))
    const series = trackingHistory(data, OCTOBER)
    expect(series.kpis?.map((k) => k.value)).toEqual(['0%', '0%', '0'])
    expect(series.rows).toEqual([{ label: 'Unknown', values: { total: 10 } }])
    expect(series.note).toBe(TRACKING_HISTORY_EMPTY_NOTE)
  })
})

// ── 8. pod-needed ────────────────────────────────────────────────────────────

describe('podNeeded', () => {
  it('lists the delivered shipments whose POD has not landed, oldest first', () => {
    const series = podNeeded(fixture(), OCTOBER, null)
    expect(series.kpis).toEqual([{ label: 'Needs POD', value: '3', sub: 'delivered, POD not received' }])
    expect(series.rows).toEqual([
      // s02 and s10 have a sample with no POD stamp; s03 has no sample at all, so the
      // order's own docsMissing list answers.
      { label: 'S1002', values: { days: 23 }, text: { customer: 'Acme Foods', carrier: 'Beta Lines', delivered: '2026-10-05' } },
      { label: 'S1003', values: { days: 22 }, text: { customer: 'Acme Foods', carrier: 'Gamma Transit', delivered: '2026-10-06' } },
      { label: 'S1010', values: { days: 20 }, text: { customer: 'Nord Steel', carrier: 'Ivan Cartage', delivered: '2026-10-08' } },
    ])
    expect(series.columns?.map((c) => c.key)).toEqual(['customer', 'carrier', 'delivered', 'days'])
  })

  it('counts the backlog per division in the tiles', () => {
    const series = podNeeded(fixture(), OCTOBER, 'DIVISION')
    expect(series.kpis).toEqual([
      { label: 'Needs POD', value: '3', sub: 'delivered, POD not received' },
      { label: 'BCAT Logistics', value: '2', sub: null },
      { label: 'Ivan Cartage', value: '1', sub: null },
    ])
  })

  it('says so when every delivered shipment has its POD', () => {
    const data = fixture()
    data.samples = data.samples.map((s) => ({ ...s, podReceivedAt: s.podReceivedAt ?? s.deliveredAt }))
    data.orders = data.orders.map((o) => ({ ...o, docsMissing: [] }))
    const series = podNeeded(data, OCTOBER, null)
    expect(series.rows).toEqual([])
    expect(series.note).toBe(POD_NEEDED_CLEAR_NOTE)
  })
})

// ── 9. pod-timing ────────────────────────────────────────────────────────────

describe('podTiming', () => {
  it('ranks carriers by their 90th-percentile collection time', () => {
    const series = podTiming(fixture(), OCTOBER)
    expect(series.rows).toEqual([
      { label: 'Gamma Transit', values: { p50: 72, p90: 72, samples: 1 } },
      // Alpha Freight: 6, 12, 24, 48 hours → nearest-rank p50 12, p90 48.
      { label: 'Alpha Freight', values: { p50: 12, p90: 48, samples: 4 } },
      { label: 'Beta Lines', values: { p50: 24, p90: 30, samples: 2 } },
      { label: 'Ivan Cartage', values: { p50: 4, p90: 4, samples: 1 } },
    ])
    // All eight: 4, 6, 12, 24, 24, 30, 48, 72 → p50 24, p90 72.
    expect(series.kpis).toEqual([
      { label: 'Overall p50', value: '24', sub: 'hours to POD' },
      { label: 'Overall p90', value: '72', sub: 'hours to POD' },
      { label: 'PODs measured', value: '8', sub: 'of 10 shipments' },
    ])
    expect(series.note).toBeNull()
  })

  it('narrows to the Brokerage carriers', () => {
    const series = podTiming(fixture(), BROKERAGE_ONLY)
    expect(series.rows).toEqual([
      { label: 'Gamma Transit', values: { p50: 72, p90: 72, samples: 1 } },
      { label: 'Beta Lines', values: { p50: 30, p90: 30, samples: 1 } },
      { label: 'Alpha Freight', values: { p50: 12, p90: 24, samples: 3 } },
    ])
  })

  it('refuses to dress up two observations as a percentile', () => {
    const data = fixture()
    data.samples = data.samples.slice(0, 2).map((s, i) => ({
      ...s,
      podReceivedAt: i === 0 ? s.podReceivedAt : null,
    }))
    const series = podTiming(data, OCTOBER)
    expect(series.note).toBe(
      'Only 1 of 2 shipments in this window carry both a delivery and a POD time; percentiles need at least 3.',
    )
  })
})
