// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const fetchTracking = vi.hoisted(() => vi.fn())

vi.mock('@/lib/trackingClient', () => ({
  fetchTracking,
  TrackingError: class TrackingError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))
vi.mock('@/features/dashboard/FleetMiniMap', () => ({ FleetMiniMap: () => <div data-testid="mini-map" /> }))

import { TrackPage } from './TrackPage'

const renderAt = () =>
  render(
    <MemoryRouter initialEntries={['/track/abc']}>
      <Routes>
        <Route path="/track/:code" element={<TrackPage />} />
        <Route path="*" element={<div>redirected</div>} />
      </Routes>
    </MemoryRouter>,
  )

describe('TrackPage', () => {
  it('shows the truck on a public frame with no sign-in redirect', async () => {
    fetchTracking.mockResolvedValue({
      unit: '27', driver: 'Dana Fox', generatedAt: '2026-11-03T10:00:00Z',
      position: { lat: 41.9, lon: -87.6, locatedAt: '2026-11-03T09:55:00Z', description: 'Joliet, IL' },
      load: { lane: 'Chicago → Dallas', pro: '55501', eta: null },
    })
    const { container } = renderAt()
    expect(await screen.findByRole('heading', { name: 'Truck 27' })).toBeTruthy()
    expect(container.querySelector('.tms-public')).toBeTruthy()
    expect(screen.getByText('Dana Fox')).toBeTruthy()
    expect(screen.getByText(/Chicago → Dallas · PRO 55501/)).toBeTruthy()
    expect(screen.queryByText('redirected')).toBeNull()
  })

  it('explains a dead link instead of showing an empty page', async () => {
    const { TrackingError } = await import('@/lib/trackingClient')
    fetchTracking.mockRejectedValue(new TrackingError(404, 'nope'))
    renderAt()
    expect(await screen.findByText(/no longer active/)).toBeTruthy()
  })
})
