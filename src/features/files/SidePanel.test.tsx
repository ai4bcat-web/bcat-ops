// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SidePanel } from './SidePanel'

describe('SidePanel', () => {
  it('renders title, subtitle, actions, footer and children', () => {
    render(
      <SidePanel title="Truck 12" subtitle="Truck file" actions={<button>Edit</button>} footer={<button>Save</button>} onClose={() => {}}>
        <p>body text</p>
      </SidePanel>,
    )
    expect(screen.getByRole('dialog', { name: /Truck 12/ })).toBeTruthy()
    expect(screen.getByText('Truck file')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getByText('body text')).toBeTruthy()
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    render(<SidePanel title="Load" onClose={onClose}>x</SidePanel>)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('applies zIndex so a panel opened over another stacks above it', () => {
    render(<SidePanel title="Driver file" zIndex={90} onClose={() => {}}>x</SidePanel>)
    expect((screen.getByRole('dialog') as HTMLElement).style.zIndex).toBe('90')
  })
})
