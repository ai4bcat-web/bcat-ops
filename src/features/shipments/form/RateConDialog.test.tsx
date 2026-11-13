// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

import { RateConDialog } from './RateConDialog'
import type { ShipmentActions } from '@/features/shipments/useShipmentActions'
import type { ShipmentBundle } from '@/types/tms'

const toastSuccess = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }))
vi.mock('@/lib/apiClient', () => ({
  getCarrierBundle: vi.fn(async () => ({
    carrier: { id: 'car-1', name: 'Swift', status: 'ACTIVE', email: 'main@swift.com', mcpStatus: 'ACCEPTABLE' },
    contacts: [],
  })),
  listUserProfiles: vi.fn(async () => []),
  getRateConfirmUrl: vi.fn(async () => ''),
  getTrackingMailbox: vi.fn(async () => ({ tracking: 'threads+tracking@bcatcorp.com', thread: 'threads+x@bcatcorp.com' })),
}))
vi.mock('@/lib/carrierRateCon', () => ({
  buildRateConPdf: vi.fn(async () => new Uint8Array([1, 2, 3])),
  rateConPdfBase64: vi.fn(() => 'AAAA'),
  rateConFilename: vi.fn(() => 'rate-con.pdf'),
  joinRateConNotes: vi.fn(() => ''),
  rateConRepOf: vi.fn(() => null),
}))
vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'dispatch@bcatcorp.com', userId: 'u1', groups: [] }) }))

const bundle = {
  loads: [], orders: [], charges: [],
  loadCarriers: [{ id: 'lc-1', carrierId: 'car-1', carrierName: 'Swift', status: 'ACTIVE', rateConStatus: 'NOT_SENT' }],
} as unknown as ShipmentBundle

async function setup(sendRateCon: ShipmentActions['sendRateCon']) {
  const onClose = vi.fn()
  const sa = { sendRateCon, voidRateCon: vi.fn(async () => {}) } as unknown as ShipmentActions
  await act(async () => {
    render(<MemoryRouter><RateConDialog bundle={bundle} loadCarrierId="lc-1" settings={null} busy={false} onClose={onClose} sa={sa} /></MemoryRouter>)
  })
  return onClose
}

const sendButton = () => screen.findByRole('button', { name: /^(Send|Re-send) for e-signature$/ })

describe('RateConDialog', () => {
  beforeEach(() => { toastSuccess.mockClear() })

  it('closes with a toast naming the recipients once the send succeeds', async () => {
    const send = vi.fn(async () => {})
    const onClose = await setup(send)
    fireEvent.click(await sendButton())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(send).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith('Rate confirmation sent to main@swift.com')
  })

  it('stays open with the error when the send fails', async () => {
    const onClose = await setup(vi.fn(async () => { throw new Error('Mail server said no') }))
    fireEvent.click(await sendButton())
    expect(await screen.findByText(/Mail server said no/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
