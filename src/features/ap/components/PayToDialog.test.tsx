// @vitest-environment jsdom
/**
 * The Pay-to editor inside Payable: it reads the carrier's payment methods, writes a new one through the same
 * `UPSERT_PAYMENT_METHOD` the carrier profile uses, and tells the board to re-read so the flag clears.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const api = vi.hoisted(() => ({
  getCarrierBundle: vi.fn(),
  upsertCarrierPaymentMethod: vi.fn(),
  archiveCarrierPaymentMethod: vi.fn(),
  getFactorRemitEmails: vi.fn().mockResolvedValue({}),
  graphqlErrorText: (e: unknown) => String(e),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useAddressAutofill', () => ({ useAddressAutofill: () => ({ hint: null, pickCity: vi.fn() }) }))

import { PayToDialog } from './PayToDialog'

beforeEach(() => {
  vi.clearAllMocks()
  api.getFactorRemitEmails.mockResolvedValue({})
})

describe('PayToDialog', () => {
  it('says what is missing when the carrier has no payment method, and what it is holding up', async () => {
    api.getCarrierBundle.mockResolvedValue({ paymentMethods: [] })
    render(
      <PayToDialog carrierId="car-9" carrierName="LANDSTAR RANGER" awaiting={{ count: 2, cents: 222_500 }} open onOpenChange={vi.fn()} onChanged={vi.fn()} />,
    )
    expect(await screen.findByText('Pay-to — LANDSTAR RANGER')).toBeInTheDocument()
    expect(await screen.findByTestId('carrier-no-payment-method')).toHaveTextContent('2 approved bills are waiting on it, $2,225.00 in all')
    expect(api.getCarrierBundle).toHaveBeenCalledWith('car-9')
  })

  it('reads the carrier’s existing methods so one can be marked preferred', async () => {
    api.getCarrierBundle.mockResolvedValue({
      paymentMethods: [
        { id: 'pm-a', carrierId: 'car-9', method: 'ACH', recipientType: 'CARRIER', status: 'ACTIVE', isPreferred: false, bankName: 'Chase Bank', accountLast4: '9545', updatedAt: '2026-11-01T00:00:00.000Z' },
      ],
    })
    render(<PayToDialog carrierId="car-9" carrierName="LANDSTAR RANGER" open onOpenChange={vi.fn()} onChanged={vi.fn()} />)
    await waitFor(() => expect(screen.queryByTestId('carrier-no-payment-method')).toBeNull())
    expect(screen.getByDisplayValue('Chase Bank')).toBeInTheDocument()
  })

  it('writes a new payment method for that carrier and tells the board to re-read', async () => {
    api.getCarrierBundle.mockResolvedValue({ paymentMethods: [] })
    api.upsertCarrierPaymentMethod.mockResolvedValue({ id: 'pm-new' })
    const onChanged = vi.fn()
    render(<PayToDialog carrierId="car-9" carrierName="LANDSTAR RANGER" open onOpenChange={vi.fn()} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: /Add payment method/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^Save/ }))
    await waitFor(() => expect(api.upsertCarrierPaymentMethod).toHaveBeenCalledWith(expect.objectContaining({ carrierId: 'car-9', method: 'ACH', recipientType: 'CARRIER' })))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    // Re-read after the save, so the editor shows what is now on file.
    await waitFor(() => expect(api.getCarrierBundle).toHaveBeenCalledTimes(2))
  })

  it('shows a failed read instead of an empty editor', async () => {
    api.getCarrierBundle.mockRejectedValue(new Error('boom'))
    render(<PayToDialog carrierId="car-9" carrierName="LANDSTAR RANGER" open onOpenChange={vi.fn()} onChanged={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  })
})
