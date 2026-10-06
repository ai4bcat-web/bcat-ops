// @vitest-environment jsdom
/**
 * The PM bar. What matters is that it never implies a position it does not know, and that
 * its colours agree with the fleet manager's dashboard — a driver and the office looking at
 * the same truck should not see different warnings.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PmGauge } from './PmGauge'
import { PM_INTERVAL_MI } from '@/lib/pmDue'
import type { DriverPm } from '../driverApi'

const pm = (over: Partial<DriverPm> = {}): DriverPm => ({
  state: 'OK',
  nextDueAt: 125_000,
  remaining: 15_000,
  currentOdometer: 110_000,
  lastPmMileage: 100_000,
  lastPmDate: '2026-08-01',
  label: 'Next PM in 15,000 mi — at 125,000 mi',
  truckNumber: '009',
  ...over,
})

describe('the bar', () => {
  it('fills to the share of the interval used', () => {
    // 10,000 of 25,000 miles used.
    render(<PmGauge pm={pm()} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('10000')
    expect(bar.getAttribute('aria-valuemax')).toBe(String(PM_INTERVAL_MI))
  })

  it('fills completely rather than overflowing when overdue', () => {
    render(<PmGauge pm={pm({ state: 'OVERDUE', remaining: -3_000 })} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(String(PM_INTERVAL_MI))
  })

  it('shows empty rather than negative when the odometer reads below the last PM', () => {
    // A replaced ECM or a bad reading; a negative bar would be nonsense.
    render(<PmGauge pm={pm({ remaining: PM_INTERVAL_MI + 5_000 })} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
  })

  it('draws NO bar when the position is unknown', () => {
    /*
     * An empty bar reads as "nearly new". A truck with no last PM on file, or none Motive
     * has reported on, gets the sentence and nothing else.
     */
    render(<PmGauge pm={pm({ state: 'UNKNOWN', remaining: null, nextDueAt: null, label: 'Next PM not scheduled — no last PM on file for this truck' })} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText(/not scheduled/)).toBeTruthy()
  })
})

describe('what it says', () => {
  it('leads with the miles remaining', () => {
    render(<PmGauge pm={pm()} />)
    expect(screen.getByText('15,000 mi to next PM')).toBeTruthy()
  })

  it('leads with how far overdue it is', () => {
    render(<PmGauge pm={pm({ state: 'OVERDUE', remaining: -1_500 })} />)
    expect(screen.getByText('PM overdue by 1,500 mi')).toBeTruthy()
  })

  it('carries the truck, the odometer and when the PM falls due', () => {
    render(<PmGauge pm={pm()} />)
    expect(screen.getByText(/Truck 009/)).toBeTruthy()
    expect(screen.getByText(/110,000 mi/)).toBeTruthy()
    expect(screen.getByText(/due at 125,000/)).toBeTruthy()
    expect(screen.getByText(/last PM 2026-08-01/)).toBeTruthy()
  })
})
