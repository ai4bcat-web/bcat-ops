// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BoardMapView } from './BoardMapView'

const Rows = [
  { id: 's1', stops: [{ lat: 32.7767, lng: -96.797, name: 'Dallas' }, { lat: 29.7604, lng: -95.3698, name: 'Houston' }] },
  { id: 's2', stops: [{ lat: 40.7128, lng: -74.006, name: 'New York' }] },
]

vi.mock('@vis.gl/react-google-maps', () => ({
  APIProvider: ({ children }: { children: ReactNode }) => <div data-testid="api-provider">{children}</div>,
  Map: ({ children }: { children?: ReactNode }) => <div data-testid="google-map">{children}</div>,
  AdvancedMarker: ({ title, onClick }: { title?: string; onClick?: () => void }) => (
    <button data-testid="marker" data-title={title} onClick={onClick} />
  ),
  useMap: () => ({}),
}))

describe('BoardMapView', () => {
  it('shows a plain message when no API key is configured', () => {
    render(<BoardMapView rows={Rows} onOpenShipment={vi.fn()} />)
    expect(screen.getByText(/Map not configured/i)).toBeInTheDocument()
  })

  it('renders markers for every stop and calls onOpenShipment when clicked', () => {
    const onOpenShipment = vi.fn()
    render(<BoardMapView rows={Rows} apiKey="test-key" mapId="test-map" onOpenShipment={onOpenShipment} />)
    expect(screen.getByTestId('api-provider')).toBeInTheDocument()
    const markers = screen.getAllByTestId('marker')
    expect(markers).toHaveLength(3)
    fireEvent.click(markers[0])
    expect(onOpenShipment).toHaveBeenCalledWith('s1')
  })
})
