// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PayModeSection } from './PayModeSection'
import { effectivePayRate, payGroupForWeek } from '@/lib/driverPay'
import type { DriverPaySetting } from '@/lib/apiClient'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const base = (over: Partial<DriverPaySetting> = {}): DriverPaySetting => ({
  id: 's1', driverId: 'd1', payGroup: 'OWNER_OPERATOR', payPercent: 0.88, expensesBeforePercent: true, fixedExpenses: [], rateHistory: [],
  createdAt: '', updatedAt: 'u1', ...over,
} as DriverPaySetting)

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('PayModeSection', () => {
  it('saves one week as Amazon with its own percent and leaves every other week alone', async () => {
    const onSave = vi.fn(async () => {})
    const setting = base()
    render(<PayModeSection setting={setting} today="2026-11-11" onSave={onSave} />)
    // this week (Sun 2026-11-08) is preselected; pick Amazon and a 42% model
    fireEvent.change(screen.getByLabelText('Settles as'), { target: { value: 'AMAZON' } })
    fireEvent.change(screen.getByLabelText('Pay percent for this week'), { target: { value: '42' } })
    fireEvent.click(screen.getByTestId('pay-mode-save'))
    await settle()
    expect(onSave).toHaveBeenCalledTimes(1)
    const [patch, expected] = onSave.mock.calls[0] as unknown as [{ rateHistory: Array<{ from: string; until: string; payGroup?: string; payPercent: number }> }, string]
    expect(expected).toBe('u1')
    expect(patch.rateHistory).toEqual([{ from: '2026-11-08', until: '2026-11-15', payPercent: 0.42, expensesBeforePercent: true, payGroup: 'AMAZON' }])
    // applied to the setting: that week is Amazon at 42%, the week before is untouched
    const after = { ...setting, rateHistory: patch.rateHistory }
    expect(payGroupForWeek(after, '2026-11-08')).toBe('AMAZON')
    expect(effectivePayRate(after, '2026-11-08').payPercent).toBe(0.42)
    expect(payGroupForWeek(after, '2026-11-01')).toBe('OWNER_OPERATOR')
    expect(effectivePayRate(after, '2026-11-01').payPercent).toBe(0.88)
  })

  it('lists the mode history and offers to follow the pay group again for a pinned week', async () => {
    const onSave = vi.fn(async () => {})
    const setting = base({ rateHistory: [{ from: '2026-11-08', until: '2026-11-15', payPercent: 0.42, expensesBeforePercent: false, payGroup: 'AMAZON' }] })
    render(<PayModeSection setting={setting} today="2026-11-11" onSave={onSave} />)
    expect(screen.getByText(/Amazon · 42%/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('pay-mode-clear'))
    await settle()
    const [patch] = onSave.mock.calls[0] as unknown as [{ rateHistory: unknown[] }]
    // the mode goes, the week's pinned rate stays (a rate that matches the base would be dropped too)
    expect(patch.rateHistory).toEqual([{ from: '2026-11-08', until: '2026-11-15', payPercent: 0.42, expensesBeforePercent: false }])
  })

  it('says so when every week follows the pay group', () => {
    render(<PayModeSection setting={base()} today="2026-11-11" onSave={vi.fn(async () => {})} />)
    expect(screen.getByText(/Every week follows/)).toBeTruthy()
  })
})
