// @vitest-environment jsdom
/** Smoke test: the Schedules page renders its empty day and day navigation moves the date. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/hooks/useLoads', () => ({
  useLoads: () => ({ loads: [] }),
  useEnsureLoadRange: vi.fn(),
}))
vi.mock('@/hooks/useDrivers', () => ({
  useDrivers: () => ({ drivers: [] }),
}))

const refresh = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/store/useAppStore', () => ({ useAppStore: { getState: () => ({ refreshCalendarData: refresh }) } }))

import { SchedulePage } from './SchedulePage'

afterEach(cleanup)

describe('SchedulePage renders', () => {
  it('shows the heading, Today control and empty-day state', () => {
    render(<SchedulePage />)
    expect(screen.getByRole('heading', { name: 'Schedules' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Today' })).toBeTruthy()
    expect(screen.getByText(/No loads scheduled for/)).toBeTruthy()
  })

  it('Next day changes the date and Today returns to it', () => {
    render(<SchedulePage />)
    const title = () => screen.getByText(/No loads scheduled for/).textContent
    const today = title()
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    expect(title()).not.toBe(today)
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(title()).toBe(today)
  })

  it('pulls the open loads and the day\'s window when it opens and when the day changes (so yard-pickup loads and fresh assignments show)', () => {
    refresh.mockClear()
    render(<SchedulePage />)
    expect(refresh).toHaveBeenCalledTimes(1)
    const day = (refresh.mock.calls[0] as unknown as [{ from: string; to: string }])[0]
    expect(day.from).toBe(day.to)
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
