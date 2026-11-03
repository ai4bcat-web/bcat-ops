// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({ listDrivers: vi.fn(), listEquipment: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)

import { useAppStore } from './useAppStore'

const driver = { id: 'drv-1', name: 'Ada Driver' }

beforeEach(() => {
  api.listDrivers.mockReset()
  api.listEquipment.mockReset()
  api.listEquipment.mockResolvedValue([])
  useAppStore.setState({ drivers: [] })
})

describe('loadReferenceData', () => {
  it('fills the roster for a /tms page that never ran initializeData, fetching once', async () => {
    api.listDrivers.mockResolvedValue([driver])
    const { loadReferenceData } = useAppStore.getState()
    await Promise.all([loadReferenceData(), loadReferenceData()])
    expect(useAppStore.getState().drivers).toEqual([driver])
    expect(api.listDrivers).toHaveBeenCalledTimes(1)
    // Roster present: later mounts neither refetch nor overwrite.
    await useAppStore.getState().loadReferenceData()
    expect(api.listDrivers).toHaveBeenCalledTimes(1)
  })
})
