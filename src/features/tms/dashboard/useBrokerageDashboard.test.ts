// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

let releaseFinal!: () => void
const emptyBundle = (ids: string[]) => ({
  shipments: ids.map((id) => ({ id })), orders: [], loads: [], loadCarriers: [], loadFinancials: [],
})
vi.mock('@/lib/boardData', () => ({
  loadBoardBundle: vi.fn(async (view: { kind: string }, opts?: { onPartial?: (b: unknown) => void }) => {
    if (view.kind === 'window') return emptyBundle(['w1'])
    opts?.onPartial?.(emptyBundle(['open1']))
    await new Promise<void>((r) => { releaseFinal = r })
    return emptyBundle(['open1', 'delivered1'])
  }),
}))
vi.mock('@/lib/apiClient', () => ({
  listOpenInvoices: async () => [], listOpenBills: async () => [], listUserProfiles: async () => [], listOwnershipDivisions: async () => [],
}))
vi.mock('@/lib/reportsClient', () => ({
  loadSamples: async () => ({ rows: [], failedMonths: [] }),
  loadQuotes: async () => ({ rows: [], failedMonths: [] }),
  clearReportCache: vi.fn(),
}))
vi.mock('@/lib/dashboardCharts', () => ({ hydrateLoads: () => [] }))

const { useBrokerageDashboard, clearDashboardCache } = await import('./useBrokerageDashboard')

describe('useBrokerageDashboard', () => {
  beforeEach(() => clearDashboardCache())

  it('draws from the first working-set step and swaps in the delivered backlog when it lands', async () => {
    const { result } = renderHook(() => useBrokerageDashboard({ from: '2026-11-01', to: '2026-11-30' } as never))
    await waitFor(() => expect(result.current.data?.shipments.map((s) => s.id).sort()).toEqual(['open1', 'w1']))
    expect(result.current.loading).toBe(false)
    await waitFor(() => expect(releaseFinal).toBeTypeOf('function'))
    act(() => releaseFinal())
    await waitFor(() => expect(result.current.data?.shipments.map((s) => s.id).sort()).toEqual(['delivered1', 'open1', 'w1']))
  })
})
