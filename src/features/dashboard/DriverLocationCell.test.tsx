// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DriverLocationCell } from './DriverLocationCell'
import { locationSubtext, type DriverLocation } from '@/lib/driverLocation'

const eld: DriverLocation = { place: 'Gary, IN', source: 'ELD', state: 'MOVING', ageMin: 4, at: '2026-11-18T17:56:00Z', approximate: false }
const stop: DriverLocation = { place: 'Joliet, IL', source: 'LAST_STOP', state: 'LAST_STOP', ageMin: 75, at: '2026-11-18T16:45:00Z', approximate: false }

describe('DriverLocationCell', () => {
  it('column variant: place on top, age underneath, a status dot, and the hover detail', () => {
    render(<DriverLocationCell location={eld} variant="column" />)
    const cell = screen.getByTestId('driver-location')
    expect(cell).toHaveTextContent('Gary, IN')
    expect(cell).toHaveTextContent('4 min ago')
    expect(screen.getByRole('img', { name: 'moving' })).toBeInTheDocument()
    expect(cell.getAttribute('title')).toMatch(/Truck GPS\/ELD/)
  })

  it('line variant (narrow screens): one line with the pin, place, dot and age', () => {
    render(<DriverLocationCell location={eld} variant="line" />)
    const cell = screen.getByTestId('driver-location')
    expect(cell).toHaveTextContent('Gary, IN')
    expect(cell).toHaveTextContent('4 min ago')
    // One flex row: the place and the age are siblings of the same line, not stacked blocks.
    expect(cell.children.length).toBeGreaterThanOrEqual(3)
    expect(cell).toHaveStyle({ display: 'flex' })
  })

  it('says "last stop" when the place is not a live fix', () => {
    expect(locationSubtext(stop)).toBe('last stop · 1 h ago')
    render(<DriverLocationCell location={stop} variant="column" />)
    expect(screen.getByTestId('driver-location')).toHaveTextContent('last stop · 1 h ago')
    expect(screen.getByRole('img', { name: 'last stop' })).toBeInTheDocument()
  })

  it('flags a stale signal', () => {
    render(<DriverLocationCell location={{ ...eld, state: 'STALE', ageMin: 300 }} variant="column" />)
    expect(screen.getByRole('img', { name: 'no recent signal' })).toBeInTheDocument()
    expect(screen.getByTestId('driver-location')).toHaveTextContent('5 h ago')
  })

  it('shows a dash on wide screens and "Location unknown" on narrow ones when there is nothing', () => {
    const { rerender } = render(<DriverLocationCell location={null} variant="column" />)
    expect(screen.getByTestId('driver-location')).toHaveTextContent('—')
    rerender(<DriverLocationCell location={null} variant="line" />)
    expect(screen.getByTestId('driver-location')).toHaveTextContent('Location unknown')
  })
})
