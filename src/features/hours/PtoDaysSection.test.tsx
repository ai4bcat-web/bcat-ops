// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const api = vi.hoisted(() => ({
  listTimeClockEntries: vi.fn(),
  createTimeClockEntry: vi.fn(),
  deleteTimeClockEntry: vi.fn(),
  correctTimeClockEntry: vi.fn(),
  createDriverAvailability: vi.fn(),
  deleteDriverAvailability: vi.fn(),
  updateDriverAvailability: vi.fn(),
  listDriverAvailabilities: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { PtoDaysSection } = await import('./PtoDaysSection')

const drivers = [
  { id: 'a', name: 'Ann Lee', ptoEligible: false },
  { id: 'j', name: 'Jason Smith', ptoEligible: true, hireDate: '2024-06-10' },
  { id: 'n', name: 'New Hire', ptoEligible: true, hireDate: '2026-01-05' },
]
const pto = (id: string, driverId: string, workDate: string, minutes = 480, note = 'PTO entered by ruben@bcatcorp.com') =>
  ({ id, driverId, workDate, kind: 'PTO', minutes, note, source: 'STAFF', clockInAt: null, clockOutAt: null })

const renderIt = (onChanged = vi.fn()) =>
  render(<PtoDaysSection drivers={drivers} staffEmail="ryne@bcatcorp.com" today="2026-11-11" onChanged={onChanged} />)

beforeEach(() => {
  vi.clearAllMocks()
  api.listTimeClockEntries.mockResolvedValue([
    pto('1', 'j', '2026-03-02'), pto('2', 'j', '2026-03-03', 240, 'half day (PTO entered by ruben@bcatcorp.com)'), pto('3', 'a', '2026-10-13'),
    { id: '9', driverId: 'a', workDate: '2026-10-12', kind: 'WORK', minutes: 480 },
  ])
  api.createTimeClockEntry.mockImplementation(async (i) => ({ ...i, id: `new-${i.workDate}` }))
  api.createDriverAvailability.mockResolvedValue({ id: 'av' })
  api.listDriverAvailabilities.mockResolvedValue([
    { id: 'av-1', driverId: 'j', type: 'PTO', startDate: '2026-03-02', endDate: '2026-03-02' },
  ])
  api.deleteTimeClockEntry.mockResolvedValue(undefined)
  api.deleteDriverAvailability.mockResolvedValue(undefined)
  api.correctTimeClockEntry.mockResolvedValue({})
  api.updateDriverAvailability.mockResolvedValue({})
})

describe('PtoDaysSection', () => {
  it('lists only PTO days, newest first, with each driver\'s days and hours for the year', async () => {
    renderIt()
    const table = await screen.findByRole('table', { name: 'PTO days taken' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toMatch(/Oct 13, 2026.*Ann Lee/)
    expect(screen.getByLabelText('PTO used in 2026').textContent).toMatch(/Jason Smith: 2 days · 12 h/)
    expect(screen.getByLabelText('PTO used in 2026').textContent).toMatch(/Ann Lee: 1 day · 8 h/)
  })

  it('shows each driver\'s allowance by tenure beside the days taken', async () => {
    renderIt()
    await screen.findByRole('table', { name: 'PTO days taken' })
    const chips = screen.getByLabelText('PTO used in 2026').textContent ?? ''
    expect(chips).toMatch(/Jason Smith: 2 days · 12 h · 0 of 10 used, 10 left/)
    expect(chips).toMatch(/Ann Lee: 1 day · 8 h · No hire date/)
    expect(chips).toMatch(/New Hire: 0 days · 0 h · no allowance yet \(first year\)/)
  })

  it('previews the balance in the add dialog, warns (without blocking) for a first-year driver and for no hire date', async () => {
    renderIt()
    await screen.findByRole('table', { name: 'PTO days taken' })
    fireEvent.click(screen.getByRole('button', { name: /Add PTO days/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '2026-11-16' } })
    fireEvent.change(within(dialog).getByLabelText('To'), { target: { value: '2026-11-16' } })
    expect(within(dialog).getByTestId('pto-balance').textContent).toMatch(/Uses 1 of 10 days.*9 left/)
    fireEvent.change(within(dialog).getByLabelText('Driver'), { target: { value: 'n' } })
    expect(within(dialog).getByTestId('pto-balance').textContent).toMatch(/first year of service.*no PTO allowance yet.*You can still add it/)
    expect((within(dialog).getByRole('button', { name: 'Add day' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(within(dialog).getByLabelText('Driver'), { target: { value: 'a' } })
    expect(within(dialog).getByTestId('pto-balance').textContent).toMatch(/No hire date/)
  })

  it('filters by driver and by month', async () => {
    renderIt()
    await screen.findByRole('table', { name: 'PTO days taken' })
    fireEvent.change(screen.getAllByRole('combobox').find((s) => (s as HTMLSelectElement).value === '' && within(s as HTMLElement).queryByText('All drivers'))!, { target: { value: 'j' } })
    expect(within(screen.getByRole('table', { name: 'PTO days taken' })).getAllByRole('row').slice(1)).toHaveLength(2)
    fireEvent.change(screen.getByDisplayValue('Whole year'), { target: { value: '10' } })
    expect(screen.getByText('No PTO days match.')).toBeTruthy()
  })

  it('adds a range as one paid time-clock day plus one approved calendar day each, skipping weekends and existing PTO', async () => {
    const onChanged = vi.fn()
    renderIt(onChanged)
    await screen.findByRole('table', { name: 'PTO days taken' })
    fireEvent.click(screen.getByRole('button', { name: /Add PTO days/ }))
    const dialog = await screen.findByRole('dialog')
    // Jason (eligible) is first in the picker.
    expect((within(dialog).getByLabelText('Driver') as HTMLSelectElement).value).toBe('j')
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '2026-03-02' } })   // Mon, already has PTO
    fireEvent.change(within(dialog).getByLabelText('To'), { target: { value: '2026-03-06' } })      // Fri
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: 'Family trip' } })
    expect(within(dialog).getByRole('status').textContent).toMatch(/Adds 3 days · 24 h.*skipping 2 that already have PTO/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 3 days' }))
    await waitFor(() => expect(api.createTimeClockEntry).toHaveBeenCalledTimes(3))
    expect(api.createTimeClockEntry.mock.calls.map((c) => c[0].workDate)).toEqual(['2026-03-04', '2026-03-05', '2026-03-06'])
    expect(api.createTimeClockEntry.mock.calls[0][0]).toMatchObject({ driverId: 'j', kind: 'PTO', minutes: 480, source: 'STAFF', clockInAt: null })
    expect(api.createTimeClockEntry.mock.calls[0][0].note).toBe('Family trip (PTO entered by ryne@bcatcorp.com)')
    expect(api.createDriverAvailability).toHaveBeenCalledTimes(3)
    expect(api.createDriverAvailability.mock.calls[0][0]).toMatchObject({ driverId: 'j', type: 'PTO', status: 'APPROVED', source: 'STAFF', hours: 8, reviewedBy: 'ryne@bcatcorp.com' })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('backfills other dates and takes the hours per day', async () => {
    renderIt()
    await screen.findByRole('table', { name: 'PTO days taken' })
    fireEvent.click(screen.getByRole('button', { name: /Add PTO days/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Driver'), { target: { value: 'a' } })
    fireEvent.change(within(dialog).getByLabelText('Other dates (optional)'), { target: { value: '2026-01-05, 2026-01-06' } })
    fireEvent.change(within(dialog).getByLabelText('Hours per day'), { target: { value: '4' } })
    // The range defaults to today (Wed 2026-11-11), so three days: the two backfilled and today.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 3 days' }))
    await waitFor(() => expect(api.createTimeClockEntry).toHaveBeenCalledTimes(3))
    expect(api.createTimeClockEntry.mock.calls.map((c) => c[0].minutes)).toEqual([240, 240, 240])
  })

  it('rolls the time-clock day back when the calendar write fails, so the two never disagree', async () => {
    api.createDriverAvailability.mockRejectedValueOnce(new Error('calendar down'))
    renderIt()
    await screen.findByRole('table', { name: 'PTO days taken' })
    fireEvent.click(screen.getByRole('button', { name: /Add PTO days/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add day' }))
    await waitFor(() => expect(api.deleteTimeClockEntry).toHaveBeenCalledWith('new-2026-11-11'))
  })

  it('removes a day from the time card and its calendar row after a confirmation', async () => {
    renderIt()
    await screen.findByRole('table', { name: 'PTO days taken' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove PTO 2026-03-02 Jason Smith' }))
    const dialog = await screen.findByRole('dialog')
    expect(api.deleteTimeClockEntry).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.deleteTimeClockEntry).toHaveBeenCalledWith('1'))
    await waitFor(() => expect(api.deleteDriverAvailability).toHaveBeenCalledWith('av-1'))
  })

  it('edits hours on the record, signed, and updates the calendar row', async () => {
    renderIt()
    await screen.findByRole('table', { name: 'PTO days taken' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit PTO 2026-03-02 Jason Smith' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Hours'), { target: { value: '6' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.correctTimeClockEntry).toHaveBeenCalledTimes(1))
    expect(api.correctTimeClockEntry.mock.calls[0][1]).toMatchObject({ minutes: 360 })
    expect(api.correctTimeClockEntry.mock.calls[0][2]).toBe('ryne@bcatcorp.com')
    await waitFor(() => expect(api.updateDriverAvailability).toHaveBeenCalledWith('av-1', expect.objectContaining({ hours: 6 })))
  })
})
