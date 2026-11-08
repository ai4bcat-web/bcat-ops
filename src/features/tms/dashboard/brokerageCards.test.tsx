import { describe, expect, it } from 'vitest'

import { BROKERAGE_CHARTS } from './brokerageCards'
import type { DashboardData, DashboardFilters } from './types'
import { DAT_EMPTY_NOTE, POD_NEEDED_CLEAR_NOTE, TRACKING_HISTORY_EMPTY_NOTE } from '@/lib/brokerageCharts'
import type {
  CarrierBillRecord,
  InvoiceRecord,
  LaneRateSampleRecord,
  LoadCarrierRecord,
  OrderRecord,
  OwnershipDivisionRecord,
  ShipmentRecord,
  UserProfileRecord,
} from '@/types/tms'

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

const BROKERAGE: OwnershipDivisionRecord = {
  id: 'BROKERAGE',
  code: 'BROKERAGE',
  name: 'BCAT Logistics',
  brand: 'BCAT Logistics',
  parentId: null,
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

const AMY: UserProfileRecord = {
  id: 'rep-amy',
  email: 'amy@bcatcorp.com',
  name: 'Amy Diaz',
  createdBy: 'seed',
  updatedBy: 'seed',
  version: 1,
}

function shipment(id: string, number: string, status: ShipmentRecord['status'], pickup: string, extra: Partial<ShipmentRecord> = {}): ShipmentRecord {
  return {
    id,
    number,
    status,
    customerId: 'c-acme',
    customerName: 'Acme Foods',
    mode: 'FTL',
    source: 'MANUAL',
    pickupAppt: pickup,
    revDivision: 'BROKERAGE',
    revTagSource: 'RULE',
    salesRepId: 'rep-amy',
    createdBy: 'seed',
    updatedBy: 'seed',
    createdAt: pickup,
    updatedAt: pickup,
    ...extra,
  }
}

function order(shipmentId: string): OrderRecord {
  return {
    id: `o-${shipmentId}`,
    shipmentId,
    customerId: 'c-acme',
    customerRepId: 'rep-amy',
    mode: 'FTL',
    docsMissing: [],
    createdBy: 'seed',
    updatedBy: 'seed',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function sample(id: string, shipmentId: string, extra: Partial<LaneRateSampleRecord>): LaneRateSampleRecord {
  return {
    id,
    laneKey: 'CHICAGO|IL>DANVILLE|IL',
    date: '2026-10-05',
    loadId: `l-${id}`,
    shipmentId,
    customerId: 'c-acme',
    source: 'LOAD',
    sampledAt: NOW,
    version: 1,
    revDivision: 'BROKERAGE',
    salesRepId: 'rep-amy',
    ...extra,
  }
}

/** Three shipments, two priced samples, one moving load, one open invoice, one open bill. */
function bundle(): DashboardData {
  const shipments = [
    shipment('x1', 'S2001', 'DELIVERED', '2026-10-02T08:00:00.000Z'),
    shipment('x2', 'S2002', 'IN_TRANSIT', '2026-10-20T08:00:00.000Z', { datPostedAt: '2026-10-19T10:00:00.000Z' }),
    shipment('x3', 'S2003', 'DELIVERED', '2026-10-03T08:00:00.000Z'),
  ]
  const invoice: InvoiceRecord = {
    id: 'i1',
    number: 'INV-1',
    orderId: 'o-x1',
    shipmentId: 'x1',
    customerId: 'c-acme',
    status: 'ISSUED',
    invoiceDate: '2026-10-20',
    issuedAt: '2026-10-20T12:00:00.000Z',
    issuedBy: 'seed',
    dueAt: '2026-11-19',
    termsDays: 30,
    invoiceMonth: '2026-10',
    subtotalCents: 100_000,
    totalCents: 100_000,
    paidCents: 0,
    writtenOffCents: 0,
    balanceCents: 100_000,
    arOpen: 'OPEN',
    createdBy: 'seed',
    updatedBy: 'seed',
    version: 1,
  }
  const bill: CarrierBillRecord = {
    id: 'b1',
    loadCarrierId: 'lc-x2',
    loadId: 'lx2',
    shipmentId: 'x2',
    carrierId: 'car-a',
    payeeKind: 'CARRIER',
    status: 'TO_BE_PAID',
    billDate: '2026-10-20',
    billMonth: '2026-10',
    recordedAt: '2026-10-20T12:00:00.000Z',
    recordedBy: 'seed',
    dueAt: '2026-11-19',
    termsDays: 30,
    grossCents: 50_000,
    quickPayFeeCents: 0,
    netCents: 50_000,
    billedCents: 50_000,
    varianceCents: 0,
    paidCents: 0,
    creditedCents: 0,
    balanceCents: 50_000,
    apOpen: 'OPEN',
    createdBy: 'seed',
    updatedBy: 'seed',
    version: 1,
  }
  const leg: LoadCarrierRecord = {
    id: 'lc-x2',
    loadId: 'lx2',
    shipmentId: 'x2',
    kind: 'CARRIER',
    status: 'ACTIVE',
    carrierId: 'car-a',
    carrierName: 'Alpha Freight',
  }
  return {
    shipments,
    orders: shipments.map((s) => order(s.id)),
    loads: [
      {
        id: 'lx2',
        shipmentId: 'x2',
        status: 'IN_TRANSIT',
        revDivision: 'BROKERAGE',
        salesRepId: 'rep-amy',
        pickupAppt: '2026-10-20T08:00:00.000Z',
        carrierName: 'Alpha Freight',
        trackingProvider: 'LINK',
        lastKnownAt: '2026-10-28T06:00:00.000Z',
        nextCheckCallAt: '2026-10-27T00:00:00.000Z',
        shipmentStatus: 'IN_TRANSIT',
      },
    ],
    loadCarriers: [leg],
    samples: [
      sample('n1', 'x1', {
        date: '2026-10-04',
        carrierId: 'car-a',
        carrierName: 'Alpha Freight',
        revenueCents: 100_000,
        costCents: 60_000,
        profitCents: 40_000,
        deliveredAt: '2026-10-04T08:00:00.000Z',
        podReceivedAt: '2026-10-05T08:00:00.000Z',
        trackingProvider: 'LINK',
        firstPingAt: '2026-10-02T12:00:00.000Z',
        checkCallsDue: 2,
        checkCallsMet: 2,
      }),
      sample('n2', 'x3', {
        date: '2026-10-05',
        carrierId: 'car-b',
        carrierName: 'Beta Lines',
        revenueCents: 50_000,
        costCents: 30_000,
        profitCents: 20_000,
        deliveredAt: '2026-10-05T08:00:00.000Z',
        podReceivedAt: null,
        trackingProvider: 'NONE',
        checkCallsDue: 2,
        checkCallsMet: 1,
      }),
    ],
    openInvoices: [invoice],
    openBills: [bill],
    quotes: [],
    profiles: [AMY],
    divisions: [BROKERAGE],
    now: NOW,
  }
}

const EMPTY: DashboardData = {
  shipments: [],
  orders: [],
  loads: [],
  loadCarriers: [],
  samples: [],
  openInvoices: [],
  openBills: [],
  quotes: [],
  profiles: [],
  divisions: [],
  now: NOW,
}

function seriesOf(key: string, data: DashboardData = bundle()) {
  const chart = BROKERAGE_CHARTS.find((c) => c.key === key)
  if (!chart) throw new Error(`no brokerage chart ${key}`)
  return chart.compute(data, OCTOBER, null)
}

describe('BROKERAGE_CHARTS catalogue', () => {
  it('is the nine cards Ryne asked for, in his order', () => {
    expect(BROKERAGE_CHARTS.map((c) => [c.key, c.title, c.kind])).toEqual([
      ['status-counts', 'Shipments in each status', 'bar'],
      ['dat-posted', 'Posted to DAT', 'bar'],
      ['ar-by-rep', 'Outstanding AR by rep', 'bar'],
      ['ap-by-rep', 'Outstanding AP by rep', 'bar'],
      ['rep-leaderboard', 'Rep leaderboard', 'table'],
      ['tracking-live', 'Being tracked now', 'bar'],
      ['tracking-history', 'Tracking history', 'bar'],
      ['pod-needed', 'Shipments needing PODs', 'table'],
      ['pod-timing', 'POD collection by carrier', 'table'],
    ])
    expect(BROKERAGE_CHARTS.every((c) => c.group === 'brokerage')).toBe(true)
  })

  it('gives every table card the explicit columns the renderer needs', () => {
    for (const chart of BROKERAGE_CHARTS.filter((c) => c.kind === 'table')) {
      const series = chart.compute(bundle(), OCTOBER, null)
      expect(series.columns?.length).toBeGreaterThan(0)
    }
  })
})

describe('each card computes from the bundle', () => {
  it('status-counts keeps all 17 status rows', () => {
    const series = seriesOf('status-counts')
    expect(series.rows).toHaveLength(17)
    expect(series.rows.find((r) => r.label === 'DEL')?.values.total).toBe(2)
    expect(series.rows.find((r) => r.label === 'INTRAN')?.values.total).toBe(1)
  })

  it('dat-posted counts the one stamped shipment', () => {
    expect(seriesOf('dat-posted').rows).toEqual([{ label: 'Posted to DAT', values: { total: 1 } }])
  })

  it('ar-by-rep and ap-by-rep name the rep and print cents', () => {
    const ar = seriesOf('ar-by-rep')
    expect(ar.valueFormat).toBe('cents')
    expect(ar.rows).toEqual([{ label: 'Amy Diaz', values: { total: 100_000 } }])
    expect(seriesOf('ap-by-rep').rows).toEqual([{ label: 'Amy Diaz', values: { total: 50_000 } }])
  })

  it('rep-leaderboard totals the samples and the open AR', () => {
    expect(seriesOf('rep-leaderboard').rows).toEqual([
      {
        label: 'Amy Diaz',
        values: { shipments: 2, revenue: 150_000, profit: 60_000, marginBps: 4000, openAr: 100_000 },
      },
    ])
  })

  it('tracking-live tiles the live, untracked and overdue counts', () => {
    expect(seriesOf('tracking-live').kpis?.map((k) => k.value)).toEqual(['1', '0', '1'])
  })

  it('tracking-history tiles the share tracked and the compliance', () => {
    const series = seriesOf('tracking-history')
    expect(series.kpis?.map((k) => k.value)).toEqual(['50%', '75%', '4'])
    expect(series.rows).toEqual([
      { label: 'LINK', values: { total: 1 } },
      { label: 'NONE', values: { total: 1 } },
    ])
  })

  it('pod-needed lists the shipment whose POD has not landed', () => {
    const series = seriesOf('pod-needed')
    expect(series.rows).toEqual([
      // x3 has no board load and no open leg, so the sample names the carrier.
      { label: 'S2003', values: { days: 23 }, text: { customer: 'Acme Foods', carrier: 'Beta Lines', delivered: '2026-10-05' } },
    ])
  })

  it('pod-timing measures the one POD it has and refuses to call it a percentile', () => {
    const series = seriesOf('pod-timing')
    expect(series.rows).toEqual([{ label: 'Alpha Freight', values: { p50: 24, p90: 24, samples: 1 } }])
    expect(series.note).toContain('percentiles need at least 3')
  })
})

describe('an empty window', () => {
  it('renders nine honest cards instead of a crash or an invented shape', () => {
    for (const chart of BROKERAGE_CHARTS) {
      const series = chart.compute(EMPTY, OCTOBER, 'DIVISION')
      expect(Array.isArray(series.rows)).toBe(true)
      expect(series.groups.length).toBeGreaterThan(0)
      for (const row of series.rows) {
        for (const value of Object.values(row.values)) expect(value).toBe(0)
      }
    }
  })

  it('says why the zero is a zero on the three cards that know', () => {
    expect(seriesOf('dat-posted', EMPTY).note).toBe(DAT_EMPTY_NOTE)
    expect(seriesOf('tracking-history', EMPTY).note).toBe(TRACKING_HISTORY_EMPTY_NOTE)
    expect(seriesOf('pod-needed', EMPTY).note).toBe(POD_NEEDED_CLEAR_NOTE)
  })
})
