// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReturnToActiveDialog } from './ReturnToActiveDialog'

const h = vi.hoisted(() => ({ returnToActive: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({ returnToActive: h.returnToActive }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }))

describe('ReturnToActiveDialog', () => {
  beforeEach(() => { h.returnToActive.mockReset() })

  it('sends the ticked loads back with the reason and closes', async () => {
    h.returnToActive.mockResolvedValue({ results: [{ shipmentId: 's1', number: '14001', ok: true, message: null }] })
    const onDone = vi.fn()
    const onOpenChange = vi.fn()
    render(<ReturnToActiveDialog open onOpenChange={onOpenChange} ids={['s1']} label="14001" onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'wrong time' } })
    fireEvent.click(screen.getByTestId('return-active-confirm'))
    await waitFor(() => expect(h.returnToActive).toHaveBeenCalledWith(['s1'], 'wrong time'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('goes in batches of nine and stays open with the server\'s sentence when every row is refused', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `s${i}`)
    h.returnToActive.mockImplementation(async (batch: string[]) => ({
      results: batch.map((id) => ({ shipmentId: id, number: id.toUpperCase(), ok: false, message: 'This load is already invoiced. Revise or void the invoice from Accounts Receivable instead; it cannot go back to Active.' })),
    }))
    const onDone = vi.fn()
    render(<ReturnToActiveDialog open onOpenChange={vi.fn()} ids={ids} label="11 loads" onDone={onDone} />)
    fireEvent.click(screen.getByTestId('return-active-confirm'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/already invoiced/)
    expect(h.returnToActive).toHaveBeenCalledTimes(2)
    expect((h.returnToActive.mock.calls[0][0] as string[]).length).toBe(9)
    expect(onDone).not.toHaveBeenCalled()
  })
})
