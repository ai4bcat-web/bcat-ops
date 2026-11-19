// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CarrierPaymentMethodRecord } from '@/types/tms'
import { BankDetailsPanel } from './BankDetailsPanel'

const api = vi.hoisted(() => ({ setCarrierBankDetails: vi.fn(), clearCarrierBankDetails: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

// Synthetic numbers only: a public Federal Reserve routing number and a made-up account.
const ROUTING = '011000015'
const ACCOUNT = '000123456789'

const method = (over: Partial<CarrierPaymentMethodRecord> = {}): CarrierPaymentMethodRecord => ({
  id: 'pm-1', carrierId: 'car-1', method: 'ACH', recipientType: 'CARRIER', accountLast4: '6789', routingLast4: '0015',
  createdBy: 't', updatedBy: 't', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('BankDetailsPanel', () => {
  it('shows only a masked line to a non-admin, with no way to act', () => {
    render(<BankDetailsPanel method={method({ bankDetailsOnFileAt: '2026-11-19T00:00:00Z', bankAccountType: 'CHECKING' })} isAdmin={false} onChanged={vi.fn()} />)
    expect(screen.getByText(/on file ••••6789/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('flags a method with no numbers on file', () => {
    render(<BankDetailsPanel method={method()} isAdmin onChanged={vi.fn()} />)
    expect(screen.getByText('not on file')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enter' })).toBeInTheDocument()
  })

  it('blocks a routing number that fails the check digit and a mismatched account re-entry', () => {
    render(<BankDetailsPanel method={method()} isAdmin onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    fireEvent.change(screen.getByLabelText('Routing number (9 digits)'), { target: { value: '011000016' } })
    expect(screen.getByText('That routing number fails the check-digit test.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: ACCOUNT } })
    fireEvent.change(screen.getByLabelText('Re-enter account number'), { target: { value: '999999999' } })
    expect(screen.getByText('The two account numbers do not match.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('sends the numbers once, then clears every field and never shows them back', async () => {
    api.setCarrierBankDetails.mockResolvedValue(method({ bankDetailsOnFileAt: '2026-11-19T00:00:00Z' }))
    const onChanged = vi.fn()
    const { container } = render(<BankDetailsPanel method={method()} isAdmin onChanged={onChanged} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    const routing = screen.getByLabelText('Routing number (9 digits)') as HTMLInputElement
    const account = screen.getByLabelText('Account number') as HTMLInputElement
    expect(routing.type).toBe('password')
    expect(account.type).toBe('password')
    fireEvent.change(routing, { target: { value: ROUTING } })
    fireEvent.change(account, { target: { value: ACCOUNT } })
    fireEvent.change(screen.getByLabelText('Re-enter account number'), { target: { value: ACCOUNT } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(api.setCarrierBankDetails).toHaveBeenCalledWith({
      methodId: 'pm-1', expectedUpdatedAt: '2026-01-01T00:00:00Z', routingNumber: ROUTING, accountNumber: ACCOUNT, accountType: 'CHECKING',
    })
    expect(document.body.textContent).not.toContain(ACCOUNT)
    expect(document.body.textContent).not.toContain(ROUTING)
    expect(container.innerHTML).not.toContain(ACCOUNT)
  })

  it('shows the server refusal and keeps nothing on screen after cancel', async () => {
    api.setCarrierBankDetails.mockRejectedValue(new Error('That routing number fails the check-digit test; re-check it'))
    render(<BankDetailsPanel method={method()} isAdmin onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    fireEvent.change(screen.getByLabelText('Routing number (9 digits)'), { target: { value: ROUTING } })
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: ACCOUNT } })
    fireEvent.change(screen.getByLabelText('Re-enter account number'), { target: { value: ACCOUNT } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/check-digit test; re-check it/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }))
    expect((screen.getByLabelText('Account number') as HTMLInputElement).value).toBe('')
  })
})
