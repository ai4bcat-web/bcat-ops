// @vitest-environment jsdom
/**
 * Smoke test that the BoxTruck SettingsModal wires the fixed-expense editor
 * with periodDays=14 and retains audit metadata on save.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Driver } from '@/types'
import type { DriverPaySetting } from '@/lib/apiClient'
import { SettingsModal } from '../driver-pay-box-trucks/BoxTruckPayForms'
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

const driver: Driver = { id: 'd2', name: 'Chad', email: 'chad@example.com' } as Driver
const existing: DriverPaySetting = {
  id: 's2',
  driverId: 'd2',
  payGroup: 'BOX_TRUCK',
  payPercent: 0.5,
  expensesBeforePercent: true,
  email: 'chad@example.com',
  fuelCardNumber: '00049',
  fixedExpenses: [{ label: 'Insurance', amount: 300, from: '2026-01-01' } as FixedExpenseInput],
  rateHistory: [],
  active: true,
  notes: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-09-01T12:00:00Z',
}

describe('BoxTruckSettingsModal fixed-expense wiring', () => {
  it('passes captured updatedAt and retains expense metadata on save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<SettingsModal driver={driver} existing={existing} onSave={onSave} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio'))
    fireEvent.click(screen.getByRole('button', { name: /End/i }))
    fireEvent.change(screen.getByLabelText(/End date/i), { target: { value: '2026-09-15' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))

    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [patch, expectedUpdatedAt] = onSave.mock.calls[0]
    expect(expectedUpdatedAt).toBe('2026-09-01T12:00:00Z')

    const expenses = (patch as DriverPaySetting).fixedExpenses as FixedExpenseInput[]
    const ended = expenses.find((e) => e.label === 'Insurance')
    expect(ended?.until).toBe('2026-09-15')
    expect(ended?.endedBy).toBe('tester@bcatcorp.com')
  })

  it('does not expose mileage calculation controls (Amazon-only feature)', () => {
    render(<SettingsModal driver={driver} existing={existing} onSave={vi.fn()} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    expect(screen.queryByRole('button', { name: /Mileage calculation/i })).toBeNull()
    expect(screen.getByLabelText(/Amount/i)).toBeTruthy()
  })
})
