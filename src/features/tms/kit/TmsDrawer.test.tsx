// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { TmsDrawer } from './TmsDrawer'

function Harness({ onInteractOutside }: { onInteractOutside?: (e: Event) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="tms-shell">
      <button onClick={() => setOpen(true)}>open</button>
      <TmsDrawer open={open} onOpenChange={setOpen} title="Shipment" onInteractOutside={onInteractOutside}>
        <p>body</p>
      </TmsDrawer>
    </div>
  )
}

/** Radix arms its outside-click listener on the next tick. */
async function openIt() {
  const trigger = screen.getByText('open')
  trigger.focus()
  fireEvent.click(trigger)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return trigger
}

const overlay = () => document.querySelector('.tms-dialog-overlay')!

describe('TmsDrawer', () => {
  it('renders under .tms-portal outside .tms-shell', async () => {
    render(<Harness />)
    await openIt()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('tms-portal')
    expect(dialog.closest('.tms-shell')).toBeNull()
  })

  it('Escape closes and focus returns to the trigger', async () => {
    render(<Harness />)
    const trigger = await openIt()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('closes on overlay click', async () => {
    render(<Harness />)
    await openIt()
    fireEvent.pointerDown(overlay())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('onInteractOutside can veto the close', async () => {
    render(<Harness onInteractOutside={(e) => e.preventDefault()} />)
    await openIt()
    fireEvent.pointerDown(overlay())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
