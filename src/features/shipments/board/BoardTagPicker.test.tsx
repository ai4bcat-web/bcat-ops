// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BoardTagPicker, type BoardTagPickerProps } from './BoardTagPicker'
import type { DetailOption } from './detailSearch'

const OPTIONS: DetailOption[] = [
  { value: 'c1', label: 'Acme', count: 5 },
  { value: 'c2', label: 'Beta', count: 3 },
  { value: 'c3', label: 'Kansas', count: 2, codes: ['KS'] },
  { value: 'c4', label: 'Gamma', count: 1 },
  { value: 'c5', label: 'Delta', count: 1 },
  { value: 'c6', label: 'Epsilon', count: 1 },
  { value: 'c7', label: 'Zeta', count: 1 },
  { value: 'c8', label: 'Eta', count: 1 },
  { value: 'c9', label: 'Iota', count: 1 },
]

function renderPicker(props: Partial<BoardTagPickerProps> = {}) {
  return render(
    <BoardTagPicker
      facet="customer"
      label="Customer"
      options={OPTIONS}
      values={[]}
      exclude={false}
      onChange={vi.fn()}
      onExcludeChange={vi.fn()}
      recentStorageKey="tms-test"
      {...props}
    />,
  )
}

describe('BoardTagPicker', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('typing filters to a short list and caps at 8 rows', () => {
    renderPicker()
    const input = screen.getByPlaceholderText('Type to search…')
    fireEvent.change(input, { target: { value: 'a' } })
    const options = screen.getAllByRole('option')
    expect(options.length).toBeLessThanOrEqual(8)
  })

  it('matches a state code option via codes', () => {
    renderPicker()
    const input = screen.getByPlaceholderText('Type to search…')
    fireEvent.change(input, { target: { value: 'KS' } })
    expect(screen.getByRole('option', { name: /Kansas/i })).toBeInTheDocument()
  })

  it('turns two picks into two tags and reports both values', () => {
    const onChange = vi.fn()
    const { rerender } = renderPicker({ onChange })
    const input = screen.getByPlaceholderText('Type to search…')

    fireEvent.change(input, { target: { value: 'ac' } })
    fireEvent.click(screen.getByRole('option', { name: /Acme/i }))
    expect(onChange).toHaveBeenLastCalledWith(['c1'])

    rerender(<BoardTagPicker {...{ facet: 'customer', label: 'Customer', options: OPTIONS, values: ['c1'], exclude: false, onChange, onExcludeChange: vi.fn(), recentStorageKey: 'tms-test' }} />)

    fireEvent.change(input, { target: { value: 'be' } })
    fireEvent.click(screen.getByRole('option', { name: /Beta/i }))
    expect(onChange).toHaveBeenLastCalledWith(['c1', 'c2'])
  })

  it('removes a tag when its × is clicked', () => {
    const onChange = vi.fn()
    renderPicker({ values: ['c1', 'c2'], onChange })
    fireEvent.click(screen.getByRole('button', { name: /Remove Beta/i }))
    expect(onChange).toHaveBeenCalledWith(['c1'])
  })

  it('removes the last tag on Backspace in an empty input', () => {
    const onChange = vi.fn()
    renderPicker({ values: ['c1', 'c2'], onChange })
    const input = screen.getByPlaceholderText('Type to search…')
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onChange).toHaveBeenCalledWith(['c1'])
  })

  it('records recents and surfaces them first after remount', () => {
    const onChange = vi.fn()
    const { unmount } = renderPicker({ onChange })
    const input = screen.getByPlaceholderText('Type to search…')

    fireEvent.change(input, { target: { value: 'ac' } })
    fireEvent.click(screen.getByRole('option', { name: /Acme/i }))

    unmount()

    renderPicker()
    const reopened = screen.getByPlaceholderText('Type to search…')
    fireEvent.focus(reopened)
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent('Acme')
  })

  it('renders an unknown saved value as a raw tag', () => {
    renderPicker({ values: ['missing-id'] })
    expect(screen.getByText('missing-id')).toBeInTheDocument()
  })

  it('toggles exclude through the checkbox', () => {
    const onExcludeChange = vi.fn()
    renderPicker({ values: ['c1'], exclude: false, onExcludeChange })
    fireEvent.click(screen.getByRole('checkbox', { name: /Exclude/i }))
    expect(onExcludeChange).toHaveBeenCalledWith(true)
  })

  it('closes the list on Escape', () => {
    renderPicker()
    const input = screen.getByPlaceholderText('Type to search…')
    fireEvent.change(input, { target: { value: 'a' } })
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('navigates options with arrow keys and selects on Enter', () => {
    const onChange = vi.fn()
    renderPicker({ onChange })
    const input = screen.getByPlaceholderText('Type to search…')
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([expect.any(String)])
  })
})
