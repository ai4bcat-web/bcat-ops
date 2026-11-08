// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { Equipment } from '@/types/equipment'

const api = vi.hoisted(() => ({
  listTruckConfigs: vi.fn(),
  upsertTruckConfig: vi.fn(async (input: Record<string, unknown>) => ({ createdAt: '', updatedAt: '', ...input })),
}))
vi.mock('@/lib/apiClient', () => api)

import { invalidateLists } from '@/lib/listCache'
import { useAppStore } from '@/store/useAppStore'
import { TruckPhonesCard } from './TruckPhonesCard'

const truck = (id: string, unitNumber: string, extra: Partial<Equipment> = {}) =>
  ({ id, unitNumber, type: 'truck', active: true, ...extra }) as Equipment

beforeEach(() => {
  vi.clearAllMocks()
  invalidateLists()
  api.listTruckConfigs.mockResolvedValue([{ truckId: 't-has', unitNumber: '1', phone: '+13125550100', createdAt: '', updatedAt: '' }])
  useAppStore.setState({
    equipment: [
      truck('t-has', '1'),
      truck('t-none', '2'),
      truck('t-parked', '3', { active: false }),
      { id: 'tr-1', unitNumber: 'T9', type: 'trailer', active: true } as Equipment,
    ],
    drivers: [], fleetLoaded: true,
  })
})

describe('TruckPhonesCard', () => {
  it('lists only the active trucks that have no phone', async () => {
    render(<TruckPhonesCard />)
    expect(await screen.findByText('Trucks without a phone (1)')).toBeTruthy()
    expect(screen.getByText('#2')).toBeTruthy()
    expect(screen.queryByText('#1')).toBeNull()
    expect(screen.queryByText('#3')).toBeNull()
    expect(screen.queryByText('#T9')).toBeNull()
  })

  it('drops the row once its phone is saved', async () => {
    render(<TruckPhonesCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add phone, truck 2' }))
    const row = screen.getByText('#2').closest('tr') as HTMLElement
    fireEvent.change(within(row).getByLabelText('Work phone, truck 2'), { target: { value: '3125550142' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('All trucks have a work phone.')).toBeTruthy()
    await waitFor(() => expect(api.upsertTruckConfig).toHaveBeenCalledWith(expect.objectContaining({ truckId: 't-none', phone: '+13125550142' })))
  })

  it('says so when every truck has a phone', async () => {
    api.listTruckConfigs.mockResolvedValue([
      { truckId: 't-has', unitNumber: '1', phone: '+13125550100', createdAt: '', updatedAt: '' },
      { truckId: 't-none', unitNumber: '2', phone: '+13125550101', createdAt: '', updatedAt: '' },
    ])
    render(<TruckPhonesCard />)
    expect(await screen.findByText('All trucks have a work phone.')).toBeTruthy()
  })
})
