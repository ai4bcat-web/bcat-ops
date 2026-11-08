// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, render, screen, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { computeLegacyMonth, reduceLegacy, type LegacyMonthPayload, type LegacyLoadLite } from '@/lib/dashboardRollupLegacy'
import { monthsCovering } from '@/lib/shipmentWindows'
import type { ShipmentLite } from '@/lib/dashboardRollup'
import type { RawRollupRow } from '@/lib/dashboardRollupClient'
import type { Driver, Load } from '@/types'
import { legacyKpisFromLoads, legacyWindow, type DateRangeKey } from './legacyKpiMath'

const NOW = '2026-11-04T18:00:00Z'

const readRollupRows = vi.hoisted(() => vi.fn())
vi.mock('@/lib/dashboardRollupClient', async (orig) => ({
  ...(await orig() as object),
  readRollupRows,
}))
vi.mock('@/lib/apiClient', () => ({}))
vi.mock('@/hooks/useFactoringItems', () => ({ useFactoringItems: () => ({ items: [], loading: false }) }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPageAccess: () => true }) }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('./VendorApCard', () => ({ VendorApCard: () => null }))
vi.mock('./YearProfitWidget', () => { return { YearProfitWidget: () => <div data-testid="widget-YearProfitWidget" /> } })
vi.mock('./DriverLeaderboardWidget', () => { return { DriverLeaderboardWidget: () => <div data-testid="widget-DriverLeaderboardWidget" /> } })
vi.mock('./DieselPriceWidget', () => { return { DieselPriceWidget: () => <div data-testid="widget-DieselPriceWidget" /> } })
vi.mock('./ComplianceAlertsWidget', () => { return { ComplianceAlertsWidget: () => <div data-testid="widget-ComplianceAlertsWidget" /> } })
vi.mock('./RepairInvoicesWidget', () => { return { RepairInvoicesWidget: () => <div data-testid="widget-RepairInvoicesWidget" /> } })

const { useAppStore } = await import('@/store/useAppStore')
const { useLegacyDashboardKpis } = await import('./useLegacyDashboardKpis')
const { DashboardPage } = await import('./DashboardPage')

const drivers = [
  { id: 'ivan', fleetGroup: 'COMPANY', driverType: 'COMPANY' },
  { id: 'oo', fleetGroup: 'AMAZON', driverType: 'OWNER_OPERATOR' },
  { id: 'box', fleetGroup: 'BOX_TRUCK', driverType: 'COMPANY' },
  { id: 'brk', type: 'broker' },
] as unknown as Driver[]

// Midday UTC: the same calendar day in Chicago and in the browser's zone, so the store
// arithmetic (local days) and the rollup (Chicago days) are comparable in any CI zone.
const PICKUPS = [
  '2026-09-28T17:00:00Z', '2026-10-05T17:00:00Z', '2026-10-27T17:00:00Z', '2026-10-30T17:00:00Z',
  '2026-11-02T17:00:00Z', '2026-11-03T17:00:00Z', '2026-11-04T17:00:00Z', '2026-11-12T17:00:00Z',
]
const PAIRS: Array<[string | null, string | null]> = [['ivan', 'ivan'], ['oo', null], [null, 'box'], ['brk', 'ivan'], [null, 'brk'], [null, null]]

function fixture() {
  const shipments: ShipmentLite[] = []
  const loads: Load[] = []
  for (let i = 0; i < 48; i++) {
    const pickup = PICKUPS[i % PICKUPS.length]!
    const [p, d] = PAIRS[i % PAIRS.length]!
    const voided = i % 13 === 0
    shipments.push({ id: `s${i}`, pickupAppt: pickup, pickupMonth: pickup.slice(0, 7), voidedAt: voided ? 'v' : null })
    loads.push({
      id: `l${i}`, shipmentId: `s${i}`, pickupAppt: pickup, pickupDriverId: p ?? undefined, deliveryDriverId: d ?? undefined,
      rate: i % 4 === 0 ? undefined : 100_000 + i, voidedAt: voided ? 'v' : undefined,
    } as unknown as Load)
  }
  return { shipments, loads }
}

async function legacyRows(rows: ReturnType<typeof fixture>, months: string[], computedAt: string): Promise<RawRollupRow[]> {
  const src = {
    shipments: async (m: string) => rows.shipments.filter((s) => s.pickupMonth === m),
    loadsOf: async (ids: string[]) => rows.loads.filter((l) => ids.includes(l.shipmentId!)) as unknown as LegacyLoadLite[],
  }
  return Promise.all(months.map(async (m) => ({
    id: `LG:${m}`, kind: 'LG', periodKey: m, schemaVersion: 1, computedAt,
    payload: await computeLegacyMonth(src, m) as LegacyMonthPayload,
  })))
}

const ranges: DateRangeKey[] = ['today', 'this-week', 'this-month', 'this-quarter']

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  sessionStorage.clear()
  readRollupRows.mockReset()
})
afterEach(() => { vi.useRealTimers() })

function seedStore(over: Record<string, unknown> = {}) {
  useAppStore.setState({
    drivers, loads: [], loadedMonths: new Set<string>(), isLoading: false,
    ensureLoadRange: vi.fn(async () => undefined), loadReferenceData: vi.fn(async () => undefined),
    ...over,
  } as never)
}

describe('rollup reduction equals the store arithmetic', () => {
  it.each(ranges)('%s: same figures, previous-period deltas, broker either-driver rule, unrated, revenueConnected', async (key) => {
    const rows = fixture()
    const win = legacyWindow(key, new Date(NOW))
    const months = monthsCovering(win.prevFrom, win.to, 0)
    const payloads = (await legacyRows(rows, months, NOW)).map((r) => r.payload as LegacyMonthPayload)
    const rolled = reduceLegacy(payloads, win, drivers)
    const exact = legacyKpisFromLoads(rows.loads, drivers, win)
    expect(rolled).toEqual(exact)
    expect(exact.totalLoads).toBeGreaterThan(0)
    expect(exact.brokerLoads).toBeGreaterThan(0)
  })
})

describe('useLegacyDashboardKpis', () => {
  it('paints nothing until the rows land, then the rollup figures without touching the load window', async () => {
    const rows = fixture()
    const win = legacyWindow('this-month', new Date(NOW))
    const months = monthsCovering(win.prevFrom, win.to, 0)
    const data = await legacyRows(rows, months, '2026-11-04T17:55:00Z')
    let resolve!: (r: RawRollupRow[]) => void
    readRollupRows.mockReturnValue({ fresh: new Promise<RawRollupRow[]>((r) => { resolve = r }) })
    seedStore()
    const ensure = useAppStore.getState().ensureLoadRange as ReturnType<typeof vi.fn>
    const { result } = renderHook(() => useLegacyDashboardKpis('this-month'))
    expect(result.current).toMatchObject({ kpis: null, state: 'loading' })
    await act(async () => { resolve(data) })
    expect(result.current.state).toBe('ready')
    expect(result.current.source).toBe('rollup')
    expect(result.current.asOf).toBe('2026-11-04T17:55:00Z')
    expect(result.current.kpis).toEqual(legacyKpisFromLoads(rows.loads, drivers, win))
    expect(ensure).not.toHaveBeenCalled()
  })

  it('labels a 15-minute-old hot row stale, and a 40-minute-old one is not trusted: exact path, window ensured', async () => {
    const rows = fixture()
    const win = legacyWindow('this-month', new Date(NOW))
    const months = monthsCovering(win.prevFrom, win.to, 0)
    readRollupRows.mockReturnValue({ fresh: legacyRows(rows, months, '2026-11-04T17:45:00Z') })
    seedStore()
    const a = renderHook(() => useLegacyDashboardKpis('this-month'))
    await waitFor(() => expect(a.result.current.state).toBe('stale'))
    a.unmount()

    readRollupRows.mockReturnValue({ fresh: legacyRows(rows, months, '2026-11-04T17:20:00Z') })
    seedStore({ loads: rows.loads })
    const ensure = useAppStore.getState().ensureLoadRange as ReturnType<typeof vi.fn>
    const b = renderHook(() => useLegacyDashboardKpis('this-month'))
    await waitFor(() => expect(ensure).toHaveBeenCalledWith(win.prevFrom, win.to))
    // The window is not in yet: still no figures, never zeros.
    expect(b.result.current).toMatchObject({ kpis: null, state: 'loading' })
    act(() => { useAppStore.setState({ loadedMonths: new Set(monthsCovering(win.prevFrom, win.to, 1)) }) })
    expect(b.result.current.source).toBe('live')
    expect(b.result.current.state).toBe('ready')
    expect(b.result.current.kpis).toEqual(legacyKpisFromLoads(rows.loads, drivers, win))
  })

  it('a missing or other-schema month falls back; months after the current one need no row', async () => {
    const rows = fixture()
    const win = legacyWindow('this-quarter', new Date(NOW))
    const months = monthsCovering(win.prevFrom, win.to, 0)
    expect(months.at(-1)).toBe('2026-12')
    const data = (await legacyRows(rows, months.filter((m) => m <= '2026-11'), NOW))
    readRollupRows.mockReturnValue({ fresh: Promise.resolve(data) })
    seedStore()
    const ok = renderHook(() => useLegacyDashboardKpis('this-quarter'))
    await waitFor(() => expect(ok.result.current.source).toBe('rollup'))
    ok.unmount()

    readRollupRows.mockReturnValue({ fresh: Promise.resolve(data.map((r) => (r.id === 'LG:2026-10' ? { ...r, schemaVersion: 99 } : r))) })
    seedStore()
    const ensure = useAppStore.getState().ensureLoadRange as ReturnType<typeof vi.fn>
    renderHook(() => useLegacyDashboardKpis('this-quarter'))
    await waitFor(() => expect(ensure).toHaveBeenCalled())
  })

  it('a cached paint that the fresh read confirms never flips', async () => {
    const rows = fixture()
    const win = legacyWindow('this-month', new Date(NOW))
    const months = monthsCovering(win.prevFrom, win.to, 0)
    const data = await legacyRows(rows, months, '2026-11-04T17:58:00Z')
    readRollupRows.mockReturnValue({ value: data, fresh: Promise.resolve(data) })
    seedStore()
    const { result } = renderHook(() => useLegacyDashboardKpis('this-month'))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    expect(result.current.flips).toBe(0)
  })

  it('reload seed paints before the read returns, and is dropped when the rollup is unusable', async () => {
    const rows = fixture()
    const win = legacyWindow('this-month', new Date(NOW))
    const months = monthsCovering(win.prevFrom, win.to, 0)
    const data = await legacyRows(rows, months, '2026-11-04T17:58:00Z')
    readRollupRows.mockReturnValue({ fresh: Promise.resolve(data) })
    seedStore()
    const first = renderHook(() => useLegacyDashboardKpis('this-month'))
    await waitFor(() => expect(first.result.current.source).toBe('rollup'))
    first.unmount()

    readRollupRows.mockReturnValue({ fresh: new Promise(() => undefined) })
    const second = renderHook(() => useLegacyDashboardKpis('this-month'))
    expect(second.result.current.source).toBe('cache')
    expect(second.result.current.kpis).toEqual(legacyKpisFromLoads(rows.loads, drivers, win))
  })
})

describe('DashboardPage', () => {
  it('shows skeletons and no 0-load figure until the KPIs are final; widgets mount only after', async () => {
    const rows = fixture()
    const win = legacyWindow('this-month', new Date(NOW))
    const months = monthsCovering(win.prevFrom, win.to, 0)
    const data = await legacyRows(rows, months, NOW)
    let resolve!: (r: RawRollupRow[]) => void
    readRollupRows.mockReturnValue({ fresh: new Promise<RawRollupRow[]>((r) => { resolve = r }) })
    seedStore()
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    const kpis = screen.getByTestId('legacy-kpis')
    expect(kpis).toHaveAttribute('data-state', 'loading')
    expect(kpis.querySelectorAll('[aria-busy="true"]')).toHaveLength(3)
    expect(screen.getByTestId('legacy-kpis-all')).toHaveAttribute('data-state', 'loading')
    expect(screen.queryByText('Total Loads')).toBeInTheDocument() // skeleton label only
    expect(screen.queryByTestId('widget-YearProfitWidget')).toBeNull()

    await act(async () => { resolve(data) })
    expect(screen.getByTestId('legacy-kpis')).toHaveAttribute('data-state', 'ready')
    expect(screen.getByTestId('legacy-kpis')).toHaveAttribute('data-source', 'rollup')
    expect(screen.getByTestId('legacy-kpis').querySelectorAll('[aria-busy="true"]')).toHaveLength(0)
    expect(screen.getByTestId('legacy-kpis-all')).toHaveAttribute('data-state', 'ready')
    expect(screen.getByTestId('widget-YearProfitWidget')).toBeInTheDocument()
    expect(screen.getByTestId('legacy-asof')).toHaveTextContent(/as of/)
  })
})
