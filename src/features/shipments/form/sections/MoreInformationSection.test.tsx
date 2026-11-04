// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MoreInformationSection } from './MoreInformationSection'
import { emptyValues, type ShipmentFormValues } from '../model'
import { makeCtx, makeForm } from './ah5TestKit'

vi.mock('@/features/shipments/components/HistorySection', () => ({ HistorySection: () => <div>history</div> }))

function setup(more: Partial<ShipmentFormValues['more']> = {}, values = emptyValues()) {
  const onChange = vi.fn()
  const v = { ...values, more: { ...values.more, ...more } }
  render(<MoreInformationSection value={v.more} onChange={onChange} ctx={makeCtx()} form={makeForm(v)} />)
  return onChange
}

describe('MoreInformationSection', () => {
  it('counts down the 420 / 260 character limits', () => {
    setup({ specialInstructions: 'x'.repeat(20), bolNotes: 'y'.repeat(10) })
    expect(screen.getByTestId('more-special-counter').textContent).toBe('400 characters remaining')
    expect(screen.getByTestId('more-bol-counter').textContent).toBe('250 characters remaining')
  })

  it('never cuts stored BOL text silently: an over-limit note can shrink but not grow', () => {
    const long = 'z'.repeat(300)
    const onChange = setup({ bolNotes: long })
    expect(screen.getByTestId('more-bol-counter').textContent).toBe('40 over')
    const box = screen.getByLabelText('Bill of Lading Notes')
    fireEvent.change(box, { target: { value: long + 'q' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(box, { target: { value: long.slice(0, 299) } })
    expect(onChange).toHaveBeenCalledWith({ bolNotes: long.slice(0, 299) })
  })

  it('Route lists the stops as they are when the tab is opened, with the lane', () => {
    const v = emptyValues()
    v.stops[0] = { ...v.stops[0], name: 'Dock A', city: 'Chicago', state: 'IL' }
    v.stops[1] = { ...v.stops[1], name: 'Store 9', city: 'Dallas', state: 'TX' }
    setup({}, v)
    fireEvent.click(screen.getByRole('tab', { name: 'Route' }))
    const list = screen.getByTestId('f-more-route-list')
    expect(list.textContent).toContain('Lane: Chicago, IL → Dallas, TX')
    expect(list.textContent).toContain('1. Pick · Dock A')
    expect(list.textContent).toContain('2. Delivery · Store 9')
  })

  it('Updates says nothing exists before the first save', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    expect(screen.getByText('Updates appear after the first save.')).toBeTruthy()
  })
})
