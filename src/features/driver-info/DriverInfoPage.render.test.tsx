// @vitest-environment jsdom
/**
 * Driver info is a thin shell over the truck map and the phone roster; it must mount
 * both under the TMS page frame with its heading.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/features/dashboard/TruckMapWidget', () => ({ TruckMapWidget: () => <div>truck-map-stub</div> }))
vi.mock('./IvanPhones', () => ({ IvanPhones: () => <div>ivan-phones-stub</div> }))

import { DriverInfoPage } from './DriverInfoPage'

describe('DriverInfoPage render', () => {
  it('shows the heading and mounts the truck map and phone roster', () => {
    render(<DriverInfoPage />)
    expect(screen.getByRole('heading', { name: 'Driver info' })).toBeTruthy()
    expect(screen.getByText('truck-map-stub')).toBeTruthy()
    expect(screen.getByText('ivan-phones-stub')).toBeTruthy()
  })
})
