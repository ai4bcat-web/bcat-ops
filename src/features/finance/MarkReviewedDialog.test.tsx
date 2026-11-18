// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const financeAction = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', () => ({ financeAction }))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }))

import { MarkReviewedDialog } from './MarkReviewedDialog'

const flag = { id: 'shp-1', number: '14433', financeReviewReason: 'Rate differs', financeReviewApNote: 'Carrier billed 1,100' }

describe('MarkReviewedDialog', () => {
  beforeEach(() => financeAction.mockReset())

  it('clears the flag with no note when none is typed, then closes and refreshes', async () => {
    financeAction.mockResolvedValue({ cleared: true })
    const onCleared = vi.fn()
    const onClose = vi.fn()
    render(<MarkReviewedDialog flag={flag} showApNote onClose={onClose} onCleared={onCleared} />)
    expect(screen.getByText('Rate differs · Carrier billed 1,100')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    await waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(financeAction).toHaveBeenCalledWith('CLEAR_FINANCE_REVIEW', { shipmentId: 'shp-1' })
    expect(onClose).toHaveBeenCalled()
  })

  it('sends the typed note, trimmed', async () => {
    financeAction.mockResolvedValue({ cleared: true })
    render(<MarkReviewedDialog flag={flag} showApNote onClose={vi.fn()} onCleared={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '  Checked: matches the rate con  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    await waitFor(() => expect(financeAction).toHaveBeenCalledWith('CLEAR_FINANCE_REVIEW', { shipmentId: 'shp-1', note: 'Checked: matches the rate con' }))
  })

  it('never shows the carrier note off the AP side', () => {
    render(<MarkReviewedDialog flag={flag} showApNote={false} onClose={vi.fn()} onCleared={vi.fn()} />)
    expect(screen.getByText('Rate differs')).toBeTruthy()
    expect(screen.queryByText(/Carrier billed/)).toBeNull()
  })

  it('stays open and says so when the clear fails', async () => {
    financeAction.mockRejectedValueOnce(new Error('boom'))
    const onCleared = vi.fn()
    const onClose = vi.fn()
    render(<MarkReviewedDialog flag={flag} showApNote onClose={onClose} onCleared={onCleared} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('boom'))
    expect(onCleared).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
