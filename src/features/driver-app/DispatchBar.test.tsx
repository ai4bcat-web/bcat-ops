// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { DriverProfile } from './driverApi'

let profile: Partial<DriverProfile> | null = null
vi.mock('./useDriverProgram', () => ({ useDriverProfile: () => profile }))

const { DispatchBar } = await import('./DispatchBar')

beforeEach(() => { profile = null })

describe('driver app header', () => {
  it('shows the truck work phone with its truck number and a tel link', () => {
    profile = { dispatchPhone: '+13125550100', workPhone: { number: '+13125550142', label: 'Cab phone', truckNumber: '12' } }
    render(<DispatchBar />)
    const line = screen.getByTestId('driver-work-phone')
    expect(line.textContent).toContain('Work phone · truck 12 · Cab phone')
    expect(line.querySelector('a')?.getAttribute('href')).toBe('tel:+13125550142')
    // The dispatch line is still there beneath it.
    expect(screen.getByText('Dispatch')).toBeTruthy()
  })

  it('renders as before when the truck has no work phone', () => {
    profile = { dispatchPhone: '+13125550100', workPhone: null }
    render(<DispatchBar />)
    expect(screen.queryByTestId('driver-work-phone')).toBeNull()
    expect(screen.getByText('Dispatch')).toBeTruthy()
  })

  it('renders nothing for an older API with no phones at all', () => {
    profile = {}
    const { container } = render(<DispatchBar />)
    expect(container.firstChild).toBeNull()
  })
})
