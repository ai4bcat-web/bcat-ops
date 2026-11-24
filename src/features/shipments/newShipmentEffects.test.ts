import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/apiClient', () => ({ createApptTask: vi.fn(), notifySlackStatusChange: vi.fn(), updateIntakeItem: vi.fn(), updateLoad: vi.fn() }))
vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))

import { linkStopsToDirectory } from './newShipmentEffects'
import type { Stop } from '@/types'
import type { LocationRecord } from '@/types/tms'

const stop = { id: 's1', type: 'pickup', name: 'Acme Dock', city: 'Joliet', state: 'IL' } as unknown as Stop

describe('linkStopsToDirectory: filing a typed stop as a new location', () => {
  it('files it when the person may add locations', async () => {
    const createLocation = vi.fn(async () => ({ id: 'loc-new' }) as LocationRecord)
    const out = await linkStopsToDirectory([stop], [], { createLocation })
    expect(createLocation).toHaveBeenCalledTimes(1)
    expect(out[0]!.locationId).toBe('loc-new')
  })

  it('leaves it unlinked, and creates nothing, when they may not (limited to the fleet profiles)', async () => {
    const createLocation = vi.fn(async () => ({ id: 'loc-new' }) as LocationRecord)
    const out = await linkStopsToDirectory([stop], [], { createLocation, canCreate: false })
    expect(createLocation).not.toHaveBeenCalled()
    expect(out[0]!.locationId).toBeUndefined()
  })

  it('still links a stop to a location that already exists when they may not add', async () => {
    const createLocation = vi.fn()
    const existing = { id: 'loc-1', name: 'Acme Dock', city: 'Joliet', state: 'IL' } as unknown as LocationRecord
    const out = await linkStopsToDirectory([stop], [existing], { createLocation, canCreate: false })
    expect(createLocation).not.toHaveBeenCalled()
    expect(out[0]!.locationId).toBe('loc-1')
  })
})
