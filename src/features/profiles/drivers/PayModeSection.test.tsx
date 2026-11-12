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
  it('flags a week that still has Amazon trips (overlap) for an Amazon-group driver, and says what it is; other weeks show a list', () => {
    const amazon = base({ payGroup: 'AMAZON' })
    render(<PayModeSection setting={amazon} today="2026-11-11" onSave={vi.fn(async () => {})} amazonWeeks={new Set(['2026-10-04'])} />)
    // the open week (this week) has no Amazon trips: no inline note, but the overlap week is listed
    expect(screen.queryByTestId('pay-mode-overlap')).toBeNull()
    expect(screen.getByTestId('pay-mode-overlap-weeks').textContent).toContain('Amazon trips this week: confirm pay mode')
    expect(screen.getByTestId('pay-mode-overlap-weeks').textContent).toContain('Oct 4, 2026')
    fireEvent.change(screen.getByLabelText('Week'), { target: { value: '2026-10-04' } })
    expect(screen.getByTestId('pay-mode-overlap').textContent).toContain('stays on the Amazon statement')
    // an unflagged week defaults to the standard owner operator from the changeover
    expect((screen.getByLabelText('Settles as') as HTMLSelectElement).value).toBe('AMAZON')
    fireEvent.change(screen.getByLabelText('Week'), { target: { value: '2026-10-11' } })
    expect((screen.getByLabelText('Settles as') as HTMLSelectElement).value).toBe('OWNER_OPERATOR')
  })

  it('never flags a pinned week or an owner-operator-group driver', () => {
    const oo = base()
    render(<PayModeSection setting={oo} today="2026-11-11" onSave={vi.fn(async () => {})} amazonWeeks={new Set(['2026-10-04'])} />)
    expect(screen.queryByTestId('pay-mode-overlap-weeks')).toBeNull()
  })
})
