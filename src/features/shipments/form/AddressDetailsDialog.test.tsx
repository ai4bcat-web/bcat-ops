// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoadCarrierRecord, ShipmentLoad } from '@/types/tms'

const api = vi.hoisted(() => ({ sendAddressDetails: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { AddressDetailsDialog } from './AddressDetailsDialog'

const lc = { id: 'lc-1', carrierName: 'ARCTIC HORIZON INC', tripNumber: 'T-9' } as unknown as LoadCarrierRecord
const load = {
  id: 'load-1', loadNumber: '20058', equipmentType: 'Flatbed',
  stops: [
    { id: 's1', type: 'pickup', name: 'WHIMSY INTERMODAL', address: { street: '5100 70th Pl A', city: 'Chicago', state: 'IL', zip: '60638' }, appt: '2026-11-16T15:00:00.000Z', apptType: 'exact' },
    { id: 's2', type: 'delivery', name: 'GENERAC', address: { street: '3300 Medalist Dr', city: 'Oshkosh', state: 'WI', zip: '54902' }, appt: '2026-11-16T16:00:00.000Z', apptType: 'fcfs', apptEnd: '2026-11-16T20:00:00.000Z' },
  ],
} as unknown as ShipmentLoad

describe('AddressDetailsDialog', () => {
  beforeEach(() => { api.sendAddressDetails.mockReset(); toast.success.mockReset() })

  it('defaults to the dispatcher, previews the stops, sends and closes with a toast', async () => {
    api.sendAddressDetails.mockResolvedValue({ sent: true, to: ['dispatch@arctic.com'], cc: [], subject: 's' })
    const onClose = vi.fn()
    render(<AddressDetailsDialog loadCarrier={lc} load={load} defaultTo="dispatch@arctic.com" onClose={onClose} />)
    expect(screen.getByTestId('address-details-to').textContent).toContain('dispatch@arctic.com')
    const preview = screen.getByTestId('address-details-preview').textContent ?? ''
    expect(preview).toContain('5100 70th Pl A')
    expect(preview).toContain('FCFS 11/16/2026 10:00–14:00')
    fireEvent.click(screen.getByTestId('address-details-send'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.sendAddressDetails).toHaveBeenCalledWith({ loadCarrierId: 'lc-1', to: ['dispatch@arctic.com'], cc: [] })
    expect(toast.success).toHaveBeenCalledWith('Address details sent to dispatch@arctic.com')
  })

  it('stays open with the error when sending fails', async () => {
    api.sendAddressDetails.mockRejectedValue(new Error('SES said no'))
    const onClose = vi.fn()
    render(<AddressDetailsDialog loadCarrier={lc} load={load} defaultTo="dispatch@arctic.com" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('address-details-send'))
    expect(await screen.findByText(/SES said no/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cannot send without a recipient', () => {
    render(<AddressDetailsDialog loadCarrier={lc} load={load} defaultTo="" onClose={vi.fn()} />)
    expect((screen.getByTestId('address-details-send') as HTMLButtonElement).disabled).toBe(true)
  })
})
