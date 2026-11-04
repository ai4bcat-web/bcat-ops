// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ReviewRequirementsField } from './ReviewRequirementsField'

describe('ReviewRequirementsField', () => {
  it('on a customer it follows the org default until told otherwise, and shows that list read-only', () => {
    render(<ReviewRequirementsField value={null} inheritFrom={['salesRep']} onChange={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: 'Use the organization default' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Sales rep' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Sales rep' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'POD received' })).not.toBeChecked()
  })

  it('unticking the default starts the customer from the org list; a tick then saves an explicit list', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ReviewRequirementsField value={null} inheritFrom={['salesRep']} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use the organization default' }))
    expect(onChange).toHaveBeenLastCalledWith(['salesRep'])
    rerender(<ReviewRequirementsField value={['salesRep']} inheritFrom={['salesRep']} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'POD received' }))
    expect(onChange).toHaveBeenLastCalledWith(['podReceived', 'salesRep'])
  })

  it('returning to the default clears the override to null', () => {
    const onChange = vi.fn()
    render(<ReviewRequirementsField value={['revDivision']} inheritFrom={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use the organization default' }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('the org editor has no inherit switch and starts from the built-in seven', () => {
    render(<ReviewRequirementsField value={null} onChange={vi.fn()} />)
    expect(screen.queryByRole('checkbox', { name: 'Use the organization default' })).toBeNull()
    expect(screen.getAllByRole('checkbox').every((box) => (box as HTMLInputElement).checked)).toBe(true)
    expect(screen.getAllByRole('checkbox')).toHaveLength(7)
  })
})
