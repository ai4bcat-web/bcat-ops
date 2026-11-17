// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomerRecord } from '@/types/tms'
import { EditCustomerBillingDialog } from './EditCustomerBillingDialog'

const h = vi.hoisted(() => ({ patchCustomer: vi.fn(async () => ({})) }))
vi.mock('@/lib/apiClient', () => ({
  patchCustomer: h.patchCustomer,
  plainSaveError: (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const customer = { id: 'cus-1', name: 'ACME FREIGHT', billingMethod: null, apEmail: null, apEmailsExtra: null, mcNumber: '123456', paymentTermsDays: 30, updatedAt: '2026-11-16T10:00:00.000Z' } as unknown as CustomerRecord

describe('EditCustomerBillingDialog (the What\'s missing customer items)', () => {
  beforeEach(() => h.patchCustomer.mockClear())

  it('saves only the billing fields as a patch, against the customer\'s version, then closes', async () => {
    const onSaved = vi.fn()
    const onClose = vi.fn()
    render(<EditCustomerBillingDialog customer={customer} onClose={onClose} onSaved={onSaved} />)
    fireEvent.change(screen.getByTestId('edit-customer-billing'), { target: { value: 'MANUAL' } })
    fireEvent.click(screen.getByTestId('edit-customer-save'))
    await waitFor(() => expect(h.patchCustomer).toHaveBeenCalledTimes(1))
    const [id, patch, version] = h.patchCustomer.mock.calls[0] as unknown as [string, Record<string, unknown>, string]
    expect(id).toBe('cus-1')
    expect(version).toBe('2026-11-16T10:00:00.000Z')
    expect(patch).toMatchObject({ billingMethod: 'MANUAL', mcNumber: '123456', paymentTermsDays: 30 })
    expect(patch).not.toHaveProperty('name')
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })

  it('a failed save stays open and says why', async () => {
    h.patchCustomer.mockRejectedValueOnce(new Error('This customer was changed by someone else'))
    const onClose = vi.fn()
    render(<EditCustomerBillingDialog customer={customer} onClose={onClose} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTestId('edit-customer-save'))
    await screen.findByText('This customer was changed by someone else')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('saves a typed MC as digits only, and says where the change applies', async () => {
    const onClose = vi.fn()
    render(<EditCustomerBillingDialog customer={{ ...customer, mcNumber: null } as CustomerRecord} onClose={onClose} onSaved={vi.fn()} context="3 loads are in Ready to Invoice for this customer." source="AR_READY_TO_INVOICE" reason="Fixed from Ready to Invoice" />)
    expect(screen.getByText('3 loads are in Ready to Invoice for this customer.')).toBeTruthy()
    fireEvent.change(screen.getByTestId('edit-customer-mc'), { target: { value: 'MC 654321' } })
    fireEvent.click(screen.getByTestId('edit-customer-save'))
    await waitFor(() => expect(h.patchCustomer).toHaveBeenCalledTimes(1))
    const patch = (h.patchCustomer.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
    expect(patch).toMatchObject({ mcNumber: '654321', changeSource: 'AR_READY_TO_INVOICE', changeReason: 'Fixed from Ready to Invoice' })
  })

  it('refuses an MC with letters and warns about an odd length', async () => {
    render(<EditCustomerBillingDialog customer={customer} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByTestId('edit-customer-mc'), { target: { value: 'ABC12' } })
    fireEvent.click(screen.getByTestId('edit-customer-save'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(h.patchCustomer).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('edit-customer-mc'), { target: { value: '12' } })
    expect(screen.getByText(/does not look like an MC number/)).toBeTruthy()
  })
})
