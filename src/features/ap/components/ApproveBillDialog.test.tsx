// @vitest-environment jsdom
/**
 * A bill the imports wrote carries no payee, and the Approve dialog refused it with "This bill has no payee" even
 * when the carrier had a payment method on file. The dialog now judges such a bill under the carrier's method as it
 * stands (the same choice the Lambda makes) and says so; a carrier with nothing on file still blocks, with a way to
 * add the method and check again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '@testing-library/jest-dom/vitest'

const api = vi.hoisted(() => ({
  approveBill: vi.fn(),
  getCarrier: vi.fn(),
  getShipmentBundle: vi.fn(),
  getTmsSettings: vi.fn(),
  previewBill: vi.fn(),
  graphqlErrorText: (e: unknown) => String(e),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ isAdmin: true }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ApproveBillDialog } from './ApproveBillDialog'

const BILL = {
  id: 'cb:lcr-1:1', shipmentId: 'shp-1', loadCarrierId: 'lcr-1', loadId: 'load-1', carrierId: 'car-1', carrierName: 'W GUZY TRUCKING INC',
  status: 'IN_REVIEW', payeeKind: 'CARRIER', paymentMethodId: null, remitTo: null, netCents: 95_000, grossCents: 95_000, billedCents: 95_000,
  varianceCents: 0, quickPayFeeCents: 0, version: 1,
} as never

const ACH = { name: 'W GUZY TRUCKING INC', factorName: null, method: 'ACH', accountLast4: null, payeeEmail: 'remit@guzy.test', address: null }

beforeEach(() => {
  vi.clearAllMocks()
  api.getShipmentBundle.mockResolvedValue({
    loadCarriers: [{ id: 'lcr-1', status: 'ACTIVE', rateConStatus: 'SIGNED' }],
    loads: [{ id: 'load-1', status: 'DELIVERED', loadNumber: 'L1' }],
  })
  api.getCarrier.mockResolvedValue({ id: 'car-1', name: 'W GUZY TRUCKING INC', status: 'ACTIVE' })
  api.getTmsSettings.mockResolvedValue({})
  api.approveBill.mockResolvedValue({ bill: { id: 'cb:lcr-1:1' } })
})

const draw = () => render(
  <MemoryRouter>
    <ApproveBillDialog bill={BILL} open onOpenChange={vi.fn()} onDone={vi.fn()} />
  </MemoryRouter>,
)

describe('ApproveBillDialog on a bill with no payee of its own', () => {
  it('approves under the carrier’s payment method and says where the money goes', async () => {
    api.previewBill.mockResolvedValue({ gate: { missing: [] }, payee: { kind: 'CARRIER', paymentMethodId: 'pm-1', remitTo: ACH } })
    draw()
    expect(await screen.findByTestId('approve-payee-note')).toHaveTextContent('remittance to remit@guzy.test')
    expect(screen.queryByText(/no payee/)).toBeNull()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toBeEnabled()
    fireEvent.click(approve)
    await waitFor(() => expect(api.approveBill).toHaveBeenCalledWith(expect.objectContaining({ billId: 'cb:lcr-1:1' })))
  })

  it('still blocks when the carrier has no payment method, and offers the profile and a re-check', async () => {
    api.previewBill.mockResolvedValue({ gate: { missing: [] }, payee: { kind: 'CARRIER', paymentMethodId: null, remitTo: null } })
    draw()
    expect(await screen.findByText(/This bill has no payee/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('link', { name: /Add the payment method on the carrier profile/ })).toHaveAttribute('href', '/tms/carriers/car-1')

    // The method is added on the profile; Check again reads it and the block goes.
    api.previewBill.mockResolvedValue({ gate: { missing: [] }, payee: { kind: 'CARRIER', paymentMethodId: 'pm-1', remitTo: ACH } })
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled())
    expect(screen.queryByText(/no payee/)).toBeNull()
  })

  it('leaves a bill that already names its payee alone', async () => {
    api.previewBill.mockResolvedValue({ gate: { missing: [] }, payee: { kind: 'CARRIER', paymentMethodId: 'pm-2', remitTo: { ...ACH, payeeEmail: 'other@guzy.test' } } })
    render(
      <MemoryRouter>
        <ApproveBillDialog bill={{ ...(BILL as object), paymentMethodId: 'pm-1', remitTo: ACH } as never} open onOpenChange={vi.fn()} onDone={vi.fn()} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled())
    expect(screen.queryByTestId('approve-payee-note')).toBeNull()
  })
})
