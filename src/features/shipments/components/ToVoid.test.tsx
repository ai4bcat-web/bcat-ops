// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({ setToVoidFlag: vi.fn(), voidShipment: vi.fn(), graphqlErrorText: vi.fn(() => '') }))
vi.mock('@/lib/apiClient', () => api)
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ToVoidDialog, ToVoidPill, ToVoidSection } from './ToVoid'

const stamp = { flaggedAt: '2026-11-18T10:00:00.000Z', flaggedBy: 'a@b.c' }
const flagged = { reason: 'Duplicate of 14872', note: null, ...stamp }

describe('To-void flag UI', () => {
  beforeEach(() => {
    api.setToVoidFlag.mockReset(); api.setToVoidFlag.mockResolvedValue({ shipment: { id: 's1' } })
    api.voidShipment.mockReset(); api.voidShipment.mockResolvedValue({ shipment: { id: 's1', voidedAt: 'now' } })
  })

  it('shows the pill and the shipment-page notice only when the shipment is flagged', () => {
    const { rerender } = render(<ToVoidPill flag={null} />)
    expect(screen.queryByTestId('to-void-pill')).toBeNull()
    rerender(<ToVoidPill flag={flagged} />)
    expect(screen.getByTestId('to-void-pill')).toBeTruthy()

    const { unmount } = render(<ToVoidSection shipment={{ id: 's1', toVoidFlag: null }} />)
    expect(screen.queryByTestId('to-void-notice')).toBeNull()
    unmount()
    render(<ToVoidSection shipment={{ id: 's1', toVoidFlag: flagged }} />)
    expect(screen.getByTestId('to-void-notice').textContent).toMatch(/still live/)
  })

  it('needs a reason before it flags, then sends the reason and note and reports the saved shipment', async () => {
    const onSaved = vi.fn()
    render(<ToVoidDialog target={{ id: 's1', number: '20067' }} onClose={() => {}} onSaved={onSaved} />)
    fireEvent.click(screen.getByTestId('to-void-save'))
    expect(await screen.findByText(/Say why/)).toBeTruthy()
    expect(api.setToVoidFlag).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/Why should it be voided/), { target: { value: '  Duplicate of 14872 ' } })
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Same PO' } })
    fireEvent.click(screen.getByTestId('to-void-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(api.setToVoidFlag).toHaveBeenCalledWith({ shipmentId: 's1', flag: { reason: 'Duplicate of 14872', note: 'Same PO' } })
  })

  it('clears an existing flag with flag: null', async () => {
    render(<ToVoidDialog target={{ id: 's1', number: '20067', toVoidFlag: flagged }} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('to-void-clear'))
    await waitFor(() => expect(api.setToVoidFlag).toHaveBeenCalledWith({ shipmentId: 's1', flag: null }))
  })

  it('does not offer Void now until the shipment is flagged, and then opens the Void dialog with the reason filled in', async () => {
    const { unmount } = render(<ToVoidDialog target={{ id: 's1', number: '20067' }} onClose={() => {}} />)
    expect(screen.queryByTestId('to-void-now')).toBeNull()
    unmount()

    const onVoided = vi.fn()
    render(<ToVoidDialog target={{ id: 's1', number: '20067', updatedAt: 'u1', toVoidFlag: flagged }} onClose={() => {}} onVoided={onVoided} />)
    fireEvent.click(screen.getByTestId('to-void-now'))
    const box = await screen.findByLabelText('Reason')
    expect((box as HTMLTextAreaElement).value).toBe('Duplicate of 14872')
    fireEvent.click(screen.getByRole('button', { name: 'Void shipment' }))
    await waitFor(() => expect(onVoided).toHaveBeenCalled())
    expect(api.voidShipment).toHaveBeenCalledWith({ shipmentId: 's1', reason: 'Duplicate of 14872', expectedUpdatedAt: 'u1' })
  })

  it('shows what the server refused, and stays open', async () => {
    api.setToVoidFlag.mockRejectedValue(new Error('Shipment is voided'))
    const onClose = vi.fn()
    render(<ToVoidDialog target={{ id: 's1' }} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText(/Why should it be voided/), { target: { value: 'Duplicate' } })
    fireEvent.click(screen.getByTestId('to-void-save'))
    expect(await screen.findByText('Shipment is voided')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})
