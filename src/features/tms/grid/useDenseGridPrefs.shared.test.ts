// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const saveMock = vi.fn()
const listMock = vi.fn()
vi.mock('@/lib/apiClient', () => ({
  listShipmentColumnTemplates: (...a: unknown[]) => listMock(...a),
  saveShipmentColumnTemplate: (...a: unknown[]) => saveMock(...a),
}))

import { useDenseGridPrefs, shouldTakeOrgLayout, withOrgLayout, type DensePrefs } from './useDenseGridPrefs'
import { __resetOrgGridDefaults } from './orgGridDefault'

const VALID = ['a', 'b', 'c', 'd']
const opts = (email: string) => ({ gridId: 'load-review-v3-all', email, defaultColumns: ['a', 'b'], validKeys: VALID, defaultSort: null })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  window.localStorage.clear()
  __resetOrgGridDefaults()
  saveMock.mockReset()
  listMock.mockReset()
  vi.useRealTimers()
})

describe('shared column layout (the owner sets it for everyone)', () => {
  it('owner column change saves the grid default; a non-owner change stays personal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    listMock.mockResolvedValue([])
    saveMock.mockResolvedValue({ updatedAt: '2026-11-16T10:00:00.000Z' })
    const owner = renderHook(() => useDenseGridPrefs(opts('ryne@bcatcorp.com')))
    await flush()
    act(() => owner.result.current.setColumns(['c', 'a']))
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock.mock.calls[0][0]).toMatchObject({ id: 'grid-default:load-review-v3-all', columns: ['c', 'a'], shared: true })
    expect(owner.result.current.layoutSharedWithAll).toBe(true)

    saveMock.mockClear()
    const other = renderHook(() => useDenseGridPrefs(opts('jenny@bcatcorp.com')))
    act(() => other.result.current.setColumns(['d']))
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(saveMock).not.toHaveBeenCalled()
    expect(other.result.current.layoutSharedWithAll).toBe(false)
  })

  it('a non-owner takes a newer owner layout once, then can customise again', async () => {
    listMock.mockResolvedValue([{ id: 'grid-default:load-review-v3-all', columns: ['d', 'b'], widths: { d: 200 }, pinned: ['d'], updatedAt: '2026-11-16T10:00:00.000Z' }])
    window.localStorage.setItem('tms:grid:load-review-v3-all:jenny@bcatcorp.com:v1', JSON.stringify({ columns: ['a', 'c'], orgSeenAt: '2026-11-01T00:00:00.000Z' }))
    const h = renderHook(() => useDenseGridPrefs(opts('jenny@bcatcorp.com')))
    await flush()
    expect(h.result.current.columns).toEqual(['d', 'b'])
    expect(h.result.current.pinned).toEqual(['d'])
    act(() => h.result.current.setColumns(['a']))
    await flush()
    expect(h.result.current.columns).toEqual(['a'])
  })

  it('the board opts out', async () => {
    listMock.mockResolvedValue([{ id: 'grid-default:shipments-x', columns: ['d'], updatedAt: '2026-11-16T10:00:00.000Z' }])
    const h = renderHook(() => useDenseGridPrefs({ ...opts('ryne@bcatcorp.com'), gridId: 'shipments-x', shareLayout: false }))
    await flush()
    act(() => h.result.current.setColumns(['c']))
    expect(h.result.current.columns).toEqual(['c'])
    expect(h.result.current.layoutSharedWithAll).toBe(false)
  })

  it('shouldTakeOrgLayout / withOrgLayout', () => {
    const org = { columns: ['b', 'zzz'], widths: { b: 90, zzz: 50 }, pinned: ['b'], updatedAt: 't2' }
    expect(shouldTakeOrgLayout({ orgSeenAt: 't1' }, org, false)).toBe(true)
    expect(shouldTakeOrgLayout({ orgSeenAt: 't2' }, org, false)).toBe(false)
    expect(shouldTakeOrgLayout({ orgSeenAt: 't1' }, org, true)).toBe(false)
    expect(shouldTakeOrgLayout({ orgSeenAt: null }, org, true)).toBe(true)
    const p = withOrgLayout({ columns: ['a'], widths: {}, pinned: [], density: 'compact', sort: null, groupBy: null, kpiOpen: false } as DensePrefs, org, VALID)
    expect(p.columns).toEqual(['b'])
    expect(p.widths).toEqual({ b: 90 })
    expect(p.orgSeenAt).toBe('t2')
  })
})
