// @vitest-environment jsdom
/**
 * Focused regression tests for the Amazon CreditModal (DEBIT/CREDIT) mileage basis.
 * - Lease-mileage debits compute amount from miles × costPerMile using the shared
 *   calculateMileageExpense rounding/validation.
 * - Basis is persisted and reloaded on edit; legacy amount-only lease mileage stays
 *   editable without inventing miles.
 * - Switching reason away from LEASE_MILEAGE clears the basis fields.
 * - Reopening the modal with a different credit resets the form.
 * - The debit is subtracted at 100% after the net (verified with real calcDriverPay).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { DriverPayCredit, DriverPayCreditInput } from '@/lib/apiClient'
import { calcDriverPay } from '@/lib/driverPay'
import { CreditModal } from './DriverPayForms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'tester@bcatcorp.com' } }),
}))

const baseProps = {
  driverId: 'd1',
  driverName: 'Chad',
  periodStart: '2026-08-30',
  periodLabel: 'Aug 24 – Aug 30, 2026',
  kind: 'DEBIT' as const,
  createdBy: 'office@bcatcorp.com',
  onSave: vi.fn().mockResolvedValue(undefined),
  onClose: vi.fn(),
}

function leaseMileageCredit(overrides: Partial<DriverPayCredit> = {}): DriverPayCredit {
  return {
    id: 'c1',
    driverId: 'd1',
    periodStart: '2026-08-30',
    kind: 'DEBIT',
    reasonCode: 'LEASE_MILEAGE',
    amount: 65,
    miles: 100,
    costPerMile: 0.65,
    label: null,
    date: null,
    loadRef: null,
    createdBy: 'office@bcatcorp.com',
    notes: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

describe('CreditModal lease-mileage debits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('computes and persists miles, costPerMile, and amount for a new lease mileage debit', async () => {
    render(<CreditModal {...baseProps} />)

    fireEvent.change(screen.getByLabelText(/^Reason code/i), { target: { value: 'LEASE_MILEAGE' } })
    fireEvent.change(screen.getByLabelText(/^Miles$/i), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText(/^Cost per mile$/i), { target: { value: '0.65' } })

    await waitFor(() => expect(screen.getByLabelText(/^Amount/i)).toHaveValue('65'))

    fireEvent.click(screen.getByRole('button', { name: /Add debit/i }))

    await waitFor(() => expect(baseProps.onSave).toHaveBeenCalledTimes(1))
    const saved = baseProps.onSave.mock.calls[0][0] as DriverPayCreditInput
    expect(saved.reasonCode).toBe('LEASE_MILEAGE')
    expect(saved.kind).toBe('DEBIT')
    expect(saved.miles).toBe(100)
    expect(saved.costPerMile).toBe(0.65)
    expect(saved.amount).toBe(65)
  })

  it('uses calculateMileageExpense rounding for sub-cent cost-per-mile rates', async () => {
    render(<CreditModal {...baseProps} />)

    fireEvent.change(screen.getByLabelText(/^Reason code/i), { target: { value: 'LEASE_MILEAGE' } })
    fireEvent.change(screen.getByLabelText(/^Miles$/i), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText(/^Cost per mile$/i), { target: { value: '0.1234' } })

    await waitFor(() => expect(screen.getByLabelText(/^Amount/i)).toHaveValue('1.23'))

    fireEvent.click(screen.getByRole('button', { name: /Add debit/i }))

    await waitFor(() => expect(baseProps.onSave).toHaveBeenCalledTimes(1))
    expect((baseProps.onSave.mock.calls[0][0] as DriverPayCreditInput).amount).toBe(1.23)
  })

  it('loads mileage basis on edit and recomputes when miles change', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CreditModal {...baseProps} initial={leaseMileageCredit()} onSave={onSave} />)

    expect(screen.getByLabelText(/^Miles$/i)).toHaveValue('100')
    expect(screen.getByLabelText(/^Cost per mile$/i)).toHaveValue('0.65')
    expect(screen.getByLabelText(/^Amount/i)).toHaveValue('65')

    fireEvent.change(screen.getByLabelText(/^Miles$/i), { target: { value: '200' } })

    await waitFor(() => expect(screen.getByLabelText(/^Amount/i)).toHaveValue('130'))

    fireEvent.click(screen.getByRole('button', { name: /Save debit/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const saved = onSave.mock.calls[0][0] as DriverPayCreditInput
    expect(saved.miles).toBe(200)
    expect(saved.costPerMile).toBe(0.65)
    expect(saved.amount).toBe(130)
  })

  it('keeps legacy amount-only lease mileage editable without inventing miles', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const initial = leaseMileageCredit({ amount: 214.48, miles: null, costPerMile: null })
    render(<CreditModal {...baseProps} initial={initial} onSave={onSave} />)

    expect(screen.getByLabelText(/^Amount/i)).toHaveValue('214.48')
    expect(screen.getByLabelText(/^Miles$/i)).toHaveValue('')
    expect(screen.getByLabelText(/^Cost per mile$/i)).toHaveValue('')

    fireEvent.change(screen.getByLabelText(/^Amount/i), { target: { value: '220' } })
    fireEvent.click(screen.getByRole('button', { name: /Save debit/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const saved = onSave.mock.calls[0][0] as DriverPayCreditInput
    expect(saved.amount).toBe(220)
    expect(saved.miles).toBeNull()
    expect(saved.costPerMile).toBeNull()
  })

  it('clears mileage basis when reason changes away from LEASE_MILEAGE', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CreditModal {...baseProps} initial={leaseMileageCredit()} onSave={onSave} />)

    fireEvent.change(screen.getByLabelText(/^Reason code/i), { target: { value: 'CASH_ADVANCE' } })

    expect(screen.queryByLabelText(/^Miles$/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Cost per mile$/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^Amount/i)).toHaveValue('65')

    fireEvent.click(screen.getByRole('button', { name: /Save debit/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const saved = onSave.mock.calls[0][0] as DriverPayCreditInput
    expect(saved.reasonCode).toBe('CASH_ADVANCE')
    expect(saved.miles).toBeNull()
    expect(saved.costPerMile).toBeNull()
    expect(saved.amount).toBe(65)
  })

  it('resets form fields when reopened with a different credit', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<CreditModal {...baseProps} key="new" onSave={onSave} />)

    fireEvent.change(screen.getByLabelText(/^Reason code/i), { target: { value: 'LEASE_MILEAGE' } })
    fireEvent.change(screen.getByLabelText(/^Miles$/i), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText(/^Cost per mile$/i), { target: { value: '0.65' } })
    await waitFor(() => expect(screen.getByLabelText(/^Amount/i)).toHaveValue('65'))

    const reopened = leaseMileageCredit({
      id: 'c2',
      reasonCode: 'IFTA',
      amount: 75,
      miles: null,
      costPerMile: null,
    })
    rerender(<CreditModal {...baseProps} key={reopened.id} initial={reopened} onSave={onSave} />)

    expect(screen.getByLabelText(/^Reason code/i)).toHaveValue('IFTA')
    expect(screen.queryByLabelText(/^Miles$/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^Amount/i)).toHaveValue('75')
  })

  it('reduces the check by the full debit amount after the net via calcDriverPay', () => {
    const setting = { payPercent: 0.42, expensesBeforePercent: true }
    const trips = [{ freightAmount: 2000 }]
    const debit = { label: 'Lease mileage', amount: 65, reasonCode: 'LEASE_MILEAGE' }

    const beforeDebit = calcDriverPay(trips, setting, [], [], [])
    const afterDebit = calcDriverPay(trips, setting, [], [], [debit])

    expect(afterDebit.totalDebits).toBe(65)
    expect(afterDebit.checkAmount).toBe(beforeDebit.payBeforeCredits - 65)
    expect(afterDebit.checkAmount).toBeLessThan(beforeDebit.checkAmount)
  })
})
