// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const getLoads = vi.fn()
const listShipmentsByNumber = vi.fn()
const listLoadsByShipmentIds = vi.fn()
vi.mock('@/lib/apiClient', () => ({
  getLoads: (...a: unknown[]) => getLoads(...a),
  listShipmentsByNumber: (...a: unknown[]) => listShipmentsByNumber(...a),
  listLoadsByShipmentIds: (...a: unknown[]) => listLoadsByShipmentIds(...a),
}))

const { useResolveLoads } = await import('./useResolveLoads')
const { useAppStore } = await import('@/store/useAppStore')

const voided = { id: 'L-void', aljexId: '123456', voidedAt: '2026-11-01T00:00:00Z', updatedAt: 'x' }

describe('useResolveLoads (voided loads are not in the window read)', () => {
  beforeEach(() => {
    getLoads.mockReset(); listShipmentsByNumber.mockReset(); listLoadsByShipmentIds.mockReset()
    useAppStore.setState({ loads: [] })
  })

  it('fetches a voided load by id when it is not held, once', async () => {
    getLoads.mockResolvedValue([voided])
    const { rerender } = renderHook(() => useResolveLoads(['L-void']))
    await waitFor(() => expect(useAppStore.getState().loads.map((l) => l.id)).toEqual(['L-void']))
    rerender()
    expect(getLoads).toHaveBeenCalledTimes(1)
    expect(getLoads).toHaveBeenCalledWith(['L-void'])
  })

  it('resolves a voided load by PRO through the shipment number index (voided included)', async () => {
    listShipmentsByNumber.mockResolvedValue([{ id: 'S-void' }])
    listLoadsByShipmentIds.mockResolvedValue([voided])
    renderHook(() => useResolveLoads([], ['123456']))
    await waitFor(() => expect(useAppStore.getState().loads.map((l) => l.id)).toEqual(['L-void']))
    expect(listLoadsByShipmentIds).toHaveBeenCalledWith(['S-void'])
  })

  it('asks for nothing that is already held', async () => {
    useAppStore.setState({ loads: [{ id: 'L1', aljexId: '777' } as never] })
    renderHook(() => useResolveLoads(['L1'], ['777']))
    await new Promise((r) => setTimeout(r, 20))
    expect(getLoads).not.toHaveBeenCalled()
    expect(listShipmentsByNumber).not.toHaveBeenCalled()
  })
})
