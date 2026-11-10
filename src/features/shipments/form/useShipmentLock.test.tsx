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
})
