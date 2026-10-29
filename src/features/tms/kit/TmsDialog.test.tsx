// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TmsDialog } from './TmsDialog'

describe('TmsDialog', () => {
  it('carries the portal theme class into document.body so the dark tokens reach it', () => {
    render(
      <TmsDialog open onOpenChange={() => {}} title="Void shipment">
        <p>BCAT104221</p>
      </TmsDialog>
    )

    const content = screen.getByRole('dialog')
    expect(content).toHaveClass('tms-portal', 'tms-dialog-content')
    // Rendered outside the shell subtree — which is exactly why it needs its own scope.
    expect(content.closest('.tms-shell')).toBeNull()
    expect(document.querySelector('.tms-dialog-overlay')).toHaveClass('tms-portal')
    expect(screen.getByText('Void shipment')).toBeInTheDocument()
  })

  it('closes through the header button', () => {
    const onOpenChange = vi.fn()
    render(<TmsDialog open onOpenChange={onOpenChange} title="Void shipment" />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
