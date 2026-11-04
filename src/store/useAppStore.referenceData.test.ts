// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({ listDrivers: vi.fn(), listEquipment: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)

let useAppStore: typeof import('./useAppStore').useAppStore

const driver = { id: 'drv-1', name: 'Ada Driver' }

beforeEach(async () => {
  // `referenceLoad` is module state: a fresh module per test keeps them order-independent.
  vi.resetModules()
  ;({ useAppStore } = await import('./useAppStore'))
  api.listDrivers.mockReset()
  api.listEquipment.mockReset()
  api.listEquipment.mockResolvedValue([])
  useAppStore.setState({ drivers: [], fleetLoaded: false })
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

  it('marks the fleet loaded once the reference read has the equipment, so fleet-dependent cards stop waiting', async () => {
    api.listDrivers.mockResolvedValue([driver])
    api.listEquipment.mockResolvedValue([{ id: 'e1', unitNumber: '1', type: 'truck', active: true }])
    await useAppStore.getState().loadReferenceData()
    expect(useAppStore.getState().fleetLoaded).toBe(true)
  })

  it('marks the fleet loaded even when the roster read fails (no endless spinner)', async () => {
    api.listDrivers.mockRejectedValue(new Error('down'))
    await useAppStore.getState().loadReferenceData()
    expect(useAppStore.getState().fleetLoaded).toBe(true)
  })
})
