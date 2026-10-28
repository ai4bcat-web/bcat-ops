// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { CarrierTrackingView } from '@/types/tms'

const fetchCarrierTracking = vi.hoisted(() => vi.fn())
const postTrackingPing = vi.hoisted(() => vi.fn())

vi.mock('@/lib/trackingClient', () => ({
  TRACKING_API_URL: 'https://tracking.example',
  TrackingError: class TrackingError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
  fetchCustomerTracking: vi.fn(),
  fetchCarrierTracking,
  postTrackingPing,
}))

const { CarrierPingPage } = await import('./CarrierPingPage')
const { TrackingError } = await import('@/lib/trackingClient')

const VIEW: CarrierTrackingView = {
  loadNumber: 'S-1001-1',
  status: 'IN_TRANSIT',
  statusLabel: 'In transit',
  stops: [
    { id: 'st-1', type: 'pickup', sequence: 1, name: 'Shipper', city: 'Joliet', state: 'IL', appt: null, apptEnd: null, arrivedAt: null, departedAt: '2026-10-20T15:10:00.000Z', references: [] },
    { id: 'st-2', type: 'delivery', sequence: 2, name: 'Consignee', city: 'Dallas', state: 'TX', appt: '2026-10-22T09:00:00.000Z', apptEnd: null, arrivedAt: null, departedAt: null, references: [] },
  ],
  nextStop: { id: 'st-2', type: 'delivery', sequence: 2, name: 'Consignee', city: 'Dallas', state: 'TX', appt: '2026-10-22T09:00:00.000Z', apptEnd: null, arrivedAt: null, departedAt: null, references: [] },
  pings: [],
  contactPhone: '(224) 875-6477',
  generatedAt: '2026-10-21T12:05:00.000Z',
}

/** Stands in for the phone: either a fix or the error the browser would raise. */
function geolocation(outcome: { coords?: { latitude: number; longitude: number; accuracy: number }; code?: number }) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: PositionCallback, fail: PositionErrorCallback) => {
        if (outcome.coords) ok({ coords: outcome.coords, timestamp: Date.now() } as GeolocationPosition)
        else fail({ code: outcome.code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: '' } as GeolocationPositionError)
      },
    },
  })
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/track/l/Hq3Zn7Lp0vWx9TbKcRdYu1Ms4Ae6Gi2J']}>
      <Routes><Route path="/track/l/:token" element={<CarrierPingPage />} /></Routes>
    </MemoryRouter>,
  )
}

const shareButton = () => screen.getByRole('button', { name: /Share my location/ })

beforeEach(() => {
  vi.clearAllMocks()
  fetchCarrierTracking.mockResolvedValue(VIEW)
  postTrackingPing.mockResolvedValue({ ok: true, at: '2026-10-21T12:10:00.000Z' })
  geolocation({ coords: { latitude: 38.4, longitude: -92.1, accuracy: 12.4 } })
})

describe('CarrierPingPage', () => {
  it('sends the phone fix and confirms it landed', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Load S-1001-1')).toBeTruthy())
    expect(screen.getByText('Dallas, TX')).toBeTruthy()

    fireEvent.click(shareButton())
    await waitFor(() => expect(postTrackingPing).toHaveBeenCalled())
    expect(postTrackingPing.mock.calls[0][1]).toEqual({ lat: 38.4, lng: -92.1, accuracyM: 12 })
    await waitFor(() => expect(screen.getByText(/the office has your location/)).toBeTruthy())
  })

  it('explains a blocked permission instead of failing silently', async () => {
    geolocation({ code: 1 })
    renderPage()
    await waitFor(() => expect(screen.getByText('Load S-1001-1')).toBeTruthy())
    fireEvent.click(shareButton())
    await waitFor(() => expect(screen.getByText(/Location is blocked for this page/)).toBeTruthy())
    expect(postTrackingPing).not.toHaveBeenCalled()
  })

  it('passes the server own wording through for 409 and 429', async () => {
    for (const [status, message] of [
      [409, 'Location too imprecise — turn on precise location'],
      [429, 'Thanks — your location is already in. Tap again in a minute.'],
    ] as const) {
      postTrackingPing.mockRejectedValueOnce(new TrackingError(status, message))
      const { unmount } = renderPage()
      await waitFor(() => expect(screen.getByText('Load S-1001-1')).toBeTruthy())
      fireEvent.click(shareButton())
      await waitFor(() => expect(screen.getByText(message)).toBeTruthy())
      unmount()
    }
  })

  it('shows the dead-link wording and no button at all', async () => {
    fetchCarrierTracking.mockRejectedValue(new TrackingError(404, 'This tracking link is no longer active'))
    renderPage()
    await waitFor(() => expect(screen.getByText(/no longer active/)).toBeTruthy())
    expect(screen.queryByRole('button')).toBeNull()
  })
})
