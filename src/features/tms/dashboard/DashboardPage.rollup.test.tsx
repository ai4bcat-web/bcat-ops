// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cloneElement, type ReactElement } from 'react'

// jsdom has no layout; give the real charts a fixed size instead of measuring 0x0.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 600, height: 300 }),
  }
})
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { LaneRateSampleRecord, OrderRecord, ShipmentRecord } from '@/types/tms'
import { computeLive, computeMonth, rollupMonthsFor, type LivePayload, type MonthPayload, type MonthSource } from '@/lib/dashboardRollup'
import { invalidateLists } from '@/lib/listCache'
import { loadBoardBundle } from '@/lib/boardData'
import { DashboardPage } from './DashboardPage'
import { defaultFilters } from './dashboardViews'
import { useDashboardKpis } from './useDashboardKpis'

/**
 * First paint from the rollup. One fixture feeds both the exact path (the mocked board/report
 * reads) and the rollup rows (AF1's `computeMonth` over the same records), so "the rollup paint
 * equals the exact figures" is observed through the page, not asserted on the arithmetic.
 */

const NOW = new Date()
const MONTH = NOW.toISOString().slice(0, 7)
const DAY = `${MONTH}-02`
const PICKUP = `${DAY}T12:00:00.000Z`
const stamp = { createdBy: 't', updatedBy: 't', createdAt: PICKUP, updatedAt: PICKUP }

const shipments: ShipmentRecord[] = [
  { id: 's1', number: 'P1', status: 'DELIVERED', customerId: 'c1', customerName: 'Acme', mode: 'TRUCKLOAD', source: 'MANUAL', pickupAppt: PICKUP, revDivision: 'BROKERAGE', ...stamp },
  { id: 's2', number: 'P2', status: 'IN_TRANSIT', customerId: 'c2', customerName: 'Globex', mode: 'TRUCKLOAD', source: 'MANUAL', pickupAppt: PICKUP, revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK', ...stamp },
  { id: 's3', number: 'P3', status: 'BOOKED', customerId: 'c1', customerName: 'Acme', mode: 'TRUCKLOAD', source: 'MANUAL', pickupAppt: PICKUP, revDivision: 'BROKERAGE', ...stamp },
]
const orders: OrderRecord[] = shipments.map((s) => ({ id: `o-${s.id}`, shipmentId: s.id, customerId: s.customerId, mode: 'TRUCKLOAD', ...stamp }))
const samples: LaneRateSampleRecord[] = [
  { id: 'a1', laneKey: 'A>B', date: DAY, loadId: 'l1', shipmentId: 's1', customerId: 'c1', customerName: 'Acme', revDivision: 'BROKERAGE', revenueCents: 150_000, costCents: 120_000, profitCents: 30_000, source: 'LOAD', sampledAt: PICKUP, version: 1 },
  { id: 'a2', laneKey: 'C>D', date: DAY, loadId: 'l2', shipmentId: 's2', customerId: 'c2', customerName: 'Globex', revDivision: 'ASSETS', revSubdivision: 'BOX_TRUCK', revenueCents: 90_000, costCents: 60_000, profitCents: 30_000, source: 'LOAD', sampledAt: PICKUP, version: 1 },
]
const loads = [
  { id: 'l1', shipmentId: 's1', status: 'DELIVERED' },
  { id: 'l2', shipmentId: 's2', status: 'IN_TRANSIT' },
]

const hoisted = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  batchCalls: [] as string[][],
  exactGate: Promise.resolve() as Promise<void>,
}))

vi.mock('@/lib/aliasBatch', () => ({
  batchGet: vi.fn(async (_q: unknown, ids: string[]) => {
    hoisted.batchCalls.push([...ids])
    return new Map(ids.filter((id) => hoisted.rows.has(id)).map((id) => [id, hoisted.rows.get(id)!]))
  }),
}))
vi.mock('@/lib/boardData', () => ({
  loadBoardBundle: vi.fn(async () => {
    await hoisted.exactGate
    return { shipments, orders, loads, loadCarriers: [], loadFinancials: [] }
  }),
}))
const division = (id: string, name: string, parentId: string | null, sortOrder: number) => ({
  id, code: id, name, brand: null, parentId, color: null, sortOrder, active: true, owners: null, flows: null, ...stamp, version: 1,
})
vi.mock('@/lib/apiClient', () => ({
  listOpenInvoices: vi.fn(async () => []),
  listOpenBills: vi.fn(async () => []),
  listUserProfiles: vi.fn(async () => []),
  listOwnershipDivisions: vi.fn(async () => [
    division('BROKERAGE', 'BCAT Logistics', null, 10),
    division('ASSETS', 'Ivan Cartage', null, 20),
    division('BOX_TRUCK', 'Box Trucks', 'ASSETS', 22),
  ]),
}))
vi.mock('@/lib/reportsClient', () => ({
  loadSamples: vi.fn(async () => ({ rows: samples, months: [MONTH], failedMonths: [] })),
  loadQuotes: vi.fn(async () => ({ rows: [], months: [MONTH], failedMonths: [] })),
  clearReportCache: vi.fn(),
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { userId: 'u1', email: 'ryne@bcatcorp.com', groups: ['ADMIN'] }, isAdmin: true, isOwner: true }),
}))

const lite = (s: ShipmentRecord) => ({ id: s.id, status: s.status, pickupAppt: s.pickupAppt, pickupMonth: s.pickupAppt?.slice(0, 7), revDivision: s.revDivision, revSubdivision: s.revSubdivision })
const source: MonthSource = {
  shipments: async (month) => shipments.filter((s) => s.pickupAppt?.startsWith(month)).map(lite),
  loadsOf: async () => loads,
  deliveredOrders: async () => orders.map((o) => ({ shipmentId: o.shipmentId, docsMissing: [] })),
  samples: async (month) => samples.filter((s) => s.date.startsWith(month)),
  shipmentsByIds: async (ids) => shipments.filter((s) => ids.includes(s.id)).map(lite),
}

/** Rows the backend would hold (AppSync hands back the Lambda's already-stringified AWSJSON string-encoded again) for the default window, `ageMs` old. */
async function seedRows(ageMs: number, schemaVersion = 1) {
  hoisted.rows.clear()
  const computedAt = new Date(Date.now() - ageMs).toISOString()
  const { from, to } = defaultFilters(NOW.toISOString())
  for (const month of rollupMonthsFor(from, to, 1)) {
    if (month > MONTH) continue
    const payload: MonthPayload = await computeMonth(source, month)
    hoisted.rows.set(`M:${month}`, { id: `M:${month}`, kind: 'M', periodKey: month, schemaVersion, payload: JSON.stringify(JSON.stringify(payload)), computedAt })
  }
  const live: LivePayload = await computeLive({ openInvoices: async () => [], openBills: async () => [], shipmentsByIds: source.shipmentsByIds, loadsByIds: async () => [] })
  hoisted.rows.set('L:CURRENT', { id: 'L:CURRENT', kind: 'L', periodKey: 'CURRENT', schemaVersion, payload: JSON.stringify(JSON.stringify(live)), computedAt })
}

class IdleObserver {
  static instances: IdleObserver[] = []
  constructor(readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) { IdleObserver.instances.push(this) }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  invalidateLists()
  sessionStorage.clear()
  localStorage.clear()
  hoisted.batchCalls.length = 0
  hoisted.exactGate = Promise.resolve()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { vi.unstubAllGlobals() })

const kpis = () => screen.getByTestId('dash-kpis')
const stripsText = () => document.querySelector('.tms-business-strips')?.textContent ?? ''

describe('the dashboard KPI strip from the rollup', () => {
  it('paints the rollup figures before the exact read lands, equal to the exact figures, and never flips', async () => {
    await seedRows(60_000)
    let release!: () => void
    hoisted.exactGate = new Promise<void>((resolve) => { release = resolve })
    render(<DashboardPage />)

    expect(kpis()).toHaveAttribute('data-state', 'loading')
    await waitFor(() => expect(kpis()).toHaveAttribute('data-state', 'ready'))
    expect(kpis()).toHaveAttribute('data-source', 'rollup')
    expect(screen.getByTestId('dash-asof')).toHaveTextContent(/^as of /)
    expect(hoisted.batchCalls).toHaveLength(1) // one aliased request for every month and the live row
    const rollupKpis = kpis().textContent
    const rollupStrips = stripsText()
    expect(rollupKpis).toContain('$2,400.00')
    expect(rollupKpis).toContain('3 shipments')
    expect(document.querySelectorAll('.tms-chart-title')).toHaveLength(0) // charts still waiting on the exact read

    await act(async () => { release(); await Promise.resolve() })
    await waitFor(() => expect(document.querySelectorAll('.tms-chart-title').length).toBeGreaterThan(0))
    expect(kpis().textContent).toBe(rollupKpis)
    expect(stripsText()).toBe(rollupStrips)
    expect(kpis()).toHaveAttribute('data-source', 'rollup')
    expect(kpis()).toHaveAttribute('data-kpi-flips', '0')

    // The same fixture through the exact path (no rollup rows) shows the same figures.
    hoisted.rows.clear()
    invalidateLists()
    sessionStorage.clear()
    document.body.innerHTML = ''
    render(<DashboardPage />)
    await waitFor(() => expect(kpis()).toHaveAttribute('data-state', 'ready'))
    expect(kpis()).toHaveAttribute('data-source', 'live')
    expect(screen.queryByTestId('dash-asof')).toBeNull()
    expect(kpis().textContent).toBe(rollupKpis)
    expect(stripsText()).toBe(rollupStrips)
  })

  it.each([
    ['a missing row', () => hoisted.rows.delete('L:CURRENT')],
    ['a row older than 30 minutes', () => { for (const row of hoisted.rows.values()) row.computedAt = new Date(Date.now() - 31 * 60_000).toISOString() }],
    ['an unknown schema version', () => { for (const row of hoisted.rows.values()) row.schemaVersion = 99 }],
  ])('falls back to the exact path on %s', async (_name, spoil) => {
    await seedRows(60_000)
    spoil()
    render(<DashboardPage />)
    await waitFor(() => expect(kpis()).toHaveAttribute('data-state', 'ready'))
    expect(kpis()).toHaveAttribute('data-source', 'live')
    expect(kpis().textContent).toContain('$2,400.00')
  })

  it('labels figures older than ten minutes stale', async () => {
    await seedRows(15 * 60_000)
    render(<DashboardPage />)
    await waitFor(() => expect(kpis()).toHaveAttribute('data-state', 'stale'))
    expect(kpis()).toHaveAttribute('data-source', 'rollup')
    expect(screen.getByTestId('dash-asof')).toHaveClass('tms-dash-asof-stale')
  })

  it('paints from the sessionStorage seed with no network, then revalidates', async () => {
    await seedRows(60_000)
    const first = render(<DashboardPage />)
    await waitFor(() => expect(kpis()).toHaveAttribute('data-source', 'rollup'))
    first.unmount()
    invalidateLists() // a reload: module caches empty, the tab's sessionStorage kept
    hoisted.batchCalls.length = 0
    hoisted.exactGate = new Promise<void>(() => {})
    render(<DashboardPage />)
    expect(kpis()).toHaveAttribute('data-state', 'ready') // first commit, before any promise settles
    expect(kpis()).toHaveAttribute('data-source', 'cache')
    await waitFor(() => expect(kpis()).toHaveAttribute('data-source', 'rollup'))
    expect(hoisted.batchCalls).toHaveLength(1)
  })

  it('reads the exact bundle only once the chart grid is near the viewport, then mounts a chart only when its card is', async () => {
    await seedRows(60_000)
    IdleObserver.instances.length = 0
    vi.mocked(loadBoardBundle).mockClear()
    vi.stubGlobal('IntersectionObserver', IdleObserver)
    render(<DashboardPage />)
    await waitFor(() => expect(kpis()).toHaveAttribute('data-state', 'ready'))
    expect(kpis()).toHaveAttribute('data-source', 'rollup')
    expect(loadBoardBundle).not.toHaveBeenCalled() // KPIs came from the rollup: nothing below the fold has been fetched
    expect(document.querySelectorAll('.tms-chart-title')).toHaveLength(0)

    await act(async () => { IdleObserver.instances[0]!.callback([{ isIntersecting: true }]) }) // the grid comes within reach
    await waitFor(() => expect(loadBoardBundle).toHaveBeenCalled())
    await waitFor(() => expect(document.querySelectorAll('section[aria-busy="true"]').length).toBeGreaterThan(20))
    expect(document.querySelectorAll('.tms-chart-title')).toHaveLength(0)

    await act(async () => { IdleObserver.instances[IdleObserver.instances.length - 1]!.callback([{ isIntersecting: true }]) })
    await waitFor(() => expect(document.querySelectorAll('.tms-chart-title')).toHaveLength(1))
  })
})

describe('useDashboardKpis', () => {
  const exact = { data: null, final: false, error: null }

  it('never reads the rollup for a facet filter and does not paint from it', async () => {
    await seedRows(60_000)
    const filters = { ...defaultFilters(NOW.toISOString()), status: 'DELIVERED' as const }
    const { result } = renderHook(() => useDashboardKpis(filters, exact, false))
    await act(async () => { await Promise.resolve() })
    expect(hoisted.batchCalls).toHaveLength(0)
    expect(result.current.state).toBe('loading')
  })

  it('stays on the exact path after Refresh even when the rollup is usable', async () => {
    await seedRows(60_000)
    const filters = defaultFilters(NOW.toISOString())
    const { result } = renderHook(() => useDashboardKpis(filters, exact, true))
    await act(async () => { await Promise.resolve() })
    expect(hoisted.batchCalls).toHaveLength(0)
    expect(result.current.source).toBeNull()
  })
})
