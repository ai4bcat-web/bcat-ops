// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { RateConSignState } from '@/lib/rateConSignClient'

const getRateCon = vi.hoisted(() => vi.fn())
const submitRateCon = vi.hoisted(() => vi.fn())

vi.mock('@/lib/rateConSignClient', () => ({
  RATE_CON_SIGN_API_URL: 'https://rate-con.example',
  rateConSignAvailable: true,
  RateConSignError: class RateConSignError extends Error {
    code?: string
    fieldErrors?: Record<string, string>
    constructor(public status: number, message: string, code?: string, fieldErrors?: Record<string, string>) {
      super(message)
      this.code = code
      this.fieldErrors = fieldErrors
    }
  },
  getRateCon,
  submitRateCon,
  declineRateCon: vi.fn(),
}))

const { RateConSignPage } = await import('./RateConSignPage')
const { RateConSignError } = await import('@/lib/rateConSignClient')

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
    fireEvent.change(screen.getByLabelText('Driver phone'), { target: { value: '312-555-0101' } })
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

  it('asks the carrier for all four driver fields (Step AM) under one Driver and truck heading', async () => {
    getRateCon.mockResolvedValue({ ...SENT, requiredFields: ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER', 'TRAILER_NUMBER'] })
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('Trailer number')).toBeTruthy())
    expect(screen.getByText('Driver and truck')).toBeTruthy()
    expect(screen.queryByText('Trip details')).toBeNull()
    expect(signButton().disabled).toBe(true)
  })

  it('asks only for what the rep has not entered, and shows what is already on file', async () => {
    getRateCon.mockResolvedValue({
      ...SENT,
      requiredFields: ['TRUCK_NUMBER', 'TRAILER_NUMBER'],
      driverInfo: { driverName: 'Dan Ruiz', driverPhone: '555-0101', truckNumber: null, trailerNumber: null },
    })
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('Truck number')).toBeTruthy())
    expect(screen.queryByLabelText('Driver name')).toBeNull()
    expect(screen.getByTestId('driver-on-file').textContent).toMatch(/Driver name Dan Ruiz.*Driver phone 555-0101/)
  })

  it('signs and enters the driver in one submit: the four fields go with the signature', async () => {
    getRateCon.mockResolvedValue({ ...SENT, requiredFields: ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER', 'TRAILER_NUMBER'] })
    submitRateCon.mockResolvedValue({ ok: true, alreadySigned: false })
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('Trailer number')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Driver name'), { target: { value: ' Dan Ruiz ' } })
    fireEvent.change(screen.getByLabelText('Driver phone'), { target: { value: '(312) 555-0101' } })
    fireEvent.change(screen.getByLabelText('Truck number'), { target: { value: '417' } })
    fireEvent.change(screen.getByLabelText('Trailer number'), { target: { value: 'T-88' } })
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Maria Lopez' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(signButton())

    await waitFor(() => expect(submitRateCon).toHaveBeenCalledTimes(1))
    // The browser sends the typed name, the tick and the fields: never a PDF.
    expect(submitRateCon.mock.calls[0]![0]).toEqual({
      token: 'tok-123', signerName: 'Maria Lopez', agreed: true,
      fields: { DRIVER_NAME: 'Dan Ruiz', DRIVER_PHONE: '(312) 555-0101', TRUCK_NUMBER: '417', TRAILER_NUMBER: 'T-88' },
    })
  })

  it('blocks Sign on a malformed driver phone and says why, even with everything else filled', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('Driver name')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Driver name'), { target: { value: 'Dan Ruiz' } })
    fireEvent.change(screen.getByLabelText('Driver phone'), { target: { value: '555-0101' } })
    fireEvent.change(screen.getByLabelText('Truck number'), { target: { value: '417' } })
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Maria Lopez' } })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(signButton().disabled).toBe(true)
    expect(screen.getByTestId('error-DRIVER_PHONE').textContent).toMatch(/valid 10-digit/)

    fireEvent.change(screen.getByLabelText('Driver phone'), { target: { value: '312-555-0101' } })
    expect(signButton().disabled).toBe(false)
  })

  it('blocks Sign on a blank required field, on a name with no letters, and on an unticked agreement', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('Driver name')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Driver name'), { target: { value: 'Dan Ruiz' } })
    fireEvent.change(screen.getByLabelText('Driver phone'), { target: { value: '312-555-0101' } })
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Maria Lopez' } })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(signButton().disabled).toBe(true) // truck number blank

    fireEvent.change(screen.getByLabelText('Truck number'), { target: { value: '417' } })
    expect(signButton().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: '12345' } })
    expect(signButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Maria Lopez' } })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(signButton().disabled).toBe(true)
  })

  it('shows the typed name as a signature before signing', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('Your full name')).toBeTruthy())
    expect(screen.queryByTestId('signature-preview')).toBeNull()
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Maria Lopez' } })
    expect(screen.getByTestId('signature-preview').textContent).toContain('Maria Lopez')
  })

  it('shows the server\'s refusal and keeps the form when the server disagrees', async () => {
    submitRateCon.mockRejectedValue(new RateConSignError(400, 'Driver phone must be a valid 10-digit US phone number', 'INVALID', { DRIVER_PHONE: 'Driver phone must be a valid 10-digit US phone number' }))
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('Driver name')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Driver name'), { target: { value: 'Dan Ruiz' } })
    fireEvent.change(screen.getByLabelText('Driver phone'), { target: { value: '312-555-0101' } })
    fireEvent.change(screen.getByLabelText('Truck number'), { target: { value: '417' } })
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Maria Lopez' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(signButton())
    await waitFor(() => expect(screen.getAllByText(/valid 10-digit/).length).toBeGreaterThan(0))
    expect(screen.getByLabelText('Driver name')).toBeTruthy()
  })

  it('on a link a newer version replaced, says so and offers no way to sign', async () => {
    getRateCon.mockRejectedValue(new RateConSignError(410, 'This rate confirmation was replaced; use the newest link', 'REPLACED'))
    renderPage()
    await waitFor(() => expect(screen.getByText('This rate confirmation was replaced; use the newest link')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Sign rate confirmation/ })).toBeNull()
    expect(screen.queryByLabelText('Your full name')).toBeNull()
  })

  it('shows an already-signed link as signed, with no form', async () => {
    getRateCon.mockResolvedValue({ ...SENT, status: 'SIGNED', requiredFields: [], pdfUrl: '' })
    renderPage()
    await waitFor(() => expect(screen.getByText(/already been signed/i)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Sign rate confirmation/ })).toBeNull()
  })
})
