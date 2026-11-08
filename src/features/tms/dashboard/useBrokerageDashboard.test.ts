// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const bundle = (ids: string[]) => ({ shipments: ids.map((id) => ({ id })), orders: [], loads: [], loadCarriers: [], loadFinancials: [] })
const sampleRows = [{ shipmentId: 'w1' }, { shipmentId: 'gone' }, { shipmentId: 'live-elsewhere' }, { shipmentId: null }]
const views: Array<{ kind: string }> = []
let releaseReferents!: () => void
vi.mock('@/lib/boardData', () => ({
  loadBoardBundle: vi.fn(async (view: { kind: string }) => {
    views.push(view)
    if (view.kind === 'window') return bundle(['w1'])
    await new Promise<void>((r) => { releaseReferents = r })
    return bundle(['inv1'])
  }),
  getShipmentsByIds: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { id, voidedAt: id === 'gone' ? '2026-11-02T00:00:00Z' : null }]))),
}))
vi.mock('@/lib/apiClient', () => ({
  listOpenInvoices: async () => [{ id: 'i', shipmentId: 'inv1', balanceCents: 1 }],
  listOpenBills: async () => [], listUserProfiles: async () => [], listOwnershipDivisions: async () => [],
}))
vi.mock('@/lib/reportsClient', () => ({
  loadSamples: async () => ({ rows: sampleRows, failedMonths: [] }),
  loadQuotes: async () => ({ rows: [], failedMonths: [] }),
  clearReportCache: vi.fn(),
}))
vi.mock('@/lib/dashboardCharts', () => ({ hydrateLoads: () => [] }))

const { useBrokerageDashboard, clearDashboardCache } = await import('./useBrokerageDashboard')

describe('useBrokerageDashboard', () => {
  beforeEach(() => { clearDashboardCache(); views.length = 0 })

  it('draws the window first, then adds the rows the open invoices point to; only the last is final', async () => {
    const { result } = renderHook(() => useBrokerageDashboard({ from: '2026-11-01', to: '2026-11-30' } as never))
    await waitFor(() => expect(result.current.data?.shipments.map((s) => s.id)).toEqual(['w1']))
    expect(result.current.loading).toBe(false)
    expect(result.current.final).toBe(false)
    await waitFor(() => expect(releaseReferents).toBeTypeOf('function'))
    releaseReferents()
    await waitFor(() => expect(result.current.final).toBe(true))
    expect(result.current.data?.shipments.map((s) => s.id).sort()).toEqual(['inv1', 'w1'])
    expect(views.map((v) => v.kind)).toEqual(['window', 'ids'])
  })

  it('counts no sample of a voided shipment, though the window read never loaded that shipment', async () => {
    const { result } = renderHook(() => useBrokerageDashboard({ from: '2026-11-01', to: '2026-11-30' } as never))
    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(result.current.data?.samples.map((s) => s.shipmentId)).toEqual(['w1', 'live-elsewhere', null])
  })
})
