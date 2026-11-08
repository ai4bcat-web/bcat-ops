// @vitest-environment jsdom
/** Smoke test: the Booking Confirmation page renders and sending is gated on recipient + pickup date. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const sendVehicleQuoteEmail = vi.fn()
vi.mock('@/lib/apiClient', () => ({
  sendVehicleQuoteEmail: (...a: unknown[]) => sendVehicleQuoteEmail(...a),
  getGoogleReviews: () => Promise.resolve({ ok: false, rating: null, total: null, url: '' }),
}))

import { VehicleConfirmationPage } from './VehicleConfirmationPage'

beforeEach(() => {
  vi.clearAllMocks()
  sendVehicleQuoteEmail.mockResolvedValue({ sent: true, to: 'test@example.com', cc: 'cc@example.com' })
})
afterEach(cleanup)

describe('VehicleConfirmationPage renders', () => {
  it('shows the heading, form and preview, with Send disabled until valid', async () => {
    render(<VehicleConfirmationPage />)
    expect(screen.getByRole('heading', { name: 'Booking Confirmation' })).toBeTruthy()
    expect(screen.getByTitle('Confirmation email preview')).toBeTruthy()
    const send = screen.getByRole('button', { name: /Send Confirmation/ }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await waitFor(() => expect(screen.getByPlaceholderText('1088')).toBeTruthy())
  })

  it('sends once recipient and pickup date are filled', async () => {
    const { container } = render(<VehicleConfirmationPage />)
    fireEvent.change(screen.getByPlaceholderText('customer@email.com'), { target: { value: 'test@example.com' } })
    fireEvent.change(container.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: '2030-01-15' } })
    const send = screen.getByRole('button', { name: /Send Confirmation/ }) as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    await waitFor(() => expect(sendVehicleQuoteEmail).toHaveBeenCalledTimes(1))
  })
})
