// @vitest-environment jsdom
/**
 * Focused render tests for the shared fixed-expense history editor.
 * These exercise the real local prepare/apply helpers (not a mocked echo) so
 * assertions verify the actual add/change/end behavior and audit metadata.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FixedExpenseEditor } from './FixedExpenseEditor'
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

const initialAdd: FixedExpenseInput[] = []
const initialChange: FixedExpenseInput[] = [
  { label: 'Insurance', amount: 200, from: '2026-01-01', revisionId: 'rev-1', expenseId: 'exp-1', recordedAt: '2026-01-01T00:00:00Z', recordedBy: 'legacy' },
]
const initialEnd: FixedExpenseInput[] = [
  { label: 'Tablet', amount: 30, from: '2026-01-01', revisionId: 'rev-2', expenseId: 'exp-2', recordedAt: '2026-01-01T00:00:00Z', recordedBy: 'legacy' },
]
const initialHistory: FixedExpenseInput[] = [
  { label: 'Old plates', amount: 100, from: '2026-01-01', until: '2026-06-01', endedAt: '2026-06-01T00:00:00Z', endedBy: 'admin', revisionId: 'r1', expenseId: 'e1', recordedAt: '2026-01-01T00:00:00Z', recordedBy: 'admin' },
  { label: 'New plates', amount: 120, from: '2026-06-01', revisionId: 'r2', expenseId: 'e1', recordedAt: '2026-06-01T00:00:00Z', recordedBy: 'admin' },
  { label: 'Future escrow', amount: 75, from: '2030-01-01', revisionId: 'r3', expenseId: 'e2', recordedAt: '2026-01-01T00:00:00Z', recordedBy: 'admin' },
]

describe('FixedExpenseEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders an empty state when there are no expenses', () => {
    render(<FixedExpenseEditor value={[]} onChange={vi.fn()} periodDays={7} />)
    expect(screen.getByText(/Fixed weekly expenses/i)).toBeTruthy()
    expect(screen.getByText(/No fixed expenses/i)).toBeTruthy()
  })

  it('adds a new expense type and emits audit metadata', () => {
    const onChange = vi.fn()
    render(<FixedExpenseEditor value={initialAdd} onChange={onChange} periodDays={7} />)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    fireEvent.change(screen.getByPlaceholderText('Insurance'), { target: { value: 'ELD' } })
    fireEvent.change(screen.getByPlaceholderText('250'), { target: { value: '45' } })
    fireEvent.change(screen.getByLabelText(/Effective from/i), { target: { value: '2026-09-07' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as FixedExpenseInput[]
    expect(next).toHaveLength(1)
    expect(next[0].label).toBe('ELD')
    expect(next[0].amount).toBe(45)
    expect(next[0].from).toBe('2026-09-07')
    expect(next[0].revisionId).toBeTruthy()
    expect(next[0].expenseId).toBeTruthy()
    expect(next[0].recordedAt).toBeTruthy()
    expect(next[0].recordedBy).toBe('tester@bcatcorp.com')
    expect(next[0].endedAt).toBeNull()
    expect(next[0].endedBy).toBeNull()
  })

  it('changes an existing expense from a date, preserving the old version', () => {
    const onChange = vi.fn()
    render(<FixedExpenseEditor value={initialChange} onChange={onChange} periodDays={14} />)

    fireEvent.click(screen.getByRole('radio'))
    fireEvent.click(screen.getByRole('button', { name: /Change/i }))
    fireEvent.change(screen.getByPlaceholderText('Insurance'), { target: { value: 'Insurance' } })
    fireEvent.change(screen.getByPlaceholderText('250'), { target: { value: '250' } })
    fireEvent.change(screen.getByLabelText(/Effective from/i), { target: { value: '2026-09-14' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as FixedExpenseInput[]
    expect(next).toHaveLength(2)

    const ended = next.find((r) => r.revisionId === 'rev-1')!
    expect(ended.until).toBe('2026-09-14')
    expect(ended.endedAt).toBeTruthy()
    expect(ended.endedBy).toBe('tester@bcatcorp.com')

    const current = next.find((r) => r.revisionId !== 'rev-1')!
    expect(current.label).toBe('Insurance')
    expect(current.amount).toBe(250)
    expect(current.from).toBe('2026-09-14')
    expect(current.expenseId).toBe('exp-1')
    expect(current.recordedBy).toBe('tester@bcatcorp.com')
  })

  it('ends an active expense and records the actor/timestamp', () => {
    const onChange = vi.fn()
    render(<FixedExpenseEditor value={initialEnd} onChange={onChange} periodDays={7} />)

    fireEvent.click(screen.getByRole('radio'))
    fireEvent.click(screen.getByRole('button', { name: /End/i }))
    fireEvent.change(screen.getByLabelText(/End date/i), { target: { value: '2026-09-21' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as FixedExpenseInput[]
    expect(next).toHaveLength(1)
    expect(next[0].until).toBe('2026-09-21')
    expect(next[0].endedAt).toBeTruthy()
    expect(next[0].endedBy).toBe('tester@bcatcorp.com')
  })

  it('notifies parent of editing state so Save can be disabled during a draft', () => {
    const onEditingChange = vi.fn()
    render(<FixedExpenseEditor value={initialAdd} onChange={vi.fn()} periodDays={7} onEditingChange={onEditingChange} />)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    expect(onEditingChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onEditingChange).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    fireEvent.change(screen.getByPlaceholderText('Insurance'), { target: { value: 'ELD' } })
    fireEvent.change(screen.getByPlaceholderText('250'), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))
    expect(onEditingChange).toHaveBeenLastCalledWith(false)
  })

  it('shows current/scheduled/ended versions in grouped history', () => {
    const { container } = render(<FixedExpenseEditor value={initialHistory} onChange={vi.fn()} periodDays={7} />)

    expect(screen.getByText('ended')).toBeTruthy()
    expect(screen.getByText('current')).toBeTruthy()
    expect(screen.getByText('scheduled')).toBeTruthy()
    expect(container.textContent).toContain('ended')
    expect(container.textContent).toContain('recorded')
  })

  it('hides mileage controls by default and keeps fixed-amount behavior', () => {
    render(<FixedExpenseEditor value={initialAdd} onChange={vi.fn()} periodDays={7} />)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    expect(screen.queryByRole('button', { name: /Mileage calculation/i })).toBeNull()
    expect(screen.getByLabelText(/Amount/i)).toBeTruthy()
  })

  it('shows mileage controls when allowMileage is true', () => {
    render(<FixedExpenseEditor value={initialAdd} onChange={vi.fn()} periodDays={7} allowMileage />)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    expect(screen.getByRole('button', { name: /Fixed amount/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Mileage calculation/i })).toBeTruthy()
  })

  it('adds a mileage-based expense with calculated amount and metadata', () => {
    const onChange = vi.fn()
    render(<FixedExpenseEditor value={initialAdd} onChange={onChange} periodDays={7} allowMileage />)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    fireEvent.change(screen.getByPlaceholderText('Insurance'), { target: { value: 'Mileage reimbursement' } })
    fireEvent.click(screen.getByRole('button', { name: /Mileage calculation/i }))
    fireEvent.change(screen.getByLabelText(/Cost per mile/i), { target: { value: '0.125' } })
    fireEvent.change(screen.getByLabelText(/Miles/i), { target: { value: '2000' } })
    expect((screen.getByLabelText(/Calculated amount/i) as HTMLInputElement).value).toBe('$250.00')
    fireEvent.change(screen.getByLabelText(/Effective from/i), { target: { value: '2026-09-07' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as FixedExpenseInput[]
    expect(next).toHaveLength(1)
    expect(next[0].label).toBe('Mileage reimbursement')
    expect(next[0].amount).toBe(250)
    expect(next[0].mileage).toEqual({ costPerMile: 0.125, miles: 2000 })
    expect(next[0].from).toBe('2026-09-07')
    expect(next[0].recordedBy).toBe('tester@bcatcorp.com')
  })

  it('switches an existing fixed expense to mileage calculation', () => {
    const onChange = vi.fn()
    render(<FixedExpenseEditor value={initialChange} onChange={onChange} periodDays={7} allowMileage />)

    fireEvent.click(screen.getByRole('radio'))
    fireEvent.click(screen.getByRole('button', { name: /Change/i }))
    fireEvent.click(screen.getByRole('button', { name: /Mileage calculation/i }))
    fireEvent.change(screen.getByLabelText(/Cost per mile/i), { target: { value: '0.50' } })
    fireEvent.change(screen.getByLabelText(/Miles/i), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText(/Effective from/i), { target: { value: '2026-09-15' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as FixedExpenseInput[]
    expect(next).toHaveLength(2)

    const current = next.find((r) => r.revisionId !== 'rev-1')!
    expect(current.label).toBe('Insurance')
    expect(current.amount).toBe(50)
    expect(current.mileage).toEqual({ costPerMile: 0.5, miles: 100 })
    expect(current.from).toBe('2026-09-15')

    const ended = next.find((r) => r.revisionId === 'rev-1')!
    expect(ended.until).toBe('2026-09-15')
  })

  it('loads saved mileage values when changing a mileage expense', () => {
    const withMileage: FixedExpenseInput[] = [
      {
        label: 'Mileage reimbursement',
        amount: 250,
        from: '2026-01-01',
        mileage: { costPerMile: 0.125, miles: 2000 },
        revisionId: 'rev-mileage',
        expenseId: 'exp-mileage',
        recordedAt: '2026-01-01T00:00:00Z',
        recordedBy: 'legacy',
      },
    ]
    render(<FixedExpenseEditor value={withMileage} onChange={vi.fn()} periodDays={7} allowMileage />)

    fireEvent.click(screen.getByRole('radio'))
    fireEvent.click(screen.getByRole('button', { name: /Change/i }))

    expect((screen.getByLabelText(/Cost per mile/i) as HTMLInputElement).value).toBe('0.125')
    expect((screen.getByLabelText(/Miles/i) as HTMLInputElement).value).toBe('2000')
  })

  it('rejects garbage input with strict parsing', () => {
    const onChange = vi.fn()
    render(<FixedExpenseEditor value={initialAdd} onChange={onChange} periodDays={7} allowMileage />)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    fireEvent.change(screen.getByPlaceholderText('Insurance'), { target: { value: 'Bad mileage' } })
    fireEvent.click(screen.getByRole('button', { name: /Mileage calculation/i }))
    fireEvent.change(screen.getByLabelText(/Cost per mile/i), { target: { value: '0.1abc' } })
    fireEvent.change(screen.getByLabelText(/Miles/i), { target: { value: 'xyz' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/Enter a valid cost per mile/i)).toBeTruthy()
  })

  it('clears inactive mileage fields when switching modes', () => {
    render(<FixedExpenseEditor value={initialAdd} onChange={vi.fn()} periodDays={7} allowMileage />)

    fireEvent.click(screen.getByRole('button', { name: /Add expense type/i }))
    fireEvent.click(screen.getByRole('button', { name: /Mileage calculation/i }))
    fireEvent.change(screen.getByLabelText(/Cost per mile/i), { target: { value: '0.125' } })
    fireEvent.change(screen.getByLabelText(/Miles/i), { target: { value: '2000' } })
    expect((screen.getByLabelText(/Calculated amount/i) as HTMLInputElement).value).toBe('$250.00')

    fireEvent.click(screen.getByRole('button', { name: /Fixed amount/i }))
    fireEvent.click(screen.getByRole('button', { name: /Mileage calculation/i }))
    expect((screen.getByLabelText(/Cost per mile/i) as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText(/Miles/i) as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText(/Calculated amount/i) as HTMLInputElement).value).toBe('')
  })

  it('a version scheduled to end on a future date still shows as current', () => {
    const endingLater: FixedExpenseInput[] = [
      { label: 'Plates', amount: 50, from: '2026-01-01', until: '2030-06-01', endedAt: '2026-09-01T00:00:00Z', endedBy: 'admin', revisionId: 'r9', expenseId: 'e9', recordedAt: '2026-01-01T00:00:00Z', recordedBy: 'admin' },
      { label: 'Plates', amount: 60, from: '2030-06-01', revisionId: 'r10', expenseId: 'e9', recordedAt: '2026-09-01T00:00:00Z', recordedBy: 'admin' },
    ]
    render(<FixedExpenseEditor value={endingLater} onChange={vi.fn()} periodDays={7} />)
    expect(screen.getByText('current')).toBeTruthy()
    expect(screen.getByText('scheduled')).toBeTruthy()
    expect(screen.queryByText('ended')).toBeNull()
  })
})
