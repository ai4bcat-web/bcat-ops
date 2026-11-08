// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SEED_DIVISIONS } from './ownership'
import {
  computeLive,
  computeMonth,
  dirtyKeysForRecord,
  rollupMonthsFor,
  stripsFromRollup,
  type BillLite,
  type InvoiceLite,
  type LivePayload,
  type LoadLite,
  type MonthPayload,
  type MonthSource,
  type OrderLite,
  type RollupWindow,
  type SampleLite,
  type ShipmentLite,
} from './dashboardRollup'
import { buildBusinessStrips, buildCompanyTotals, rollupBusinessStrips } from '@/features/tms/dashboard/businessStrips'
import type { DashboardData, DashboardFilters } from '@/features/tms/dashboard/types'

// ── Fixture: one set of rows, fed to the exact path and to the rollup ────────

const SCOPES: Array<[string | null, string | null]> = [
  ['BROKERAGE', null],
  ['ASSETS', null],
  ['ASSETS', 'BOX_TRUCK'],
  [null, null],
  ['CAR_SHIPPING', null],
  ['BROKERAGE', 'BOX_TRUCK'],
]
const STATUSES = ['OPEN', 'BOOKED', 'IN_TRANSIT', 'DELIVERED', 'DELIVERED', 'CANCELED']
const LOAD_STATUSES = ['BOOKED', 'IN_TRANSIT', 'DELIVERED', 'PICKED_UP', 'DISPATCHED', 'DELIVERED']

interface Rows {
  shipments: ShipmentLite[]
  loads: LoadLite[]
  orders: OrderLite[]
  samples: Array<SampleLite & { id: string; loadId: string }>
  invoices: InvoiceLite[]
  bills: BillLite[]
}

function fixture(): Rows {
  const rows: Rows = { shipments: [], loads: [], orders: [], samples: [], invoices: [], bills: [] }
  const days = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-15', '2026-10-31', '2026-11-01', '2026-11-03']
  for (let i = 0; i < 42; i++) {
    const [div, sub] = SCOPES[i % SCOPES.length]!
    const day = days[i % days.length]!
    const id = `s${i}`
    const voided = i % 13 === 0
    rows.shipments.push({
      id, status: STATUSES[i % STATUSES.length], pickupAppt: `${day}T12:00:00.000Z`, pickupMonth: day.slice(0, 7),
      revDivision: div, revSubdivision: sub, voidedAt: voided ? '2026-10-20T00:00:00.000Z' : null,
    })
    // The load's own pickup sometimes lands in the next month; every 5th load re-tags itself.
    const loadDay = i % 7 === 4 ? '2026-11-01' : day
    rows.loads.push({
      id: `l${i}`, shipmentId: id, status: LOAD_STATUSES[i % LOAD_STATUSES.length], pickupAppt: `${loadDay}T09:00:00.000Z`,
      revDivision: i % 5 === 0 ? 'ASSETS' : null, revSubdivision: i % 5 === 0 ? 'BOX_TRUCK' : null,
    })
    if (i % 4 === 3 && i % 3 !== 0) rows.loads.push({ id: `l${i}b`, shipmentId: id, status: 'IN_TRANSIT', pickupAppt: null })
    rows.orders.push({ shipmentId: id, docsMissing: i % 2 === 0 ? ['POD'] : [] })
    if (i % 3 !== 1) {
      const priced = i % 8 !== 0
      rows.samples.push({
        id: `a${i}`, loadId: `l${i}`, shipmentId: id, date: day, excluded: !priced,
        revenueCents: 100_000 + i * 1000, costCents: 80_000 + i * 500, profitCents: 20_000 + i * 500,
        // A sample tagged differently from its shipment, and one with no tag of its own.
        revDivision: i % 6 === 2 ? 'CAR_SHIPPING' : i % 4 === 0 ? null : div,
        revSubdivision: i % 6 === 2 ? null : i % 4 === 0 ? null : sub,
        podReceivedAt: i % 5 === 0 ? '2026-10-30T00:00:00.000Z' : null,
      })
    }
    if (i % 4 === 1) rows.invoices.push({ id: `i${i}`, orderId: `o-${id}`, shipmentId: id, balanceCents: 5000 + i })
    if (i % 5 === 2) rows.bills.push({ id: `b${i}`, loadId: `l${i}`, shipmentId: id, balanceCents: 3000 + i })
  }
  return rows
}

function monthSource(rows: Rows): MonthSource {
  return {
    shipments: async (month) => rows.shipments.filter((s) => s.pickupMonth === month),
    loadsOf: async (ids) => rows.loads.filter((l) => ids.includes(l.shipmentId!)),
    deliveredOrders: async (ids) => rows.orders.filter((o) => ids.includes(o.shipmentId)),
    samples: async (month) => rows.samples.filter((s) => s.date.startsWith(month)),
    shipmentsByIds: async (ids) => rows.shipments.filter((s) => ids.includes(s.id)),
  }
}

async function rollupWindow(rows: Rows, from: string, to: string): Promise<RollupWindow> {
  const src = monthSource(rows)
  const months = await Promise.all(rollupMonthsFor(from, to).map(async (month) => ({
    id: `M:${month}`, schemaVersion: 1, computedAt: 'x', payload: await computeMonth(src, month),
  })))
  const payload: LivePayload = await computeLive({
    openInvoices: async () => rows.invoices,
    openBills: async () => rows.bills,
    shipmentsByIds: async (ids) => rows.shipments.filter((s) => ids.includes(s.id)),
    loadsByIds: async (ids) => rows.loads.filter((l) => ids.includes(l.id)),
  })
  return { months, live: { id: 'L:CURRENT', schemaVersion: 1, computedAt: 'x', payload } }
}

/** What `useBrokerageDashboard` hands the page for the same rows (hydrated loads included). */
function exactData(rows: Rows): DashboardData {
  const shipmentById = new Map(rows.shipments.map((s) => [s.id, s]))
  const loads = rows.loads.map((l) => {
    const s = shipmentById.get(l.shipmentId!)!
    return {
      ...l,
      revDivision: l.revDivision ?? s.revDivision ?? null,
      revSubdivision: l.revSubdivision ?? s.revSubdivision ?? null,
      pickupAppt: l.pickupAppt ?? s.pickupAppt ?? null,
      shipmentStatus: s.status ?? null,
      voidedAt: s.voidedAt ?? null,
    }
  })
  return {
    shipments: rows.shipments,
    orders: rows.orders.map((o) => ({ ...o, id: `o-${o.shipmentId}` })),
    loads,
    loadCarriers: [],
    samples: rows.samples,
    openInvoices: rows.invoices.map((i) => ({ ...i, customerId: null })),
    openBills: rows.bills,
    quotes: [],
    profiles: [],
    divisions: SEED_DIVISIONS,
    now: '2026-11-04T00:00:00.000Z',
  } as unknown as DashboardData
}

const base: DashboardFilters = {
  divisions: [], subdivisions: [], from: '2026-10-01', to: '2026-10-31',
  mode: null, status: null, customerId: null, carrierId: null, repId: null,
}

const WINDOWS: Array<[string, string, string]> = [
  ['one day', '2026-10-02', '2026-10-02'],
  ['full month', '2026-10-01', '2026-10-31'],
  ['month boundary', '2026-10-31', '2026-11-01'],
  ['two months', '2026-09-30', '2026-11-03'],
]
const DIVISION_FILTERS: Array<[string, Partial<DashboardFilters>]> = [
  ['no division filter', {}],
  ['division BROKERAGE', { divisions: ['BROKERAGE'] }],
  ['subdivision BOX_TRUCK', { subdivisions: ['BOX_TRUCK'] }],
  ['ASSETS + BOX_TRUCK', { divisions: ['ASSETS'], subdivisions: ['BOX_TRUCK'] }],
]

describe('rollup parity with the exact path', () => {
  const rows = fixture()
  const data = exactData(rows)

  for (const [windowName, from, to] of WINDOWS) {
    for (const [filterName, extra] of DIVISION_FILTERS) {
      it(`${windowName}, ${filterName}: strips and company totals are identical`, async () => {
        const filters = { ...base, from, to, ...extra }
        const { strips, totals } = stripsFromRollup(await rollupWindow(rows, from, to), filters, SEED_DIVISIONS)
        expect(totals).toEqual(buildCompanyTotals(data, filters))
        expect(strips).toEqual(rollupBusinessStrips(buildBusinessStrips(data, filters, SEED_DIVISIONS)))
      })
    }
  }

  it('swaps a reversed window instead of returning nothing', async () => {
    const window = await rollupWindow(rows, '2026-10-01', '2026-10-31')
    const forward = stripsFromRollup(window, { ...base }, SEED_DIVISIONS)
    const reversed = stripsFromRollup(window, { ...base, from: '2026-10-31', to: '2026-10-01' }, SEED_DIVISIONS)
    expect(reversed).toEqual(forward)
  })

  it('has real data to compare (the fixture is not vacuous)', async () => {
    const { strips, totals } = stripsFromRollup(await rollupWindow(rows, '2026-09-30', '2026-11-03'), { ...base, from: '2026-09-30', to: '2026-11-03' }, SEED_DIVISIONS)
    expect(totals.shipmentCount).toBeGreaterThan(10)
    expect(totals.arOpenCents).toBeGreaterThan(0)
    expect(strips.find((s) => s.code === 'ASSETS')!.subdivisions.find((s) => s.code === 'BOX_TRUCK')!.trackedCount).toBeGreaterThan(0)
    expect(strips.some((s) => (s.podNeededCount ?? 0) > 0)).toBe(true)
  })

  it('keeps "no data" null and a real zero 0', async () => {
    const empty: Rows = { shipments: [], loads: [], orders: [], samples: [], invoices: [], bills: [] }
    expect(stripsFromRollup(await rollupWindow(empty, base.from, base.to), base, SEED_DIVISIONS)).toEqual({
      strips: [],
      totals: { shipmentCount: null, revenueCents: null, profitCents: null, marginBps: null, arOpenCents: null, apOpenCents: null },
    })

    // Shipments but no loads: tracked is null (no data), not 0; PODs are a real 0.
    const lone: Rows = { ...empty, shipments: [{ id: 's', status: 'BOOKED', pickupAppt: '2026-10-05T12:00:00.000Z', pickupMonth: '2026-10', revDivision: 'BROKERAGE' }] }
    const { strips } = stripsFromRollup(await rollupWindow(lone, base.from, base.to), base, SEED_DIVISIONS)
    const brokerage = strips.find((s) => s.code === 'BROKERAGE')!
    expect(brokerage.trackedCount).toBeNull()
    expect(brokerage.podNeededCount).toBe(0)
    expect(brokerage.revenueCents).toBeNull()
  })

  it('resolves open AR by id even when the invoice order is outside the loaded rows (strip can only grow)', async () => {
    const invoices: InvoiceLite[] = [{ id: 'i', orderId: 'gone', shipmentId: 'far', balanceCents: 777 }]
    const far: Rows = { ...fixture(), invoices, shipments: [...fixture().shipments, { id: 'far', status: 'DELIVERED', pickupAppt: '2025-01-01T00:00:00.000Z', pickupMonth: '2025-01', revDivision: 'BROKERAGE' }] }
    const { strips, totals } = stripsFromRollup(await rollupWindow(far, base.from, base.to), base, SEED_DIVISIONS)
    expect(totals.arOpenCents).toBe(777)
    expect(strips.find((s) => s.code === 'BROKERAGE')!.arOpenCents).toBe(777)
  })
})

describe('month payload shape', () => {
  it('drops voided shipments and excluded samples, and counts a load on its own pickup day', async () => {
    const rows: Rows = {
      shipments: [
        { id: 'a', status: 'BOOKED', pickupAppt: '2026-10-31T12:00:00Z', pickupMonth: '2026-10', revDivision: 'BROKERAGE' },
        { id: 'v', status: 'BOOKED', pickupAppt: '2026-10-31T12:00:00Z', pickupMonth: '2026-10', revDivision: 'BROKERAGE', voidedAt: 'x' },
      ],
      loads: [
        { id: 'la', shipmentId: 'a', status: 'IN_TRANSIT', pickupAppt: '2026-11-01T01:00:00Z' },
        { id: 'lv', shipmentId: 'v', status: 'IN_TRANSIT', pickupAppt: '2026-10-31T01:00:00Z' },
      ],
      orders: [], invoices: [], bills: [],
      samples: [
        { id: 'x', loadId: 'la', shipmentId: 'a', date: '2026-10-31', excluded: true, revenueCents: 9 },
        { id: 'y', loadId: 'lv', shipmentId: 'v', date: '2026-10-31', revenueCents: 9 },
        { id: 'z', loadId: 'la', shipmentId: 'a', date: '2026-10-31', revenueCents: 100, costCents: 60, profitCents: 40 },
      ],
    }
    const payload: MonthPayload = await computeMonth(monthSource(rows), '2026-10')
    expect(payload.ship).toEqual({
      '2026-10-31': { 'BROKERAGE|': { st: { BOOKED: 1 }, ld: 0, trk: 0, pod: 0 } },
      '2026-11-01': { 'BROKERAGE|': { st: {}, ld: 1, trk: 1, pod: 0 } },
    })
    expect(payload.fin).toEqual({ '2026-10-31': { 'BROKERAGE|': { n: 1, rev: 100, cost: 60, prof: 40 } } })
  })

  it('recomputing from the same rows yields the same payload', async () => {
    const rows = fixture()
    const src = monthSource(rows)
    expect(await computeMonth(src, '2026-10')).toEqual(await computeMonth(src, '2026-10'))
  })
})

describe('dirtyKeysForRecord', () => {
  const ship = { id: 's', status: 'BOOKED', pickupAppt: '2026-10-31T12:00:00Z', pickupMonth: '2026-10', revDivision: 'BROKERAGE', updatedAt: 'a', notes: 'x' }

  it('a status change marks the month and its legacy row once', () => {
    expect(dirtyKeysForRecord('Shipment', ship, { ...ship, status: 'DELIVERED' })).toEqual(['M:2026-10', 'LG:2026-10'])
  })

  it('a pickupMonth change marks both months', () => {
    const moved = { ...ship, pickupAppt: '2026-11-02T12:00:00Z', pickupMonth: '2026-11' }
    expect(dirtyKeysForRecord('Shipment', ship, moved).sort()).toEqual(['LG:2026-10', 'LG:2026-11', 'M:2026-10', 'M:2026-11'])
  })

  it('a change to an irrelevant field marks nothing', () => {
    expect(dirtyKeysForRecord('Shipment', ship, { ...ship, updatedAt: 'b', notes: 'y' })).toEqual([])
  })

  it('a void marks the pickup month and the next, where a delivered sample may sit', () => {
    expect(dirtyKeysForRecord('Shipment', ship, { ...ship, voidedAt: 'v' }).sort()).toEqual(['LG:2026-10', 'M:2026-10', 'M:2026-11'])
    const december = { ...ship, pickupAppt: '2026-12-31T12:00:00Z', pickupMonth: '2026-12' }
    expect(dirtyKeysForRecord('Shipment', { ...december, voidedAt: 'v' }, december)).toContain('M:2027-01')
  })

  it('removing or inserting a row marks its month; a voided removal still counts', () => {
    expect(dirtyKeysForRecord('Shipment', { ...ship, voidedAt: 'v' }, undefined)).toEqual(['M:2026-10', 'LG:2026-10'])
    expect(dirtyKeysForRecord('LaneRateSample', undefined, { date: '2026-10-05', sampleMonth: '2026-10', revenueCents: 1 })).toEqual(['M:2026-10'])
  })

  it('a load re-tag marks its month and legacy row', () => {
    const load = { id: 'l', pickupAppt: '2026-10-05T00:00:00Z', revDivision: 'ASSETS' }
    expect(dirtyKeysForRecord('Load', load, { ...load, revDivision: 'BROKERAGE' })).toEqual(['M:2026-10', 'LG:2026-10'])
  })

  it('an invoice leaving the open set marks the live row; a non-open insert marks nothing', () => {
    const invoice = { id: 'i', arOpen: 'OPEN', balanceCents: 5 }
    expect(dirtyKeysForRecord('Invoice', invoice, { ...invoice, arOpen: null })).toEqual(['L:CURRENT'])
    expect(dirtyKeysForRecord('Invoice', undefined, { id: 'i', arOpen: null })).toEqual([])
    expect(dirtyKeysForRecord('CarrierBill', { apOpen: 'OPEN', balanceCents: 5 }, { apOpen: 'OPEN', balanceCents: 4 })).toEqual(['L:CURRENT'])
  })
})

describe('rollupMonthsFor', () => {
  it('pads one month either side across a year edge', () => {
    expect(rollupMonthsFor('2026-12-10', '2026-12-20')).toEqual(['2026-11', '2026-12', '2027-01'])
    expect(rollupMonthsFor('2026-01-31', '2026-01-01', 0)).toEqual(['2026-01'])
  })
})
