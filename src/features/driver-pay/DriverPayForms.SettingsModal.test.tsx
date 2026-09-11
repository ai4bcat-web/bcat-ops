// @vitest-environment jsdom
/**
 * Smoke test that the Amazon SettingsModal wires the fixed-expense editor correctly:
 * - adds/ends history rows,
 * - retains audit metadata in the save payload,
 * - captures the initial updatedAt and passes it to onSave,
 * - disables the Save button while a draft edit is open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Driver } from '@/types'
import type { DriverPaySetting } from '@/lib/apiClient'
import { SettingsModal } from './DriverPayForms'
import type { FixedExpenseInput } from '@/lib/driverPay'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'tester@bcatcorp.com' } }),
}))

const originalRandomUUID = globalThis.crypto?.randomUUID
beforeAll(() => {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    configurable: true,
  })
})
afterAll(() => {
  if (originalRandomUUID) {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: originalRandomUUID,
      configurable: true,
    })
  }
})

const driver: Driver = { id: 'd1', name: 'Zak Pace', email: 'zak@example.com' } as Driver
const existing: DriverPaySetting = {
  id: 's1',
  driverId: 'd1',
  payGroup: 'AMAZON',
  payPercent: 0.42,
  expensesBeforePercent: false,
  email: 'zak@example.com',
  fuelCardNumber: '00049',
  fixedExpenses: [
    { label: 'ELD', amount: 45, from: '2026-01-01' } as FixedExpenseInput,
  ],
  rateHistory: [],
  active: true,
  notes: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-09-01T12:00:00Z',
}

describe('DriverPaySettingsModal fixed-expense wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes captured updatedAt and retains expense metadata on save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<SettingsModal driver={driver} existing={existing} onSave={onSave} onClose={vi.fn()} />)

    // End the existing ELD expense.
    fireEvent.click(screen.getByRole('radio'))
    fireEvent.click(screen.getByRole('button', { name: /End/i }))
    fireEvent.change(screen.getByLabelText(/End date/i), { target: { value: '2026-09-08' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))

    // Add a new expense type.
    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    fireEvent.change(screen.getByLabelText(/Expense type/i), { target: { value: 'Insurance' } })
    fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText(/Effective from/i), { target: { value: '2026-09-08' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))

    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [patch, expectedUpdatedAt] = onSave.mock.calls[0]
    expect(expectedUpdatedAt).toBe('2026-09-01T12:00:00Z')

    const expenses = (patch as DriverPaySetting).fixedExpenses as FixedExpenseInput[]
    expect(expenses.length).toBeGreaterThanOrEqual(2)

    const ended = expenses.find((e) => e.label === 'ELD')
    expect(ended?.until).toBe('2026-09-08')
    expect(ended?.endedBy).toBe('tester@bcatcorp.com')
    expect(ended?.revisionId).toBeTruthy()

    const added = expenses.find((e) => e.label === 'Insurance')
    expect(added?.amount).toBe(100)
    expect(added?.from).toBe('2026-09-08')
    expect(added?.recordedBy).toBe('tester@bcatcorp.com')
    expect(added?.revisionId).toBeTruthy()
  })

  it('saves a mileage-based fixed expense through the Amazon settings modal', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<SettingsModal driver={driver} existing={existing} onSave={onSave} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    expect(screen.getByRole('button', { name: /Mileage calculation/i })).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Insurance'), { target: { value: 'Mileage reimbursement' } })
    fireEvent.click(screen.getByRole('button', { name: /Mileage calculation/i }))
    fireEvent.change(screen.getByLabelText(/Cost per mile/i), { target: { value: '0.125' } })
    fireEvent.change(screen.getByLabelText(/Miles/i), { target: { value: '2000' } })
    fireEvent.change(screen.getByLabelText(/Effective from/i), { target: { value: '2026-09-08' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))

    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [patch] = onSave.mock.calls[0]
    const expenses = (patch as DriverPaySetting).fixedExpenses as FixedExpenseInput[]
    const mileageExpense = expenses.find((e) => e.label === 'Mileage reimbursement')
    expect(mileageExpense?.amount).toBe(250)
    expect(mileageExpense?.mileage).toEqual({ costPerMile: 0.125, miles: 2000 })
    expect(mileageExpense?.from).toBe('2026-09-08')
  })

  it('disables Save and explains why while a fixed-expense draft is open', () => {
    render(<SettingsModal driver={driver} existing={existing} onSave={vi.fn()} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))

    const saveBtn = screen.getByRole('button', { name: /Save settings/i })
    expect(saveBtn.disabled).toBe(true)
    expect(screen.getByText(/Finish or cancel the fixed-expense edit before saving/i)).toBeTruthy()
  })
})
