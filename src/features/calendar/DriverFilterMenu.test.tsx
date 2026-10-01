// @vitest-environment jsdom
/**
 * The picker decides what the whole board shows, so the behaviour worth pinning is the
 * default — Ivan's drivers on, owner-operators off — and that a group header moves its
 * whole group.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DriverFilterMenu } from './DriverFilterMenu'
import { defaultVisibleDriverIds, type FilterableDriver } from '@/lib/calendarDrivers'

const driver = (over: Partial<FilterableDriver>): FilterableDriver =>
  ({ id: 'd', name: 'Driver', active: true, ...over } as FilterableDriver)

const DRIVERS = [
  driver({ id: 'ivan-1', name: 'Alvaro', fleetGroup: 'LOCAL' }),
  driver({ id: 'ivan-2', name: 'Bruno', fleetGroup: 'BOX_TRUCK' }),
  driver({ id: 'oo-1', name: 'Chad', fleetGroup: 'AMAZON' }),
  driver({ id: 'oo-2', name: 'Dina', driverType: 'OWNER_OPERATOR' }),
  driver({ id: 'bk-1', name: 'BROKER COVERED', type: 'broker' }),
]

/**
 * Radix opens on pointer events, which jsdom does not implement, and it probes a few
 * APIs jsdom lacks. Keyboard activation is the supported path that works here.
 */
function openMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: /Drivers shown/ }), { key: 'Enter' })
}

function open(visible: string[], onChange = vi.fn()) {
  render(
    <DriverFilterMenu
      drivers={DRIVERS}
      visibleDriverIds={new Set(visible)}
      onChange={onChange}
    />,
  )
  openMenu()
  return onChange
}

beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
})

describe('DriverFilterMenu', () => {
  it('summarises the default state in words, not a count', () => {
    render(
      <DriverFilterMenu
        drivers={DRIVERS}
        visibleDriverIds={new Set(defaultVisibleDriverIds(DRIVERS))}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Drivers shown: Ivan drivers' })).toBeInTheDocument()
  })

  it('shows Ivan drivers checked and owner operators unchecked by default', () => {
    open(defaultVisibleDriverIds(DRIVERS))

    expect(screen.getByRole('menuitemcheckbox', { name: 'Alvaro' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Bruno' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Chad' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Dina' })).toHaveAttribute('aria-checked', 'false')
  })

  it('never offers a broker pseudo-driver', () => {
    // BROKER COVERED carries loads but is nobody to filter by.
    open(defaultVisibleDriverIds(DRIVERS))
    expect(screen.queryByRole('menuitemcheckbox', { name: 'BROKER COVERED' })).toBeNull()
  })

  it('turns one driver on without disturbing the rest', () => {
    const onChange = open(['ivan-1', 'ivan-2'])
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Chad' }))
    expect(onChange).toHaveBeenCalledWith(['ivan-1', 'ivan-2', 'oo-1'])
  })

  it('turns a driver off again', () => {
    const onChange = open(['ivan-1', 'ivan-2'])
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Bruno' }))
    expect(onChange).toHaveBeenCalledWith(['ivan-1'])
  })

  it('switches a whole group on from its header', () => {
    const onChange = open(['ivan-1', 'ivan-2'])
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Owner operators \(2\)/ }))
    expect(onChange).toHaveBeenCalledWith(['ivan-1', 'ivan-2', 'oo-1', 'oo-2'])
  })

  it('switches a fully-on group back off from its header', () => {
    const onChange = open(['ivan-1', 'ivan-2'])
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Ivan drivers \(2\)/ }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('offers show-all and show-none shortcuts', () => {
    const onChange = open(['ivan-1'])

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(onChange).toHaveBeenCalledWith(['ivan-1', 'ivan-2', 'oo-1', 'oo-2'])

    fireEvent.click(screen.getByRole('button', { name: 'Show none' }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('says so rather than rendering an empty menu with no drivers', () => {
    render(<DriverFilterMenu drivers={[]} visibleDriverIds={new Set()} onChange={vi.fn()} />)
    openMenu()
    expect(screen.getByText('No active drivers to filter.')).toBeInTheDocument()
  })
})
