// @vitest-environment jsdom
/** Smoke test: the Vehicle Quote page renders and sending is gated on recipient + amount. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const sendVehicleQuoteEmail = vi.fn()
vi.mock('@/lib/apiClient', () => ({
  sendVehicleQuoteEmail: (...a: unknown[]) => sendVehicleQuoteEmail(...a),
  getGoogleReviews: () => Promise.resolve({ ok: false, rating: null, total: null, url: '' }),
}))

import { VehicleQuotePage } from './VehicleQuotePage'

beforeEach(() => {
  vi.clearAllMocks()
  sendVehicleQuoteEmail.mockResolvedValue({ sent: true, to: 'test@example.com', cc: 'cc@example.com' })
})
afterEach(cleanup)

describe('VehicleQuotePage renders', () => {
  it('shows the heading, form and preview, with Send disabled until valid', async () => {
    render(<VehicleQuotePage />)
    expect(screen.getByRole('heading', { name: 'Vehicle Quote' })).toBeTruthy()
    expect(screen.getByTitle('Quote email preview')).toBeTruthy()
    const send = screen.getByRole('button', { name: /Send Quote/ }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await waitFor(() => expect(screen.getByPlaceholderText('1088')).toBeTruthy())
  })

  it('enables Send once recipient and amount are entered and sends the quote', async () => {
    render(<VehicleQuotePage />)
    fireEvent.change(screen.getByPlaceholderText('customer@email.com'), { target: { value: 'test@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('1088'), { target: { value: '1200' } })
    const send = screen.getByRole('button', { name: /Send Quote/ }) as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    await waitFor(() => expect(sendVehicleQuoteEmail).toHaveBeenCalledTimes(1))
    expect(sendVehicleQuoteEmail.mock.calls[0][0].to).toBe('test@example.com')
  })
})
