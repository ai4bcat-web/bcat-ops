// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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
  share: {
    everyMin: 5,
    consentRequired: true,
    consentVersion: 'ao-1',
    consentText: 'BCAT Logistics will receive this phone\'s location while this page is open.',
    active: true,
    lastPingAt: null,
    pingCount: 0,
  },
  contactPhone: '(224) 875-6477',
  generatedAt: '2026-10-21T12:05:00.000Z',
}

/** Stands in for the phone: `emit` is the browser delivering a position to the page's watch. */
const watchPosition = vi.fn()
const clearWatch = vi.fn()
const getCurrentPosition = vi.fn()
let deliver: PositionCallback | null = null
let fail: PositionErrorCallback | null = null

function phone() {
  deliver = null
  fail = null
  watchPosition.mockImplementation((ok: PositionCallback, bad: PositionErrorCallback) => { deliver = ok; fail = bad; return 7 })
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { watchPosition, clearWatch, getCurrentPosition },
  })
}

async function emit(latitude: number, longitude: number, accuracy = 12.4) {
  await act(async () => {
    deliver?.({ coords: { latitude, longitude, accuracy, speed: null, heading: null }, timestamp: Date.now() } as unknown as GeolocationPosition)
  })
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/track/l/Hq3Zn7Lp0vWx9TbKcRdYu1Ms4Ae6Gi2J']}>
      <Routes><Route path="/track/l/:token" element={<CarrierPingPage />} /></Routes>
    </MemoryRouter>,
  )
}

const startButton = () => screen.getByRole('button', { name: /Start sharing/ }) as HTMLButtonElement
const agree = () => fireEvent.click(screen.getByRole('checkbox', { name: /I agree/ }))
const loaded = () => waitFor(() => expect(screen.getByText('Load S-1001-1')).toBeTruthy())

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  fetchCarrierTracking.mockResolvedValue(VIEW)
  postTrackingPing.mockResolvedValue({ ok: true, at: '2026-10-21T12:10:00.000Z', nextInMin: 5 })
  phone()
})

afterEach(() => { vi.useRealTimers() })

/** Loads the page on real timers, then hands the clock over so the cadence can be driven. */
async function startSharing() {
  renderPage()
  await loaded()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  agree()
  fireEvent.click(startButton())
}

describe('CarrierPingPage', () => {
  it('asks for nothing from the phone until the driver agrees and taps Start sharing', async () => {
    renderPage()
    await loaded()
    expect(screen.getByTestId('consent-text').textContent).toContain('will receive this phone')
    expect(startButton().disabled).toBe(true)
    expect(watchPosition).not.toHaveBeenCalled()
    expect(getCurrentPosition).not.toHaveBeenCalled()

    agree()
    expect(startButton().disabled).toBe(false)
    expect(watchPosition).not.toHaveBeenCalled()
    fireEvent.click(startButton())
    expect(watchPosition).toHaveBeenCalledTimes(1)
  })

  it('posts the first fix at once with consent, then no more often than the cadence', async () => {
    await startSharing()
    await emit(38.4, -92.1)
    expect(postTrackingPing).toHaveBeenCalledTimes(1)
    expect(postTrackingPing.mock.calls[0][1]).toMatchObject({ lat: 38.4, lng: -92.1, accuracyM: 12, trigger: 'tap', consent: true })

    // A minute later the phone reports again a few metres on: too soon, nothing goes out.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    await emit(38.4005, -92.1)
    expect(postTrackingPing).toHaveBeenCalledTimes(1)

    // Five minutes after the first post a quiet phone's latest fix goes out on the timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000) })
    expect(postTrackingPing).toHaveBeenCalledTimes(2)
    expect(postTrackingPing.mock.calls[1][1]).toMatchObject({ trigger: 'watch' })
  })

  it('posts early when the phone has moved more than a kilometre', async () => {
    await startSharing()
    await emit(38.4, -92.1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    await emit(38.45, -92.1)
    expect(postTrackingPing).toHaveBeenCalledTimes(2)
  })

  it('Stop sharing clears the watch and nothing is posted afterwards', async () => {
    await startSharing()
    await emit(38.4, -92.1)
    fireEvent.click(screen.getByRole('button', { name: /Stop sharing/ }))
    expect(clearWatch).toHaveBeenCalledWith(7)
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000) })
    expect(postTrackingPing).toHaveBeenCalledTimes(1)
    expect(startButton()).toBeTruthy()
  })

  it('a 410 clears the watch and shows the delivered state', async () => {
    postTrackingPing.mockRejectedValueOnce(new TrackingError(410, 'Delivery is complete — sharing has stopped. Thank you.'))
    await startSharing()
    await emit(38.4, -92.1)
    expect(clearWatch).toHaveBeenCalledWith(7)
    expect(screen.getByText(/Delivery complete — sharing has stopped/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Start sharing|Stop sharing/ })).toBeNull()
  })

  it('treats a 429 as already in, not as an error', async () => {
    postTrackingPing.mockRejectedValueOnce(new TrackingError(429, 'Thanks — your location is already in. Tap again in a minute.'))
    await startSharing()
    await emit(38.4, -92.1)
    expect(screen.queryByText(/already in/)).toBeNull()
    expect(screen.getByText(/Sharing ·/)).toBeTruthy()
  })

  it('explains a blocked permission and stops instead of failing silently', async () => {
    await startSharing()
    await act(async () => { fail?.({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: '' } as GeolocationPositionError) })
    expect(screen.getByText(/Location is blocked for this page/)).toBeTruthy()
    expect(postTrackingPing).not.toHaveBeenCalled()
    expect(clearWatch).toHaveBeenCalledWith(7)
  })

  it('shows the server wording for a coarse fix and keeps sharing', async () => {
    postTrackingPing.mockRejectedValueOnce(new TrackingError(409, 'Location too imprecise — turn on precise location'))
    await startSharing()
    await emit(38.4, -92.1, 9000)
    expect(screen.getByText('Location too imprecise — turn on precise location')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Stop sharing/ })).toBeTruthy()
  })

  it('needs no checkbox once the server has the driver\'s consent, and still waits for the tap', async () => {
    fetchCarrierTracking.mockResolvedValue({ ...VIEW, share: { ...VIEW.share!, consentRequired: false } })
    renderPage()
    await loaded()
    expect(screen.queryByRole('checkbox', { name: /I agree/ })).toBeNull()
    expect(watchPosition).not.toHaveBeenCalled()
    expect(startButton().disabled).toBe(false)
  })

  it('shows the delivered state for a load that is already closed', async () => {
    fetchCarrierTracking.mockResolvedValue({ ...VIEW, share: { ...VIEW.share!, active: false } })
    renderPage()
    await loaded()
    expect(screen.getByText(/Delivery complete/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Start sharing/ })).toBeNull()
  })

  it('shows the dead-link wording and no button at all', async () => {
    fetchCarrierTracking.mockRejectedValue(new TrackingError(404, 'This tracking link is no longer active'))
    renderPage()
    await waitFor(() => expect(screen.getByText(/no longer active/)).toBeTruthy())
    expect(screen.queryByRole('button')).toBeNull()
  })
})
