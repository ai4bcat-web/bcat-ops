// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Load } from '@/types'

const api = vi.hoisted(() => ({
  listShipmentIdsByMonths: vi.fn(),
  listLoadsByShipmentIds: vi.fn(),
  listOpenLoads: vi.fn(),
  listDrivers: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)

import { useAppStore, mergeLoads } from './useAppStore'

const load = (id: string, updatedAt = '2026-11-01T00:00:00Z'): Load => ({ id, updatedAt } as unknown as Load)
const ids = () => useAppStore.getState().loads.map((l) => l.id).sort()

beforeEach(() => {
  vi.resetAllMocks()
  api.listShipmentIdsByMonths.mockImplementation(async (months: string[]) => months.map((m) => `s-${m}`))
  api.listLoadsByShipmentIds.mockImplementation(async (sids: string[]) => sids.map((s) => load(`l-${s}`)))
  api.listOpenLoads.mockResolvedValue([])
  api.listDrivers.mockResolvedValue([])
  useAppStore.setState({ loads: [], loadedMonths: new Set() })
})

describe('ensureLoadMonths', () => {
  it('fetches a month once, merges later months, and shares concurrent requests', async () => {
    const { ensureLoadMonths } = useAppStore.getState()
    await Promise.all([ensureLoadMonths(['2026-11']), ensureLoadMonths(['2026-11'])])
    expect(api.listShipmentIdsByMonths).toHaveBeenCalledTimes(1)
    await ensureLoadMonths(['2026-11'])
    expect(api.listShipmentIdsByMonths).toHaveBeenCalledTimes(1)

    await ensureLoadMonths(['2026-11', '2026-10'])
    expect(api.listShipmentIdsByMonths).toHaveBeenLastCalledWith(['2026-10'])
    expect(ids()).toEqual(['l-s-2026-10', 'l-s-2026-11'])
    expect([...useAppStore.getState().loadedMonths].sort()).toEqual(['2026-10', '2026-11'])
  })

  it('ensureLoadRange widens by one month each side', async () => {
    await useAppStore.getState().ensureLoadRange('2026-01-15', '2026-02-03')
    expect(api.listShipmentIdsByMonths).toHaveBeenCalledWith(['2025-12', '2026-01', '2026-02', '2026-03'])
  })

  it('does not mark a failed month loaded, so the next call retries it', async () => {
    api.listShipmentIdsByMonths.mockRejectedValueOnce(new Error('boom'))
    await expect(useAppStore.getState().ensureLoadMonths(['2026-11'])).rejects.toThrow('boom')
    expect(useAppStore.getState().loadedMonths.has('2026-11')).toBe(false)
    await useAppStore.getState().ensureLoadMonths(['2026-11'])
    expect(ids()).toEqual(['l-s-2026-11'])
  })
})

describe('refreshCalendarData', () => {
  it('re-reads only the loaded months inside the visible range, plus the open set', async () => {
    await useAppStore.getState().ensureLoadMonths(['2026-08', '2026-09', '2026-10', '2026-11'])
    api.listShipmentIdsByMonths.mockClear()
    await useAppStore.getState().refreshCalendarData({ from: '2026-11-01', to: '2026-11-30' })
    // 2026-10..2026-12 is the padded view; 2026-12 was never loaded and is not fetched.
    expect(api.listShipmentIdsByMonths).toHaveBeenCalledTimes(1)
    expect(api.listShipmentIdsByMonths.mock.calls[0][0].sort()).toEqual(['2026-10', '2026-11'])
    expect(api.listOpenLoads).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().loadedMonths.has('2026-12')).toBe(false)
  })
})

describe('mergeLoads', () => {
  it('never rolls a load back to an older server copy, and adds unseen ones', () => {
    const held = [load('a', '2026-11-02T00:00:00Z'), load('b', '2026-11-01T00:00:00Z')]
    const merged = mergeLoads(held, [load('a', '2026-11-01T00:00:00Z'), load('b', '2026-11-03T00:00:00Z'), load('c')])
    expect(merged.map((l) => [l.id, l.updatedAt])).toEqual([
      ['a', '2026-11-02T00:00:00Z'],
      ['b', '2026-11-03T00:00:00Z'],
      ['c', '2026-11-01T00:00:00Z'],
    ])
  })
})
