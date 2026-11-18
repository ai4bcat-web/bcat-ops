// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VoidedBanner } from './VoidedBanner'

const { unvoidShipment } = vi.hoisted(() => ({ unvoidShipment: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ unvoidShipment }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const shipment = { id: 'shp-1', number: '14600', updatedAt: '2026-11-17T10:00:00.000Z' }

describe('VoidedBanner', () => {
  beforeEach(() => { unvoidShipment.mockReset() })

  it('shows the banner text to everyone and Restore from void only when allowed', () => {
    const { rerender } = render(<VoidedBanner shipment={shipment} message="This shipment is voided." canRestore={false} onRestored={vi.fn()} />)
    expect(screen.getByText('This shipment is voided.')).toBeTruthy()
    expect(screen.queryByTestId('ship-form-restore-void')).toBeNull()
    rerender(<VoidedBanner shipment={shipment} message="This shipment is voided." canRestore onRestored={vi.fn()} />)
    expect(screen.getByTestId('ship-form-restore-void')).toBeTruthy()
  })

  it('needs a reason, then restores and refreshes the page', async () => {
    unvoidShipment.mockResolvedValueOnce({})
    const onRestored = vi.fn()
    render(<VoidedBanner shipment={shipment} message="This shipment is voided." canRestore onRestored={onRestored} />)
    fireEvent.click(screen.getByTestId('ship-form-restore-void'))
    fireEvent.click(await screen.findByRole('button', { name: 'Unvoid' }))
    expect(await screen.findByText('A reason is required.')).toBeTruthy()
    expect(unvoidShipment).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('Why is this shipment being restored?'), { target: { value: 'Voided by mistake' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unvoid' }))
    await waitFor(() => expect(unvoidShipment).toHaveBeenCalledWith({ shipmentId: 'shp-1', reason: 'Voided by mistake', expectedUpdatedAt: '2026-11-17T10:00:00.000Z' }))
    await waitFor(() => expect(onRestored).toHaveBeenCalled())
  })
})
