// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { CustomerTrackingView } from '@/types/tms'

const fetchCustomerTracking = vi.hoisted(() => vi.fn())

vi.mock('@/lib/trackingClient', () => ({
  TRACKING_API_URL: 'https://tracking.example',
  TrackingError: class TrackingError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
  fetchCustomerTracking,
  fetchCarrierTracking: vi.fn(),
  postTrackingPing: vi.fn(),
}))

const { CustomerTrackPage } = await import('./CustomerTrackPage')

const VIEW: CustomerTrackingView = {
  broker: { name: 'BCAT Logistics' },
  number: 'S-1001',
  status: 'IN_TRANSIT',
  statusLabel: 'In transit',
  stops: [
    { id: 'st-1', type: 'pickup', sequence: 1, name: 'Shipper', city: 'Joliet', state: 'IL', appt: '2026-10-20T14:00:00.000Z', apptEnd: null, arrivedAt: '2026-10-20T13:50:00.000Z', departedAt: '2026-10-20T15:10:00.000Z', references: [] },
    { id: 'st-2', type: 'delivery', sequence: 2, name: 'Consignee', city: 'Dallas', state: 'TX', appt: '2026-10-22T09:00:00.000Z', apptEnd: null, arrivedAt: null, departedAt: null, references: [] },
  ],
  references: [{ code: 'PO', label: 'PO', value: '99-12' }],
  eta: '2026-10-22T08:30:00.000Z',
  position: { lat: 38.4, lng: -92.1, at: '2026-10-21T12:00:00.000Z', description: 'Columbia, MO' },
  lastUpdate: { at: '2026-10-21T12:00:00.000Z', type: 'LOCATION_UPDATE' },
  contact: { name: 'Dana Reed', email: 'dana@bcat.com', phone: '(224) 875-6477' },
  generatedAt: '2026-10-21T12:05:00.000Z',
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/track/s/Hq3Zn7Lp0vWx9TbKcRdYu1Ms4Ae6Gi2J']}>
      <Routes><Route path="/track/s/:token" element={<CustomerTrackPage />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchCustomerTracking.mockResolvedValue(VIEW)
})

describe('CustomerTrackPage', () => {
  it('shows the shipment, its stops and the contact desk', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText('Shipment S-1001')).toBeTruthy())
    expect(screen.getByText('Joliet, IL')).toBeTruthy()
    expect(screen.getByText('Dallas, TX')).toBeTruthy()
    expect(screen.getByText('Dana Reed')).toBeTruthy()
    expect(container.textContent).toContain('PO 99-12')
    expect(screen.getByTestId('tracking-map')).toBeTruthy()
  })

  it('prints nothing about the carrier when the link hides it', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText('Shipment S-1001')).toBeTruthy())
    expect(container.textContent).not.toContain('Carrier')
    expect(container.textContent).not.toContain('Blue Sky Trucking')
  })

  it('names the carrier when the link was minted to show it', async () => {
    fetchCustomerTracking.mockResolvedValue({ ...VIEW, carrier: { name: 'Blue Sky Trucking' } })
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText('Blue Sky Trucking')).toBeTruthy())
    expect(container.textContent).toContain('Carrier')
  })

  it('drops the map entirely when the link hides position', async () => {
    const { position: _hidden, ...noPosition } = VIEW
    fetchCustomerTracking.mockResolvedValue(noPosition)
    renderPage()
    await waitFor(() => expect(screen.getByText('Shipment S-1001')).toBeTruthy())
    expect(screen.queryByTestId('tracking-map')).toBeNull()
  })

  it('draws the thinned trail on the map in fallback mode, with the position as the marker', async () => {
    fetchCustomerTracking.mockResolvedValue({
      ...VIEW,
      map: {
        stops: [{ type: 'pickup', lat: 41.5, lng: -88.1 }, { type: 'delivery', lat: 32.8, lng: -96.8 }],
        route: null,
        trail: [
          { lat: 41.5, lng: -88.1, at: '2026-10-21T08:00:00.000Z' },
          { lat: 39.0, lng: -91.0, at: '2026-10-21T10:00:00.000Z' },
          { lat: 38.4, lng: -92.1, at: '2026-10-21T12:00:00.000Z' },
        ],
      },
    })
    renderPage()
    const map = await screen.findByTestId('tracking-map')
    expect(map).toHaveAttribute('data-mode', 'fallback')
    // The marker's own fix is the last trail point, so the trail is three dots, not four.
    expect(map).toHaveAttribute('data-breadcrumbs', '3')
    expect(map).toHaveAttribute('data-current-source', '')
  })

  it('still shows the marker, with no trail, when the view carries no map block', async () => {
    renderPage()
    const map = await screen.findByTestId('tracking-map')
    expect(map).toHaveAttribute('data-breadcrumbs', '1')
  })

  it('never prints a source, an accuracy or a speed on the map', async () => {
    fetchCustomerTracking.mockResolvedValue({
      ...VIEW,
      map: { stops: [], route: null, trail: [{ lat: 41.5, lng: -88.1, at: '2026-10-21T08:00:00.000Z' }] },
    })
    const { container } = renderPage()
    await screen.findByTestId('tracking-map')
    expect(container.innerHTML).not.toMatch(/Driver phone|Motive|ELD|accuracy|speed|mph|sms-share|provider:/i)
  })

  it('reads like the truck page when the link is dead', async () => {
    const { TrackingError } = await import('@/lib/trackingClient')
    fetchCustomerTracking.mockRejectedValue(new TrackingError(404, 'This tracking link is no longer active'))
    renderPage()
    await waitFor(() => expect(screen.getByText(/no longer active/)).toBeTruthy())
    expect(screen.queryByText('Shipment S-1001')).toBeNull()
  })
})
