// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { DraftDateField } from './DraftDateField'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const field = (onSave: (v: string | null) => Promise<void>, value: string | null = '2026-01-01') =>
  render(<DraftDateField value={value} onSave={onSave} label="DOT inspection date" successMessage="saved" clearedMessage="cleared" />)

describe('DraftDateField', () => {
  it('does not write while typing; Save writes once with the final value', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    field(onSave)
    const input = screen.getByLabelText('DOT inspection date')
    fireEvent.change(input, { target: { value: '2026-02-01' } })
    fireEvent.change(input, { target: { value: '2026-03-15' } })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith('2026-03-15')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('saved'))
  })

  it('has no Save button until the draft differs, and Cancel restores the saved value', () => {
    field(vi.fn())
    expect(screen.queryByText('Save')).toBeNull()
    const input = screen.getByLabelText('DOT inspection date') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2026-05-05' } })
    fireEvent.click(screen.getByText('Cancel'))
    expect(input.value).toBe('2026-01-01')
    expect(screen.queryByText('Save')).toBeNull()
  })

  it('clearing saves null, not undefined', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    field(onSave)
    fireEvent.change(screen.getByLabelText('DOT inspection date'), { target: { value: '' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('cleared'))
  })

  it('a failed write shows the error and keeps the draft', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'))
    field(onSave)
    const input = screen.getByLabelText('DOT inspection date') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2026-09-09' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't save DOT inspection date: boom"))
    expect(input.value).toBe('2026-09-09')
    expect(screen.getByText('Save')).toBeTruthy()
  })
})
