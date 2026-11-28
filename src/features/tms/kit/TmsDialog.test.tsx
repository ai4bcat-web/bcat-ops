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

  it('takes a stacking order for opening over a drawer, the box one above its overlay', () => {
    render(<TmsDialog open onOpenChange={() => {}} title="Over a drawer" zIndex={80} />)
    expect((document.querySelector('.tms-dialog-overlay') as HTMLElement).style.zIndex).toBe('80')
    expect(screen.getByRole('dialog').style.zIndex).toBe('81')
  })

  it('leaves the stylesheet stacking alone when no order is given', () => {
    render(<TmsDialog open onOpenChange={() => {}} title="Plain" />)
    expect((document.querySelector('.tms-dialog-overlay') as HTMLElement).style.zIndex).toBe('')
    expect(screen.getByRole('dialog').style.zIndex).toBe('')
  })
})
