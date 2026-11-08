// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoutePointInput } from '../sections/milesEstimate'

const api = vi.hoisted(() => ({ getRouteMiles: vi.fn() }))
vi.mock('../sections/routeMilesApi', () => api)
import { useAutoMiles, withMiles } from './useAutoMiles'
import { emptyValues } from '../model'

const pt = (zip: string): RoutePointInput => ({ address: `City, ST ${zip}` })
const key = (...zips: string[]) => JSON.stringify(zips.map(pt))
const ship = () => emptyValues().ship

beforeEach(() => api.getRouteMiles.mockReset())

describe('useAutoMiles', () => {
  it('sends EVERY stop in order (three stops = two legs for the action) and writes the one value to both fields', async () => {
    api.getRouteMiles.mockResolvedValue({ miles: 420, source: 'google' })
    let state = ship()
    const { result } = renderHook(() => useAutoMiles(key('60431', '75001', '78701'), false, false, (fn) => { state = fn(state) }, 0))
    await waitFor(() => expect(result.current.source).toBe('google'))
    expect(api.getRouteMiles).toHaveBeenCalledWith([pt('60431'), pt('75001'), pt('78701')])
    expect(state).toMatchObject({ customerMiles: '420', truckMiles: '420' })
  })

  it('re-measures when the order, the stop count or a zip changes', async () => {
    api.getRouteMiles.mockResolvedValue({ miles: 1, source: 'estimate' })
    const { rerender } = renderHook(({ k }) => useAutoMiles(k, false, false, () => {}, 0), { initialProps: { k: key('1', '2', '3') } })
    await waitFor(() => expect(api.getRouteMiles).toHaveBeenCalledTimes(1))
    rerender({ k: key('1', '3', '2') }) // reorder
    await waitFor(() => expect(api.getRouteMiles).toHaveBeenCalledTimes(2))
    rerender({ k: key('1', '3', '2', '4') }) // add
    await waitFor(() => expect(api.getRouteMiles).toHaveBeenCalledTimes(3))
    rerender({ k: key('1', '2') }) // remove
    await waitFor(() => expect(api.getRouteMiles).toHaveBeenCalledTimes(4))
    rerender({ k: key('1', '9') }) // zip edit
    await waitFor(() => expect(api.getRouteMiles).toHaveBeenCalledTimes(5))
  })

  it('drops a stale response: the answer for the route that is no longer current never lands', async () => {
    let first: (v: unknown) => void = () => {}
    api.getRouteMiles.mockImplementationOnce(() => new Promise((r) => { first = r }))
    api.getRouteMiles.mockResolvedValueOnce({ miles: 200, source: 'google' })
    let state = ship()
    const { rerender } = renderHook(({ k }) => useAutoMiles(k, false, false, (fn) => { state = fn(state) }, 0), { initialProps: { k: key('1', '2') } })
    await waitFor(() => expect(api.getRouteMiles).toHaveBeenCalledTimes(1))
    rerender({ k: key('1', '3') })
    await waitFor(() => expect(state.customerMiles).toBe('200'))
    await act(async () => { first({ miles: 999, source: 'google' }) })
    expect(state.customerMiles).toBe('200')
  })

  it('does not measure while overridden or blocked, and falls back to a failure flag when the read fails', async () => {
    api.getRouteMiles.mockResolvedValue({ miles: 5, source: 'google' })
    renderHook(() => useAutoMiles(key('1', '2'), false, true, () => {}, 0))
    renderHook(() => useAutoMiles(key('1', '2'), true, false, () => {}, 0))
    await new Promise((r) => setTimeout(r, 50))
    expect(api.getRouteMiles).not.toHaveBeenCalled()
    api.getRouteMiles.mockResolvedValue({ miles: null, source: null, error: 'x' })
    const { result } = renderHook(() => useAutoMiles(key('1', '2'), false, false, () => {}, 0))
    await waitFor(() => expect(result.current.failed).toBe(true))
  })

  it('reports Override as the source while overridden', () => {
    const { result } = renderHook(() => useAutoMiles(key('1', '2'), false, true, () => {}, 0))
    expect(result.current.source).toBe('override')
    expect(withMiles(ship(), '7')).toMatchObject({ customerMiles: '7', truckMiles: '7' })
  })
})
