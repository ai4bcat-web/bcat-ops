// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PayModal } from './DriverPayForms'

describe('PayModal', () => {
  it('is a named dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(<PayModal title="Add trip" sub="One load" onClose={onClose}><p>body</p></PayModal>)
    expect(screen.getByRole('dialog', { name: 'Add trip' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('goes wide only above 560px', () => {
    const { rerender } = render(<PayModal title="T" width={560} onClose={() => {}}>x</PayModal>)
    expect(screen.getByRole('dialog').className).not.toContain('tms-dialog-wide')
    rerender(<PayModal title="T" width={720} onClose={() => {}}>x</PayModal>)
    expect(screen.getByRole('dialog').className).toContain('tms-dialog-wide')
  })
})
