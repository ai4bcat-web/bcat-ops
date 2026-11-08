// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({
  listTruckConfigs: vi.fn(async () => []),
  upsertTruckConfig: vi.fn(async (input: Record<string, unknown>) => ({ createdAt: '', updatedAt: '', ...input })),
}))
vi.mock('@/lib/apiClient', () => api)

import { invalidateLists } from '@/lib/listCache'
import { TruckPhoneEditor } from './TruckPhoneEditor'

beforeEach(() => {
  vi.clearAllMocks()
  invalidateLists()
})

const phoneBox = () => screen.getByLabelText('Work phone, truck 12')

describe('TruckPhoneEditor', () => {
  it('saves what was typed as E.164 with the label', async () => {
    const onDone = vi.fn()
    render(<TruckPhoneEditor truckId="t1" unitNumber="12" onDone={onDone} />)
    fireEvent.change(phoneBox(), { target: { value: '3125550142' } })
    expect((phoneBox() as HTMLInputElement).value).toBe('(312) 555-0142')
    fireEvent.change(phoneBox(), { target: { value: '13125550142' } })
    expect((phoneBox() as HTMLInputElement).value).toBe('(312) 555-0142')
    fireEvent.change(screen.getByLabelText('Phone label, truck 12'), { target: { value: ' Cab phone ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(api.upsertTruckConfig).toHaveBeenCalledWith({ truckId: 't1', unitNumber: '12', phone: '+13125550142', phoneLabel: 'Cab phone' })
  })

  it('shows the reason and writes nothing for a number that is not a US number', async () => {
    render(<TruckPhoneEditor truckId="t1" unitNumber="12" />)
    fireEvent.change(phoneBox(), { target: { value: '312555' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByRole('alert').textContent).toMatch(/US phone number/)
    expect(api.upsertTruckConfig).not.toHaveBeenCalled()
    await act(async () => {}) // the truck-config list load settles inside act
  })

  it('refuses letters', async () => {
    render(<TruckPhoneEditor truckId="t1" unitNumber="12" />)
    fireEvent.change(phoneBox(), { target: { value: '+1 312 555 CALL' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert').textContent).toMatch(/digits only/)
    expect(api.upsertTruckConfig).not.toHaveBeenCalled()
    await act(async () => {}) // the truck-config list load settles inside act
  })

  it('Clear sends nulls for the phone and its label', async () => {
    render(<TruckPhoneEditor truckId="t1" unitNumber="12" phone="+13125550142" phoneLabel="Cab" />)
    expect((phoneBox() as HTMLInputElement).value).toBe('(312) 555-0142')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    await waitFor(() => expect(api.upsertTruckConfig).toHaveBeenCalledWith({ truckId: 't1', unitNumber: '12', phone: null, phoneLabel: null }))
  })

  it('reports a failed save and keeps the editor open', async () => {
    api.upsertTruckConfig.mockRejectedValueOnce(new Error('boom'))
    const onDone = vi.fn()
    render(<TruckPhoneEditor truckId="t1" unitNumber="12" onDone={onDone} />)
    fireEvent.change(phoneBox(), { target: { value: '3125550142' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect((await screen.findByRole('alert')).textContent).toBe('boom')
    expect(onDone).not.toHaveBeenCalled()
  })
})
