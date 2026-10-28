// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { RateConSignState } from '@/lib/rateConSignClient'

const getRateCon = vi.hoisted(() => vi.fn())

vi.mock('@/lib/rateConSignClient', () => ({
  RATE_CON_SIGN_API_URL: 'https://rate-con.example',
  rateConSignAvailable: true,
  RateConSignError: class RateConSignError extends Error {},
  getRateCon,
  submitRateCon: vi.fn(),
  declineRateCon: vi.fn(),
}))
// The real module pulls in jspdf/pdf-lib, which this page only needs at signing time.
vi.mock('@/lib/carrierRateCon', () => ({ stampSignature: vi.fn() }))

const { RateConSignPage } = await import('./RateConSignPage')

const SENT: RateConSignState = {
  loadNumber: 'L-1001',
  carrierName: 'Blue Sky Trucking',
  brokerName: 'BCAT Logistics',
  status: 'SENT',
  expiresAt: '2099-01-01T00:00:00.000Z',
  requiredFields: ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER'],
  totalCents: 185000,
  pdfUrl: 'https://rate-con.example/unsigned.pdf',
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/sign/rate-con/tok-123']}>
      <Routes><Route path="/sign/rate-con/:token" element={<RateConSignPage />} /></Routes>
    </MemoryRouter>,
  )
}

const signButton = () => screen.getByRole('button', { name: /Sign rate confirmation/ }) as HTMLButtonElement

beforeEach(() => {
  vi.clearAllMocks()
  getRateCon.mockResolvedValue(SENT)
})

describe('RateConSignPage', () => {
  it('renders an input for every field the broker requires', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('Driver name')).toBeTruthy())
    expect(screen.getByLabelText('Driver phone')).toBeTruthy()
    expect(screen.getByLabelText('Truck number')).toBeTruthy()
    // Only the required fields are asked for — nothing extra from the enum.
    expect(screen.queryByLabelText('Trailer number')).toBeNull()
    expect(screen.queryByLabelText('VIN')).toBeNull()
  })

  it('keeps Sign disabled until the signer types their name and ticks the agreement', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('Driver name')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Driver name'), { target: { value: 'Dan Ruiz' } })
    fireEvent.change(screen.getByLabelText('Driver phone'), { target: { value: '555-0101' } })
    fireEvent.change(screen.getByLabelText('Truck number'), { target: { value: '417' } })
    expect(signButton().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Maria Lopez' } })
    expect(signButton().disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox'))
    expect(signButton().disabled).toBe(false)
  })

  it('shows the expiry message and no form once the link has lapsed', async () => {
    getRateCon.mockResolvedValue({ ...SENT, status: 'EXPIRED', expiresAt: '2020-01-01T00:00:00.000Z' })
    renderPage()
    await waitFor(() => expect(screen.getByText(/link has expired/i)).toBeTruthy())
    expect(screen.queryByLabelText('Driver name')).toBeNull()
    expect(screen.queryByLabelText('Your full name')).toBeNull()
    expect(screen.queryByRole('button', { name: /Sign rate confirmation/ })).toBeNull()
  })
})
