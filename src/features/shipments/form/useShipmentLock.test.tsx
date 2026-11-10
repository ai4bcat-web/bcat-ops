// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ lock: vi.fn(), unlock: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ lockShipment: api.lock, unlockShipment: api.unlock }))

import { useShipmentLock } from './useShipmentLock'

beforeEach(() => {
  api.lock.mockReset(); api.unlock.mockReset()
  api.lock.mockResolvedValue({ locked: true })
  api.unlock.mockResolvedValue({ released: true })
})

describe('useShipmentLock', () => {
  it('takes the lock when the form opens and lets go the moment the form is left (back, another page), not 10 minutes later', async () => {
    const { unmount } = renderHook(() => useShipmentLock('shp-1'))
    await waitFor(() => expect(api.lock).toHaveBeenCalledWith('shp-1'))
    await act(async () => { await Promise.resolve() })
    expect(api.unlock).not.toHaveBeenCalled()
    unmount()
    expect(api.unlock).toHaveBeenCalledExactlyOnceWith('shp-1')
  })

  it('leaving after release() does not unlock twice', async () => {
    const { result, unmount } = renderHook(() => useShipmentLock('shp-1'))
    await waitFor(() => expect(api.lock).toHaveBeenCalled())
    await act(async () => { await result.current.release() })
    unmount()
    expect(api.unlock).toHaveBeenCalledTimes(1)
  })

  it('release() lets go of it right away, once', async () => {
    const { result } = renderHook(() => useShipmentLock('shp-1'))
    await waitFor(() => expect(api.lock).toHaveBeenCalled())
    await act(async () => { await result.current.release(); await result.current.release() })
    expect(api.unlock).toHaveBeenCalledTimes(1)
    expect(api.unlock).toHaveBeenCalledWith('shp-1')
  })

  it('reports who holds it when somebody else does, and has nothing of its own to release', async () => {
    api.lock.mockResolvedValue({ locked: false, lockedBy: 'Dennis', expiresAt: '2026-11-10T20:00:00.000Z' })
    const { result } = renderHook(() => useShipmentLock('shp-1'))
    await waitFor(() => expect(result.current.heldBy).toEqual({ by: 'Dennis', until: '2026-11-10T20:00:00.000Z' }))
    await act(async () => { await result.current.release() })
    expect(api.unlock).not.toHaveBeenCalled()
  })
  it('take over: when somebody else holds it (a stale tab), takeOver() asks the server for it, and the banner state clears', async () => {
    api.lock.mockResolvedValueOnce({ locked: false, lockedBy: 'Ryne', expiresAt: '2026-11-10T20:00:00.000Z' })
    const { result } = renderHook(() => useShipmentLock('shp-1'))
    await waitFor(() => expect(result.current.heldBy).not.toBeNull())
    api.lock.mockResolvedValueOnce({ locked: true })
    let ok = false
    await act(async () => { ok = await result.current.takeOver() })
    expect(ok).toBe(true)
    expect(api.lock).toHaveBeenLastCalledWith('shp-1', true)
    expect(result.current.heldBy).toBeNull()
  })

  describe('a form left open', () => {
    it('keeps renewing the lock while the person is working, and lets go of it once nobody has touched the form for the idle limit; touching it again takes it back', async () => {
      vi.useFakeTimers()
      try {
        renderHook(() => useShipmentLock('shp-1'))
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        expect(api.lock).toHaveBeenCalledTimes(1)
        // 4 minutes in, activity 1 minute ago: renewed.
        await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60_000); window.dispatchEvent(new Event('keydown')); await vi.advanceTimersByTimeAsync(60_000) })
        expect(api.lock).toHaveBeenCalledTimes(2)
        expect(api.unlock).not.toHaveBeenCalled()
        // Untouched for longer than the idle limit by the next tick: released, not renewed.
        await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000) })
        expect(api.lock).toHaveBeenCalledTimes(2)
        expect(api.unlock).toHaveBeenCalledExactlyOnceWith('shp-1')
        // Back at the form: the lock is taken again.
        await act(async () => { window.dispatchEvent(new Event('pointerdown')); await vi.advanceTimersByTimeAsync(0) })
        expect(api.lock).toHaveBeenCalledTimes(3)
      } finally { vi.useRealTimers() }
    })
  })
})
