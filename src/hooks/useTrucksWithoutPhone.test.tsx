// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import type { Equipment } from '@/types/equipment'

const api = vi.hoisted(() => ({
  listTruckConfigs: vi.fn(),
  upsertTruckConfig: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)

import { invalidateLists } from '@/lib/listCache'
import { useAppStore } from '@/store/useAppStore'
import { TruckPhonesCard } from '@/features/settings/TruckPhonesCard'
import { useTrucksWithoutPhone } from './useTrucksWithoutPhone'

const truck = (id: string, unitNumber: string, extra: Partial<Equipment> = {}) =>
  ({ id, unitNumber, type: 'truck', active: true, ...extra }) as Equipment

function Probe() {
  const { missing, loading } = useTrucksWithoutPhone()
  return <p data-testid="probe">{loading ? 'loading' : String(missing.length)}</p>
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidateLists()
  api.listTruckConfigs.mockResolvedValue([{ truckId: 'a', unitNumber: '1', phone: '+13125550100', createdAt: '', updatedAt: '' }])
})

describe('useTrucksWithoutPhone', () => {
  it('stays loading on the persisted fleet and gives Fleet and Settings the same count once the fleet read lands', async () => {
    useAppStore.setState({
      equipment: [truck('stale1', '90'), truck('stale2', '91'), truck('stale3', '92')],
      drivers: [], fleetLoaded: false,
    })
    render(<><Probe /><TruckPhonesCard /></>)
    await waitFor(() => expect(api.listTruckConfigs).toHaveBeenCalled())
    expect(screen.getByTestId('probe').textContent).toBe('loading')
    expect(screen.queryByText(/Trucks without a phone/)).toBeNull()

    act(() => {
      useAppStore.setState({ equipment: [truck('a', '1'), truck('b', '2'), truck('p', '3', { active: false })], fleetLoaded: true })
    })
    expect(await screen.findByText('Trucks without a phone (1)')).toBeTruthy()
    expect(screen.getByTestId('probe').textContent).toBe('1')
  })
})
