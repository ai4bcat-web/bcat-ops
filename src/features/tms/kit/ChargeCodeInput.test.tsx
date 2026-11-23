// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChargeCodeInput } from './ChargeCodeInput'

const OPTIONS = [
  { code: 'DETENTION', label: 'Detention' },
  { code: 'LAYOVER', label: 'Layover' },
  { code: 'TONU', label: 'Truck ordered not used' },
  { code: 'TRACKING', label: 'Tracking fee' },
]

function Harness({ start = '' }: { start?: string }) {
  const [v, setV] = useState(start)
  return <ChargeCodeInput aria-label="Accessorial" options={OPTIONS} value={v} onChange={setV} />
}

afterEach(cleanup)

describe('ChargeCodeInput', () => {
  it('opens a compact list on focus with every code and its description', () => {
    render(<Harness />)
    fireEvent.focus(screen.getByLabelText('Accessorial'))
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.getByText('Tracking fee')).toBeTruthy()
  })

  it('filters as you type, by code or description, and upper-cases what is typed', () => {
    render(<Harness />)
    const input = screen.getByLabelText('Accessorial') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'track' } })
    expect(input.value).toBe('TRACK')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['TRACKINGTracking fee'])
    fireEvent.change(input, { target: { value: 'not used' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['TONUTruck ordered not used'])
  })

  it('picks with the mouse', () => {
    render(<Harness />)
    const input = screen.getByLabelText('Accessorial') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.mouseDown(screen.getByText('LAYOVER'))
    expect(input.value).toBe('LAYOVER')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('moves with the arrow keys, picks with Enter and closes with Escape', () => {
    render(<Harness />)
    const input = screen.getByLabelText('Accessorial') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('TONU')
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keeps a typed code that is not in the list', () => {
    render(<Harness />)
    const input = screen.getByLabelText('Accessorial') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'my-fee' } })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('MY-FEE')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('renders the list outside the table so nothing can clip it', () => {
    const { container } = render(<div style={{ overflow: 'hidden' }}><Harness /></div>)
    fireEvent.focus(screen.getByLabelText('Accessorial'))
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull()
  })
})
