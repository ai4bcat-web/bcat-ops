// @vitest-environment jsdom
/**
 * The dashboard reads a window (pickup months ±1, voided filtered server-side) plus the open-work
 * set instead of every shipment ever. Every card, for every window, must come out exactly as it
 * does over the whole table: a missing pad month, a dropped join or a voided row leaking in
 * changes a number here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { LoadCarrierRecord, OrderRecord, ShipmentRecord, ShipmentStatus } from '@/types/tms'
import type { LoadBoardSummary } from '@/lib/apiClient'
import { applyFilters, hydrateLoads } from '@/lib/dashboardCharts'
import { BROKERAGE_CHARTS } from './brokerageCards'
import { CLASSIC_CHARTS } from './classicCharts'
import { clearDashboardCache, useBrokerageDashboard } from './useBrokerageDashboard'
import { defaultFilters } from './dashboardViews'
import { buildBusinessStrips, buildCompanyTotals, rollupBusinessStrips } from './businessStrips'
import { SEED_DIVISIONS } from '@/lib/ownership'
import type { DashboardData, DashboardFilters } from './types'

interface Table {
  shipments: ShipmentRecord[]
  orders: OrderRecord[]
  loads: LoadBoardSummary[]
  loadCarriers: LoadCarrierRecord[]
}

const table = vi.hoisted(() => ({ value: null as unknown as Table, views: [] as unknown[] }))

const monthOf = (s: ShipmentRecord) => (s.pickupAppt ?? '').slice(0, 7)
const joined = (shipments: ShipmentRecord[]) => {
  const ids = new Set(shipments.map((s) => s.id))
  const t = table.value
  return {
    shipments,
    orders: t.orders.filter((o) => ids.has(o.shipmentId)),
    loads: t.loads.filter((l) => l.shipmentId && ids.has(l.shipmentId)),
    loadCarriers: t.loadCarriers.filter((c) => ids.has(c.shipmentId)),
    loadFinancials: [],
  }
}

// What the backend returns for each view: the month index minus voided rows, and the open work.
vi.mock('@/lib/boardData', () => ({
  loadBoardBundle: vi.fn(async (view: { kind: string; months?: string[] }) => {
    table.views.push(view)
    const live = table.value.shipments.filter((s) => !s.voidedAt)
    if (view.kind === 'window') return joined(live.filter((s) => view.months!.includes(monthOf(s))))
    const open = live.filter((s) => {
      const order = table.value.orders.find((o) => o.shipmentId === s.id)
      return (s.status !== 'DELIVERED' && s.status !== 'CANCELED') || (s.status === 'DELIVERED' && order?.arStatus === 'DOCS_NEEDED')
    })
    return joined(open)
  }),
}))
vi.mock('@/lib/apiClient', () => ({
  listOpenInvoices: vi.fn(async () => []),
  listOpenBills: vi.fn(async () => []),
  listUserProfiles: vi.fn(async () => []),
  listOwnershipDivisions: vi.fn(async () => []),
}))
vi.mock('@/lib/reportsClient', () => ({
  loadSamples: vi.fn(async () => ({ rows: [], months: [], failedMonths: [] })),
  loadQuotes: vi.fn(async () => ({ rows: [], months: [], failedMonths: [] })),
  clearReportCache: vi.fn(),
}))

const STATUSES: ShipmentStatus[] = ['DELIVERED', 'IN_TRANSIT', 'DISPATCHED', 'CANCELED', 'BOOKED', 'DELIVERED']
const base = { createdBy: 't', updatedBy: 't', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' }

function buildTable(): Table {
  const shipments: ShipmentRecord[] = []
  const orders: OrderRecord[] = []
  const loads: LoadBoardSummary[] = []
  const loadCarriers: LoadCarrierRecord[] = []
  let n = 0
  const add = (pickupAppt: string | null, patch: Partial<ShipmentRecord> = {}) => {
    n += 1
    const id = `s${n}`
    const status = patch.status ?? STATUSES[n % STATUSES.length]
    shipments.push({
      id, number: `P${1000 + n}`, status, customerId: `cust-${n % 3}`, customerName: `Cust ${n % 3}`, mode: 'TRUCKLOAD',
      source: 'MANUAL', pickupAppt, revDivision: n % 2 ? 'BROKERAGE' : 'ASSETS', salesRepId: `rep-${n % 2}`,
      deliveredAt: status === 'DELIVERED' && pickupAppt ? pickupAppt : null, ...base, ...patch,
    } as ShipmentRecord)
    orders.push({
      id: `o${n}`, shipmentId: id, customerId: `cust-${n % 3}`, mode: 'TRUCKLOAD', revenueCents: 100_000 + n * 1_000,
      arStatus: status === 'DELIVERED' && n % 4 === 0 ? 'DOCS_NEEDED' : 'UNBILLED', ...base,
    } as OrderRecord)
    loads.push({ id: `l${n}`, shipmentId: id, status: 'DELIVERED', pickupAppt, activeLoadCarrierId: `lc${n}` } as unknown as LoadBoardSummary)
    loadCarriers.push({
      id: `lc${n}`, loadId: `l${n}`, shipmentId: id, carrierId: `car-${n % 4}`, carrierName: `Carrier ${n % 4}`,
      status: 'ACTIVE', costCents: 70_000 + n * 500, ...base,
    } as unknown as LoadCarrierRecord)
  }
  // Fourteen months of freight, 4 a month.
  for (let m = 0; m < 14; m += 1) {
    const month = new Date(Date.UTC(2025, 9 + m, 1))
    const ym = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`
    for (const day of ['02', '09', '17', '28']) add(`${ym}-${day}T14:00:00.000Z`)
  }
  // The UTC month edge, voided rows, a draft with no pickup at all, an old open load.
  add('2026-10-31T23:30:00.000Z')
  add('2026-11-01T00:30:00.000Z')
  add('2026-11-05T10:00:00.000Z', { voidedAt: '2026-11-06T00:00:00Z' })
  add('2026-09-05T10:00:00.000Z', { voidedAt: '2026-09-06T00:00:00Z' })
  add(null, { status: 'DRAFT' })
  add('2025-10-03T10:00:00.000Z', { status: 'IN_TRANSIT' })
  return { shipments, orders, loads, loadCarriers }
}

const WINDOWS: Array<[string, string, string]> = [
  ['this month', '2026-11-01', '2026-11-30'],
  ['a quarter', '2026-08-01', '2026-10-31'],
  ['the UTC month edge', '2026-10-31', '2026-11-01'],
  ['a year', '2025-11-01', '2026-11-30'],
]

const ALL = [...CLASSIC_CHARTS, ...BROKERAGE_CHARTS]

beforeEach(() => {
  table.value = buildTable()
  table.views = []
  clearDashboardCache()
})

describe('dashboard window equivalence', () => {
  it.each(WINDOWS)('%s: the filtered rows and every card equal the full-table computation', async (_label, from, to) => {
    const filters: DashboardFilters = { ...defaultFilters(new Date('2026-11-15T12:00:00Z')), from, to }
    const { result } = renderHook(() => useBrokerageDashboard(filters))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const windowed = result.current.data as DashboardData

    const t = table.value
    const full: DashboardData = {
      ...windowed,
      shipments: t.shipments,
      orders: t.orders,
      loadCarriers: t.loadCarriers,
      loads: hydrateLoads(t.loads, t.shipments, t.loadCarriers, []),
    }

    const ids = (d: DashboardData) => applyFilters(d, filters).shipments.map((s) => s.id).sort()
    expect(ids(windowed).length).toBeGreaterThan(0)
    expect(ids(windowed)).toEqual(ids(full))
    expect(applyFilters(windowed, filters).orders.map((o) => o.id).sort()).toEqual(applyFilters(full, filters).orders.map((o) => o.id).sort())
    expect(applyFilters(windowed, filters).loads.map((l) => l.id).sort()).toEqual(applyFilters(full, filters).loads.map((l) => l.id).sort())

    expect(buildCompanyTotals(windowed, filters)).toEqual(buildCompanyTotals(full, filters))
    expect(rollupBusinessStrips(buildBusinessStrips(windowed, filters, SEED_DIVISIONS)))
      .toEqual(rollupBusinessStrips(buildBusinessStrips(full, filters, SEED_DIVISIONS)))

    for (const chart of ALL) {
      for (const groupBy of ['DIVISION', null] as const) {
        expect(chart.compute(windowed, filters, groupBy), `${chart.title} (${groupBy})`).toEqual(chart.compute(full, filters, groupBy))
      }
    }
  })

  it('reads the window padded one month either side, plus the open-work set', async () => {
    const filters: DashboardFilters = { ...defaultFilters(new Date('2026-11-15T12:00:00Z')), from: '2026-11-01', to: '2026-11-30' }
    const { result } = renderHook(() => useBrokerageDashboard(filters))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(table.views).toContainEqual({ kind: 'window', months: ['2026-10', '2026-11', '2026-12'] })
    expect(table.views).toContainEqual({ kind: 'working' })
  })
})
