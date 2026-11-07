// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const api = vi.hoisted(() => ({
  listTimeClockEntries: vi.fn(),
  correctTimeClockEntry: vi.fn(),
  listDriverPaySettings: vi.fn(),
  createDriverPaySetting: vi.fn(),
  updateDriverPaySetting: vi.fn(),
  createAuditLog: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('@/lib/staffMotiveDays', () => ({ fetchMotiveDays: vi.fn().mockResolvedValue({}) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const auth = vi.hoisted(() => ({ pay: true }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'ryne@bcatcorp.com', userId: 'u', groups: [] }, hasPageAccess: (k: string) => k !== 'driverPay' || auth.pay }),
}))
vi.mock('@/hooks/useDrivers', () => ({
  useDrivers: () => ({
    drivers: [
      { id: 'a', name: 'Ann Lee', fleetGroup: 'LOCAL', active: true, type: 'driver' },
      { id: 'b', name: 'Bob Ray', fleetGroup: 'LOCAL', active: true, type: 'driver' },
    ],
  }),
}))

const { HoursPage } = await import('./HoursPage')

const entry = (id: string, driverId: string, workDate: string, kind: string, minutes: number) =>
  ({ id, driverId, workDate, kind, minutes, clockInAt: null, clockOutAt: null, source: 'DRIVER' })

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-20T17:00:00Z'))   // inside the 2026-10-12 period
  auth.pay = true
  api.listTimeClockEntries.mockResolvedValue([
    entry('1', 'a', '2026-10-12', 'WORK', 480), entry('2', 'a', '2026-10-13', 'PTO', 480), entry('3', 'b', '2026-10-12', 'WORK', 240),
  ])
  api.listDriverPaySettings.mockResolvedValue([
    { id: 'ps-a', driverId: 'a', payGroup: 'LOCAL', payPercent: 0, expensesBeforePercent: false, hourlyRate: 25, hourlyRateHistory: [], updatedAt: '2026-10-01T00:00:00Z', createdAt: '' },
  ])
  api.createAuditLog.mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

describe('HoursPage', () => {
  it('shows each driver collapsed with hours and 2-week pay, and a dash and Set rate where there is no rate', async () => {
    render(<HoursPage />)
    const ann = await screen.findByRole('region', { name: 'Ann Lee' })
    expect(await within(ann).findByText('$400.00')).toBeTruthy()          // 16h x $25
    const bob = screen.getByRole('region', { name: 'Bob Ray' })
    expect(within(bob).getByRole('button', { name: 'Set rate' })).toBeTruthy()
    expect(screen.queryByRole('table', { name: 'Ann Lee day by day' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Ann Lee' }))
    expect(screen.getByRole('table', { name: 'Ann Lee day by day' })).toBeTruthy()
  })

  it('without pay access it is hours only and no rate is ever requested', async () => {
    auth.pay = false
    render(<HoursPage />)
    await screen.findByRole('region', { name: 'Ann Lee' })
    expect(api.listDriverPaySettings).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/\$|Rate|2-week pay|Set rate/)
  })

  it('a first rate creates a LOCAL pay setting for a driver with none, effective from the period start, and audits it', async () => {
    api.createDriverPaySetting.mockImplementation(async (input) => ({ ...input, id: 'ps-b', updatedAt: 't', createdAt: '' }))
    render(<HoursPage />)
    const bob = await screen.findByRole('region', { name: 'Bob Ray' })
    fireEvent.click(within(bob).getByRole('button', { name: 'Set rate' }))
    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '21' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }))
    await waitFor(() => expect(api.createDriverPaySetting).toHaveBeenCalledTimes(1))
    expect(api.createDriverPaySetting.mock.calls[0][0]).toMatchObject({ driverId: 'b', payGroup: 'LOCAL', payPercent: 0, hourlyRate: 21 })
    expect(api.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'Driver', entityId: 'b', user: 'ryne@bcatcorp.com' }))
    expect(await within(screen.getByRole('region', { name: 'Bob Ray' })).findByText('$84.00')).toBeTruthy()   // 4h x $21
  })

  it('a raise on a driver with a rate updates their setting, keeping the old rate as a closed window', async () => {
    api.updateDriverPaySetting.mockImplementation(async (id, patch) => ({ id, driverId: 'a', ...patch, updatedAt: 't2', createdAt: '' }))
    render(<HoursPage />)
    const ann = await screen.findByRole('region', { name: 'Ann Lee' })
    fireEvent.click(within(ann).getByRole('button', { name: 'Edit Ann Lee hourly rate' }))
    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2026-10-19' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }))
    await waitFor(() => expect(api.updateDriverPaySetting).toHaveBeenCalledTimes(1))
    const [id, patch, expected] = api.updateDriverPaySetting.mock.calls[0]
    expect(id).toBe('ps-a')
    expect(expected).toBe('2026-10-01T00:00:00Z')
    expect(patch).toMatchObject({ hourlyRate: 30, hourlyRateHistory: [{ from: '1970-01-01', until: '2026-10-19', hourlyRate: 25, endedBy: 'ryne@bcatcorp.com' }] })
    // Days before 10/19 keep $25: the period's pay does not move.
    expect(await within(screen.getByRole('region', { name: 'Ann Lee' })).findByText('$400.00')).toBeTruthy()
  })

  it('a failed rates load shows a banner, offers no Set rate for anyone, and recovers on Try again', async () => {
    api.listDriverPaySettings.mockRejectedValueOnce(new Error('network down'))
    render(<HoursPage />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Hourly rates could not be loaded: network down/)
    expect(screen.queryByRole('button', { name: 'Set rate' })).toBeNull()
    expect(screen.queryByRole('button', { name: /hourly rate/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    const ann = await screen.findByRole('region', { name: 'Ann Lee' })
    expect(await within(ann).findByText('$400.00')).toBeTruthy()
    expect(screen.queryByText(/could not be loaded/)).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Bob Ray' })).getByRole('button', { name: 'Set rate' })).toBeTruthy()
  })
})
