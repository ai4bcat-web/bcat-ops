import { describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  listShipmentsByNumber: vi.fn(),
  listLoadsByShipmentIds: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)

import { proConflictAllHistory } from './proConflictLookup'

describe('proConflictAllHistory', () => {
  it('blocks a Pro # held only by a voided load outside the store window', async () => {
    api.listShipmentsByNumber.mockResolvedValue([{ id: 'sh-old' }])
    api.listLoadsByShipmentIds.mockResolvedValue([{ id: 'l-old', aljexId: '14578' }])
    const r = await proConflictAllHistory([{ id: 'l-new', aljexId: '99' }], '14578')
    expect(r).toEqual({ kind: 'block', other: { id: 'l-old', aljexId: '14578' } })
    expect(api.listLoadsByShipmentIds).toHaveBeenCalledWith(['sh-old'])
  })

  it('is free when neither the window nor the number index has it', async () => {
    api.listShipmentsByNumber.mockResolvedValue([])
    expect((await proConflictAllHistory([], '5'))).toEqual({ kind: 'none' })
  })

  it('does not block the load being edited when the index returns it', async () => {
    api.listShipmentsByNumber.mockResolvedValue([{ id: 'sh' }])
    const self = { id: 'l1', aljexId: '7' }
    api.listLoadsByShipmentIds.mockResolvedValue([self])
    expect((await proConflictAllHistory([self], '7', self)).kind).toBe('none')
  })
})
