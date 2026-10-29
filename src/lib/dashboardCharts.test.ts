import { describe, expect, it } from 'vitest'
import {
  applyFilters,
  groupKey,
  hydrateLoads,
  limitRows,
  metricValue,
  monthsBetween,
  rankRows,
  collect,
  addSample,
  addCount,
  sortRowsByKey,
  toSeries,
  sampleRow,
  shipmentRow,
  dimensionRowOf,
  formatValue,
} from './dashboardCharts'
import { CLASSIC_CHARTS } from '@/features/tms/dashboard/classicCharts'
import type { DashboardData, DashboardFilters, LoadSummaryRecord } from '@/features/tms/dashboard/types'
import type {
  LaneRateSampleRecord,
  LoadCarrierRecord,
  OrderRecord,
  OwnershipDivisionRecord,
  QuoteRecord,
  ShipmentRecord,
  UserProfileRecord,
} from '@/types/tms'

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// Two divisions, two reps, two customers, two carriers, two months. Small enough to
// add up by hand, wide enough that a division filter and a group-by have work to do.

const shipment = (over: Partial<ShipmentRecord> & { id: string }): ShipmentRecord => ({
  number: `P${over.id}`,
  status: 'DELIVERED',
  customerId: 'cust-a',
  customerName: 'Acme',
  mode: 'TRUCKLOAD',
  source: 'MANUAL',
  pickupAppt: '2026-10-05T12:00:00.000Z',
  revDivision: 'BROKERAGE',
  revSubdivision: null,
  salesRepId: 'rep-1',
  createdBy: 'test',
  updatedBy: 'test',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

const order = (over: Partial<OrderRecord> & { id: string; shipmentId: string }): OrderRecord => ({
  customerId: 'cust-a',
  mode: 'TRUCKLOAD',
  createdBy: 'test',
  updatedBy: 'test',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

const sample = (over: Partial<LaneRateSampleRecord> & { id: string; shipmentId: string }): LaneRateSampleRecord => ({
  laneKey: 'CHICAGO|IL>DANVILLE|IL',
  date: '2026-10-05',
  loadId: `load-${over.shipmentId}`,
  customerId: 'cust-a',
  customerName: 'Acme',
  carrierId: 'car-1',
  carrierName: 'Fast Freight',
  revDivision: 'BROKERAGE',
  salesRepId: 'rep-1',
  revenueCents: 100_000,
  costCents: 80_000,
  profitCents: 20_000,
  source: 'LOAD',
  sampledAt: '2026-10-06T00:00:00.000Z',
  version: 1,
  ...over,
})

const quote = (over: Partial<QuoteRecord> & { id: string }): QuoteRecord => ({
  side: 'SELL',
  status: 'QUOTED',
  quoteDate: '2026-10-04',
  quoteMonth: '2026-10',
  customerId: 'cust-a',
  customerName: 'Acme',
  customerRepId: 'rep-1',
  amountCents: 120_000,
  rounds: 1,
  createdBy: 'test',
  updatedBy: 'test',
  version: 1,
  ...over,
})

const profile = (id: string, name: string): UserProfileRecord => ({
  id, email: `${id}@bcatcorp.com`, name, createdBy: 'test', updatedBy: 'test', version: 1,
})

const division = (code: string, name: string): OwnershipDivisionRecord => ({
  id: code, code, name, brand: null, parentId: null, color: null, sortOrder: 0, active: true,
  owners: null, flows: null, createdBy: 'test', updatedBy: 'test',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})

function bundle(over: Partial<DashboardData> = {}): DashboardData {
  const shipments: ShipmentRecord[] = [
    shipment({ id: 's1' }),
    shipment({ id: 's2', customerId: 'cust-b', customerName: 'Globex', salesRepId: 'rep-2', status: 'IN_TRANSIT' }),
    shipment({ id: 's3', revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK', pickupAppt: '2026-10-09T12:00:00.000Z' }),
    shipment({ id: 's4', pickupAppt: '2026-11-03T12:00:00.000Z' }),
  ]
  return {
    shipments,
    orders: shipments.map((s) => order({ id: `o-${s.id}`, shipmentId: s.id, customerId: s.customerId })),
    loads: [],
    loadCarriers: [],
    samples: [
      sample({ id: 'lrs-1', shipmentId: 's1' }),
      sample({
        id: 'lrs-2', shipmentId: 's2', customerId: 'cust-b', customerName: 'Globex',
        carrierId: 'car-2', carrierName: 'Slow Freight', salesRepId: 'rep-2',
        revenueCents: 200_000, costCents: 190_000, profitCents: 10_000,
      }),
      sample({ id: 'lrs-3', shipmentId: 's3', revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK', date: '2026-10-09' }),
      sample({ id: 'lrs-4', shipmentId: 's4', date: '2026-11-03' }),
      sample({ id: 'lrs-x', shipmentId: 's1', excluded: true, revenueCents: 999_999, costCents: 0, profitCents: 999_999 }),
    ],
    openInvoices: [],
    openBills: [],
    quotes: [quote({ id: 'q1' }), quote({ id: 'q2', customerId: 'cust-b', customerName: 'Globex' }), quote({ id: 'q3' })],
    profiles: [profile('rep-1', 'Dana Reyes'), profile('rep-2', 'Sam Cole')],
    divisions: [division('BROKERAGE', 'BCAT Logistics'), division('ASSETS', 'Ivan Cartage'), division('BOX_TRUCK', 'Box Trucks')],
    now: '2026-10-15T00:00:00.000Z',
    ...over,
  }
}

const filters = (over: Partial<DashboardFilters> = {}): DashboardFilters => ({
  divisions: [], subdivisions: [], from: '2026-10-01', to: '2026-11-30',
  mode: null, status: null, customerId: null, carrierId: null, repId: null,
  ...over,
})

const chart = (key: string) => {
  const found = CLASSIC_CHARTS.find((candidate) => candidate.key === key)
  if (!found) throw new Error(`no chart ${key}`)
  return found
}

// ── Window maths ─────────────────────────────────────────────────────────────

describe('window maths', () => {
  it('lists every month a window touches, oldest first', () => {
    expect(monthsBetween('2026-11-15', '2027-02-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
  })

  it('prints a margin in basis points and money in dollars', () => {
    expect(formatValue(4670, 'bps')).toBe('46.7%')
    expect(formatValue(123_456, 'cents')).toBe('$1,234.56')
  })
})

// ── Filtering ────────────────────────────────────────────────────────────────

describe('applyFilters', () => {
  it('keeps only the asked-for division, on shipments and on their facts', () => {
    const data = applyFilters(bundle(), filters({ divisions: ['BROKERAGE'] }))
    expect(data.shipments.map((s) => s.id)).toEqual(['s1', 's2', 's4'])
    expect(data.samples.map((s) => s.id)).toEqual(['lrs-1', 'lrs-2', 'lrs-4', 'lrs-x'])
  })

  it('narrows to a subsidiary inside a division', () => {
    const data = applyFilters(bundle(), filters({ divisions: ['ASSETS'], subdivisions: ['BOX_TRUCK'] }))
    expect(data.shipments.map((s) => s.id)).toEqual(['s3'])
  })

  it('bounds the window by the pickup date, and a sample by its own date', () => {
    const data = applyFilters(bundle(), filters({ from: '2026-10-01', to: '2026-10-31' }))
    expect(data.shipments.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(data.samples.map((s) => s.id)).not.toContain('lrs-4')
  })

  it('never counts a voided shipment', () => {
    const raw = bundle()
    raw.shipments[0] = { ...raw.shipments[0], voidedAt: '2026-10-07T00:00:00.000Z', voidReason: 'duplicate' }
    const data = applyFilters(raw, filters())
    expect(data.shipments.map((s) => s.id)).not.toContain('s1')
    expect(data.samples.map((s) => s.id)).not.toContain('lrs-1')
  })

  it('is idempotent and memoised, so every card may call it', () => {
    const raw = bundle()
    const once = applyFilters(raw, filters({ divisions: ['BROKERAGE'] }))
    const twice = applyFilters(raw, filters({ divisions: ['BROKERAGE'] }))
    expect(twice).toBe(once)
    expect(applyFilters(once, filters({ divisions: ['BROKERAGE'] })).shipments).toEqual(once.shipments)
  })

  it('keeps an untagged quote under a division filter and says so on the card', () => {
    const data = applyFilters(bundle({ quotes: [quote({ id: 'q9', shipmentId: null })] }), filters({ divisions: ['BROKERAGE'] }))
    expect(data.quotes.map((q) => q.id)).toEqual(['q9'])
    expect(chart('quotes-top-5-customers').compute(bundle(), filters(), 'DIVISION').note)
      .toMatch(/no division tag/i)
  })
})

// ── Grouping ────────────────────────────────────────────────────────────────

describe('groupKey', () => {
  const data = bundle()

  it('labels a division by its name and a rep by their profile name', () => {
    expect(groupKey('DIVISION', shipmentRow(data.shipments[0], data), data)).toBe('BCAT Logistics')
    expect(groupKey('REP', shipmentRow(data.shipments[0], data), data)).toBe('Dana Reyes')
  })

  it('shows a legacy e-mail rep id as the e-mail', () => {
    expect(groupKey('REP', { salesRepId: 'ryne@bcatcorp.com' }, data)).toBe('ryne@bcatcorp.com')
  })

  it('names a missing dimension instead of dropping the row', () => {
    expect(groupKey('DIVISION', {}, data)).toBe('Untagged')
    expect(groupKey('CUSTOMER', {}, data)).toBe('No customer')
    expect(groupKey('CARRIER', {}, data)).toBe('No carrier')
  })

  it('is "total" when the dashboard is not grouped', () => {
    expect(groupKey(null, shipmentRow(data.shipments[0], data), data)).toBe('total')
  })

  it('buckets a month from the row date', () => {
    expect(groupKey('MONTH', sampleRow(data.samples[3], data), data)).toBe('Nov 2026')
  })
})

// ── Buckets ─────────────────────────────────────────────────────────────────

describe('bucket maths', () => {
  it('reads a margin of zero when there is no revenue to divide by', () => {
    expect(metricValue({ revenueCents: 0, costCents: 4_000, profitCents: -4_000, count: 1 }, 'margin')).toBe(0)
    expect(metricValue({ revenueCents: 100_000, costCents: 80_000, profitCents: 20_000, count: 1 }, 'margin')).toBe(2000)
  })

  it('rolls the tail into one Other row whose margin is the real weighted margin', () => {
    const data = bundle()
    const grouped = rankRows(collect(
      [
        sample({ id: 'a', shipmentId: 's1', customerId: 'c1', customerName: 'One', revenueCents: 300_000, costCents: 150_000, profitCents: 150_000 }),
        sample({ id: 'b', shipmentId: 's1', customerId: 'c2', customerName: 'Two', revenueCents: 100_000, costCents: 90_000, profitCents: 10_000 }),
        sample({ id: 'c', shipmentId: 's1', customerId: 'c3', customerName: 'Three', revenueCents: 100_000, costCents: 50_000, profitCents: 50_000 }),
      ],
      (row) => dimensionRowOf('CUSTOMER', sampleRow(row, data), data),
      () => 'total',
      addSample,
    ), (b) => b.revenueCents)
    const series = toSeries(limitRows(grouped, 1), 'margin', 'bps')
    expect(series.rows.map((row) => row.label)).toEqual(['One', 'Other'])
    // Other = 200,000 revenue, 60,000 profit → 30.0%
    expect(series.rows[1].values.total).toBe(3000)
  })

  it('drops the tail instead when the card is a top-N with no Other', () => {
    const data = bundle()
    const grouped = rankRows(collect(
      data.quotes,
      (row) => dimensionRowOf('CUSTOMER', { customerId: row.customerId, customerName: row.customerName }, data),
      () => 'total',
      addCount,
    ), (b) => b.count)
    expect(limitRows(grouped, 1, null).rows.map((row) => row.label)).toEqual(['Acme'])
  })

  it('fills every group on every row, so a gap is a real zero', () => {
    const data = applyFilters(bundle(), filters())
    const grouped = sortRowsByKey(collect(
      data.samples.filter((s) => !s.excluded),
      (row) => dimensionRowOf('MONTH', sampleRow(row, data), data),
      (row) => groupKey('CUSTOMER', sampleRow(row, data), data),
      addSample,
    ))
    const series = toSeries(grouped, 'revenue', 'cents')
    for (const row of series.rows) {
      for (const group of series.groups) expect(typeof row.values[group]).toBe('number')
    }
    expect(series.rows.find((row) => row.label === 'Nov 2026')?.values.Globex).toBe(0)
  })
})

// ── Hydration ───────────────────────────────────────────────────────────────

describe('hydrateLoads', () => {
  it('joins the shipment, the active leg and the sample onto a board load', () => {
    const data = bundle()
    const legs: LoadCarrierRecord[] = [
      { id: 'lc-1', loadId: 'load-s1', shipmentId: 's1', kind: 'CARRIER', status: 'ACTIVE', carrierId: 'car-1', carrierName: 'Fast Freight', createdBy: 't', updatedBy: 't', version: 1 } as LoadCarrierRecord,
      { id: 'lc-0', loadId: 'load-s1', shipmentId: 's1', kind: 'CARRIER', status: 'BOUNCED', carrierId: 'car-9', carrierName: 'Gone', createdBy: 't', updatedBy: 't', version: 1 } as LoadCarrierRecord,
    ]
    const [load] = hydrateLoads(
      [{ id: 'load-s1', shipmentId: 's1', status: 'DELIVERED' }],
      data.shipments,
      legs,
      data.samples,
    )
    expect(load.customerName).toBe('Acme')
    expect(load.revDivision).toBe('BROKERAGE')
    expect(load.shipmentStatus).toBe('DELIVERED')
    expect(load.carrierId).toBe('car-1')
    expect(load.activeLoadCarrierId).toBe('lc-1')
    expect(load.pickupAppt).toBe('2026-10-05T12:00:00.000Z')
  })

  it('leaves a load with no leg and no sample honestly empty', () => {
    const [load]: LoadSummaryRecord[] = hydrateLoads([{ id: 'load-x', shipmentId: null }], [], [], [])
    expect(load.carrierId).toBeNull()
    expect(load.trackingProvider ?? null).toBeNull()
    expect(load.podReceivedAt).toBeNull()
  })
})

// ── The 17 Classic cards ────────────────────────────────────────────────────

describe('the Classic charts', () => {
  it('are the 17 MVMNT cards, in MVMNT order', () => {
    expect(CLASSIC_CHARTS.map((c) => c.key)).toEqual([
      'basic-kpis', 'shipments', 'revenue', 'profit', 'margin',
      'revenue-by-rep', 'profit-by-rep', 'margin-by-rep',
      'revenue-by-customer', 'profit-by-customer', 'margin-by-customer',
      'margin-by-carrier', 'profit-by-carrier', 'shipments-by-status',
      'quotes-top-5-customers', 'top-10-customers', 'top-10-carriers',
    ])
    expect(CLASSIC_CHARTS).toHaveLength(17)
  })

  it('totals the KPI tiles from the priced facts only', () => {
    const series = chart('basic-kpis').compute(bundle(), filters(), 'DIVISION')
    const tiles = Object.fromEntries((series.kpis ?? []).map((kpi) => [kpi.label, kpi.value]))
    // 4 shipments; 4 priced samples (the excluded one is skipped): 500,000 revenue,
    // 430,000 cost, 70,000 profit → 14.0%.
    expect(tiles.Shipments).toBe('4')
    expect(tiles.Revenue).toBe('$5,000.00')
    expect(tiles.Cost).toBe('$4,300.00')
    expect(tiles.Profit).toBe('$700.00')
    expect(tiles.Margin).toBe('14.0%')
  })

  it('counts shipments by month, and the months add up to the shipment count', () => {
    const series = chart('shipments').compute(bundle(), filters(), 'DIVISION')
    expect(series.rows.map((row) => row.label)).toEqual(['Oct 2026', 'Nov 2026'])
    const total = series.rows.reduce((sum, row) => sum + Object.values(row.values).reduce((a, b) => a + b, 0), 0)
    expect(total).toBe(4)
  })

  for (const key of ['revenue', 'profit', 'revenue-by-rep', 'profit-by-rep', 'revenue-by-customer', 'top-10-customers']) {
    it(`${key}: the grand total equals the sum of its groups`, () => {
      const data = bundle()
      const grouped = chart(key).compute(data, filters(), 'DIVISION')
      const ungrouped = chart(key).compute(data, filters(), null)
      const sumOf = (series: typeof grouped) => series.rows
        .reduce((sum, row) => sum + series.groups.reduce((rowSum, group) => rowSum + (row.values[group] ?? 0), 0), 0)
      expect(sumOf(grouped)).toBe(sumOf(ungrouped))
      expect(grouped.groups).toContain('BCAT Logistics')
      expect(ungrouped.groups).toEqual(['total'])
    })
  }

  it('excludes other divisions when the chip names one', () => {
    const only = chart('revenue-by-rep').compute(bundle(), filters({ divisions: ['BROKERAGE'] }), null)
    const all = chart('revenue-by-rep').compute(bundle(), filters(), null)
    const sum = (series: typeof only) => series.rows.reduce((total, row) => total + row.values.total, 0)
    // The ASSETS sample (100,000) drops out.
    expect(sum(all) - sum(only)).toBe(100_000)
  })

  it('weights a margin by rep rather than averaging percentages', () => {
    const series = chart('margin-by-rep').compute(bundle(), filters({ divisions: ['BROKERAGE'] }), null)
    const rows = Object.fromEntries(series.rows.map((row) => [row.label, row.values.total]))
    // Dana: 200,000 revenue / 40,000 profit = 20.0%. Sam: 200,000 / 10,000 = 5.0%.
    expect(rows['Dana Reyes']).toBe(2000)
    expect(rows['Sam Cole']).toBe(500)
    expect(series.valueFormat).toBe('bps')
  })

  it('slices shipments by status, biggest slice first', () => {
    const series = chart('shipments-by-status').compute(bundle(), filters(), 'DIVISION')
    expect(series.rows[0].label).toBe('DEL')
    expect(series.rows[0].values.total).toBe(3)
    expect(series.groups).toEqual(['total'])
  })

  it('counts the window\'s quotes for the top five customers', () => {
    const series = chart('quotes-top-5-customers').compute(bundle(), filters(), null)
    expect(series.rows.map((row) => [row.label, row.values.total])).toEqual([['Acme', 2], ['Globex', 1]])
  })

  it('ranks the top carriers by what they cost us', () => {
    const series = chart('top-10-carriers').compute(bundle(), filters({ divisions: ['BROKERAGE'] }), null)
    expect(series.rows.map((row) => row.label)).toEqual(['Slow Freight', 'Fast Freight'])
    expect(series.rows[0].values.total).toBe(190_000)
  })

  it('says so, with a real zero, when nothing in the window is priced', () => {
    const series = chart('revenue').compute(bundle({ samples: [] }), filters(), 'DIVISION')
    expect(series.rows).toEqual([])
    expect(series.note).toMatch(/real zero/i)
  })
})
