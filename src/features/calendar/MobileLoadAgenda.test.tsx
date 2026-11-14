// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MobileLoadAgenda } from './MobileLoadAgenda'
import type { Load } from '@/types'

const load = (over: Partial<Load>): Load => ({ id: 'x', aljexId: '1', tmsId: '', pickupDriverId: null, deliveryDriverId: null, ...over }) as Load
// Noon local, so the Chicago date is the date written.
const day = (d: number) => new Date(2026, 10, d, 12)

describe('MobileLoadAgenda', () => {
  const loads = [
    load({ id: 'a', aljexId: '20031', pickupAppt: '2026-11-16T16:00:00Z', deliveryAppt: '2026-11-16T20:00:00Z' }),
    load({ id: 'b', aljexId: '20039', pickupAppt: '2026-11-18T16:00:00Z', deliveryAppt: '2026-11-18T20:00:00Z' }),
  ]

  it('shows a week as one heading per day with that day\'s cards, empty days included', () => {
    render(<MobileLoadAgenda loads={loads} drivers={[]} days={[day(16), day(17), day(18)]} />)
    expect(screen.getAllByTestId('calendar-list-day')).toHaveLength(3)
    expect(screen.getAllByTestId('calendar-list-card').map((c) => c.textContent)).toEqual([
      expect.stringContaining('20031'), expect.stringContaining('20039'),
    ])
    expect(screen.getByText('No loads')).toBeTruthy()
  })

  it('skips empty days for a month', () => {
    render(<MobileLoadAgenda loads={loads} drivers={[]} days={[day(16), day(17), day(18)]} skipEmptyDays />)
    expect(screen.getAllByTestId('calendar-list-day')).toHaveLength(2)
  })
})
