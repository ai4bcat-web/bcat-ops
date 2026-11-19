// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { looksLikeCardNumber } from '@/lib/cardNumber'
import { CarrierPaymentEditor } from './CarrierPaymentEditor'

vi.mock('@/lib/apiClient', () => ({ getFactorRemitEmails: vi.fn().mockResolvedValue({}) }))

describe('looksLikeCardNumber', () => {
  it('flags 13+ digits however they are spaced', () => {
    expect(looksLikeCardNumber('4242 4242 4242 4242')).toBe(true)
    expect(looksLikeCardNumber('4242-4242-4242-4242')).toBe(true)
    expect(looksLikeCardNumber('4242')).toBe(false)
    expect(looksLikeCardNumber('Chase Visa')).toBe(false)
  })
})

describe('CarrierPaymentEditor credit card', () => {
  const open = () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <MemoryRouter>
        <CarrierPaymentEditor methods={[]} onSave={onSave} onArchive={vi.fn()} carrierName="Acme" />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /add payment method/i }))
    fireEvent.change(screen.getByLabelText('Payment method'), { target: { value: 'CARD' } })
    return onSave
  }

  it('offers Credit card and shows the never-store note', () => {
    open()
    expect(screen.getByRole('option', { name: 'Credit card' })).toBeTruthy()
    expect(screen.getByTestId('card-method-note').textContent).toMatch(/never enter the full card number/i)
    expect(screen.queryByLabelText('Routing last 4')).toBeNull()
  })

  it('blocks a full card number and saves the last four', async () => {
    const onSave = open()
    fireEvent.change(screen.getByLabelText('Bank'), { target: { value: '4242 4242 4242 4242' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/looks like a full card number/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Bank'), { target: { value: 'Visa' } })
    fireEvent.change(screen.getByLabelText('Account last 4'), { target: { value: '4242' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ method: 'CARD', accountLast4: '4242', routingLast4: null }))
  })
})
