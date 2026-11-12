// @vitest-environment jsdom
/** The driver's time-off form: what it sends, what it refuses, what the list says. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const api = { fetchTimeOff: vi.fn(), requestTimeOff: vi.fn() }
vi.mock('../driverApi', () => api)
const { TimeOffSection } = await import('./TimeOffSection')

const TODAY = '2026-11-06'
const state = (over: Record<string, unknown> = {}) => ({
  requests: [], ptoEligible: false, ptoUsed: { year: '2026', days: 0 }, ...over,
})
const row = (over: Record<string, unknown>) => ({
  id: 'r', type: 'FULL_DAY_OFF', startDate: '2026-11-10', endDate: '2026-11-10', hours: 8,
  note: null, status: 'PENDING', reviewNote: null, reviewedAt: null, createdAt: null, ...over,
})

async function renderSection(s = state(), readOnly = false) {
  api.fetchTimeOff.mockResolvedValue(s)
  render(<TimeOffSection today={TODAY} readOnly={readOnly} refreshKey={0} />)
  await screen.findByLabelText('Type')
}
const set = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => {
  vi.clearAllMocks()
  api.requestTimeOff.mockResolvedValue({ ok: true })
})

describe('the request form', () => {
  it('offers no PTO to a driver without it, but takes a day off in hours', async () => {
    await renderSection()
    expect(screen.queryByRole('option', { name: 'PTO' })).toBeNull()
    expect(screen.queryByText(/PTO/)).toBeNull()
    set('First day', '2026-11-12')
    set('Last day', '2026-11-12')
    set('Hours', '4')
    set('Note (optional)', 'dentist')
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }))
    await waitFor(() => expect(api.requestTimeOff).toHaveBeenCalledWith({
      type: 'FULL_DAY_OFF', startDate: '2026-11-12', endDate: '2026-11-12', hours: 4, note: 'dentist',
    }))
    await waitFor(() => expect(api.fetchTimeOff).toHaveBeenCalledTimes(2))
  })

  it('sends PTO as one eight-hour day', async () => {
    await renderSection(state({ ptoEligible: true, ptoRemaining: { year: '2026', days: 5 } }))
    set('Type', 'PTO')
    expect(screen.queryByLabelText('Last day')).toBeNull()
    expect((screen.getByLabelText('Hours') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/PTO is a full 8-hour day/)).toBeTruthy()
    const date = screen.getByLabelText('Date') as HTMLInputElement
    expect(date.min).toBe('2026-10-07')
    expect(date.max).toBe('2026-11-20')
    set('Date', '2026-11-03')
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }))
    await waitFor(() => expect(api.requestTimeOff).toHaveBeenCalledWith({
      type: 'PTO', startDate: '2026-11-03', endDate: '2026-11-03', hours: 8,
    }))
  })

  it('refuses a bad request before sending it', async () => {
    await renderSection()
    set('First day', '2026-11-01')
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/start today or later/)
    expect(api.requestTimeOff).not.toHaveBeenCalled()
  })

  it('shows the server’s message when it says no', async () => {
    api.requestTimeOff.mockRejectedValue(new Error('You already have a request for Nov 6'))
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/already have a request for Nov 6/)
  })

  it('is disabled for staff viewing as a driver', async () => {
    await renderSection(state(), true)
    expect(screen.getByText('Read-only while viewing as a driver')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Submit request' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the list', () => {
  it('shows each status, the office’s note and the year’s PTO', async () => {
    await renderSection(state({
      ptoEligible: true,
      ptoUsed: { year: '2026', days: 3 },
      ptoRemaining: { year: '2026', days: 2 },
      requests: [
        row({ id: 'a', status: 'PENDING' }),
        row({ id: 'b', status: 'APPROVED', type: 'PTO', startDate: '2026-11-03', endDate: '2026-11-03' }),
        row({ id: 'c', status: 'DENIED', reviewNote: 'Short on drivers that week' }),
      ],
    }))
    expect(screen.getByText('Pending')).toBeTruthy()
    expect(screen.getByText('Approved')).toBeTruthy()
    expect(screen.getByText('Denied')).toBeTruthy()
    expect(screen.getByText(/Short on drivers that week/)).toBeTruthy()
    expect(screen.getByText(/PTO left in 2026/).textContent).toBe('PTO left in 2026: 2 days')
  })

  it('hides the PTO count from a driver with no PTO', async () => {
    await renderSection()
    expect(screen.queryByText(/PTO left in|PTO used in/)).toBeNull()
  })
})
