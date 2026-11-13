// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DateTime24Input } from './DateTime24Input'

function Harness({ initial = '', end, onValue }: { initial?: string; end?: string; onValue?: (v: string, e?: string) => void }) {
  const [v, setV] = useState(initial)
  const [e, setE] = useState(end ?? '')
  return (
    <>
      <DateTime24Input
        inputProps={{ 'aria-label': 'Appt', 'data-testid': 'dt' }} value={v}
        onChange={(x) => { setV(x); onValue?.(x, e) }}
        {...(end !== undefined ? { endValue: e, onEndChange: (x: string) => { setE(x); onValue?.(v, x) } } : {})}
      />
      <output data-testid="value">{v}</output>
      <output data-testid="end">{e}</output>
    </>
  )
}

describe('DateTime24Input', () => {
  it('has no browser picker: plain text boxes for the date and the 24-hour time', () => {
    render(<Harness initial="2026-11-16T07:00" />)
    const date = screen.getByTestId('dt') as HTMLInputElement
    const time = screen.getByTestId('dt-time') as HTMLInputElement
    expect(date.type).toBe('text')
    expect(time.type).toBe('text')
    expect(date.value).toBe('11/16/2026')
    expect(time.value).toBe('07:00')
  })

  it('commits a typed US date and military time as the local value', () => {
    render(<Harness />)
    fireEvent.change(screen.getByTestId('dt'), { target: { value: '11/16/2026' } })
    expect(screen.getByTestId('value').textContent).toBe('')
    fireEvent.change(screen.getByTestId('dt-time'), { target: { value: '1500' } })
    expect(screen.getByTestId('value').textContent).toBe('2026-11-16T15:00')
    fireEvent.blur(screen.getByTestId('dt-time'))
    expect((screen.getByTestId('dt-time') as HTMLInputElement).value).toBe('15:00')
  })

  it('takes a pasted YYYY-MM-DDTHH:mm in the date box', () => {
    render(<Harness />)
    fireEvent.change(screen.getByTestId('dt'), { target: { value: '2026-11-16T07:30' } })
    expect(screen.getByTestId('value').textContent).toBe('2026-11-16T07:30')
    expect((screen.getByTestId('dt-time') as HTMLInputElement).value).toBe('07:30')
  })

  it('flags a bad time and holds no value until it is fixed', () => {
    render(<Harness initial="2026-11-16T07:00" />)
    fireEvent.change(screen.getByTestId('dt-time'), { target: { value: '2500' } })
    fireEvent.blur(screen.getByTestId('dt-time'))
    expect(screen.getByTestId('value').textContent).toBe('')
    expect(screen.getByTestId('dt-problem').textContent).toMatch(/24-hour/)
  })

  it('range mode: one date, From and To', () => {
    const seen = vi.fn()
    render(<Harness end="" onValue={seen} />)
    fireEvent.change(screen.getByTestId('dt'), { target: { value: '11/16' } })
    fireEvent.change(screen.getByTestId('dt-time'), { target: { value: '0700' } })
    fireEvent.change(screen.getByTestId('dt-end'), { target: { value: '1600' } })
    expect(screen.getByTestId('value').textContent).toMatch(/^\d{4}-11-16T07:00$/)
    expect(screen.getByTestId('end').textContent).toMatch(/^\d{4}-11-16T16:00$/)
  })
})

describe('DateTime24Input calendar', () => {
  it('the calendar button opens a month grid; picking a day shows MM/DD/YYYY and keeps the typed time', () => {
    render(<Harness initial="2026-11-16T07:00" />)
    fireEvent.click(screen.getByTestId('dt-calendar'))
    expect(screen.getByText('November 2026')).toBeTruthy()
    fireEvent.click(screen.getByRole('gridcell', { name: 'Thursday, November 19, 2026' }))
    expect((screen.getByTestId('dt') as HTMLInputElement).value).toBe('11/19/2026')
    expect((screen.getByTestId('dt-time') as HTMLInputElement).value).toBe('07:00')
    expect(screen.getByTestId('value').textContent).toBe('2026-11-19T07:00')
    expect(screen.queryByRole('grid')).toBeNull()
  })

  it('clicking the date box opens the calendar but typing still works', () => {
    render(<Harness />)
    const date = screen.getByTestId('dt')
    fireEvent.click(date)
    expect(screen.getByRole('grid')).toBeTruthy()
    fireEvent.change(date, { target: { value: '12/01/2026' } })
    fireEvent.change(screen.getByTestId('dt-time'), { target: { value: '1430' } })
    expect(screen.getByTestId('value').textContent).toBe('2026-12-01T14:30')
  })

  it('pages months and shows the chosen day selected', () => {
    render(<Harness initial="2026-11-16T07:00" />)
    fireEvent.click(screen.getByTestId('dt-calendar'))
    expect(screen.getByRole('gridcell', { name: 'Monday, November 16, 2026' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByText('December 2026')).toBeTruthy()
    fireEvent.click(screen.getByRole('gridcell', { name: 'Wednesday, December 2, 2026' }))
    expect(screen.getByTestId('value').textContent).toBe('2026-12-02T07:00')
  })

  it('arrow keys move the focused day and Escape closes', () => {
    render(<Harness initial="2026-11-16T07:00" />)
    fireEvent.click(screen.getByTestId('dt-calendar'))
    const grid = screen.getByRole('grid')
    fireEvent.keyDown(grid, { key: 'ArrowRight' })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Tuesday, November 17, 2026')
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    expect(screen.queryByRole('grid')).toBeNull()
  })
})
