// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({ setTonuFlag: vi.fn(), setDetentionFlag: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { TonuDialog, TonuPill } from './Tonu'
import { AccessorialFlags } from './AccessorialFlags'

const stamp = { flaggedAt: '2026-11-16T10:00:00.000Z', flaggedBy: 'a@b.c' }

describe('TONU flag UI', () => {
  beforeEach(() => { api.setTonuFlag.mockReset(); api.setTonuFlag.mockResolvedValue({ shipment: { id: 's1' } }) })

  it('shows the pill only when the shipment is flagged', () => {
    const { rerender } = render(<TonuPill flag={null} />)
    expect(screen.queryByTestId('tonu-pill')).toBeNull()
    rerender(<TonuPill flag={{ note: 'Dock closed', ...stamp }} />)
    expect(screen.getByTestId('tonu-pill')).toBeTruthy()
  })

  it('flags with the typed amount and note, then reports the saved shipment', async () => {
    const onSaved = vi.fn()
    render(<TonuDialog target={{ id: 's1', number: '20067' }} onClose={() => {}} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText(/Expected TONU amount/), { target: { value: '$250' } })
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Shipper cancelled' } })
    fireEvent.click(screen.getByTestId('tonu-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(api.setTonuFlag).toHaveBeenCalledWith({ shipmentId: 's1', flag: { amount: 250, note: 'Shipper cancelled' } })
  })

  it('clears an existing flag with flag: null', async () => {
    render(<TonuDialog target={{ id: 's1', number: '20067', tonuFlag: { amount: 250, ...stamp } }} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('tonu-clear'))
    await waitFor(() => expect(api.setTonuFlag).toHaveBeenCalledWith({ shipmentId: 's1', flag: null }))
  })

  it('shows what the server refused, and stays open', async () => {
    api.setTonuFlag.mockRejectedValue(new Error('Shipment is voided'))
    const onClose = vi.fn()
    render(<TonuDialog target={{ id: 's1' }} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('tonu-save'))
    expect(await screen.findByText(/voided/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('AccessorialFlags (calendar row)', () => {
  it('wears a pill for each flag on the shipment', () => {
    render(<AccessorialFlags target={{ id: 's1', detentionFlag: { stopType: 'pickup', ...stamp }, tonuFlag: { ...stamp } }} />)
    expect(screen.getByTestId('detention-pill')).toBeTruthy()
    expect(screen.getByTestId('tonu-pill')).toBeTruthy()
    expect(screen.getByTestId('accessorial-flag-menu')).toBeTruthy()
  })
  it('wears nothing but the menu button when the shipment is not flagged', () => {
    render(<AccessorialFlags target={{ id: 's1' }} />)
    expect(screen.queryByTestId('detention-pill')).toBeNull()
    expect(screen.queryByTestId('tonu-pill')).toBeNull()
  })
})
