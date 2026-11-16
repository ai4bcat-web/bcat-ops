// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { CustomerRecord } from '@/types/tms'
import { CustomerSearch } from './CustomerSearch'

const c = (id: string, name: string): CustomerRecord => ({ id, name, aliases: [], createdAt: '', updatedAt: '' } as CustomerRecord)
const customers = [c('b', 'Batory Foods'), c('a', 'Acme Trucking')]

describe('CustomerSearch', () => {
  it('suggests as you type and picks with a click', () => {
    const onSelect = vi.fn()
    render(<CustomerSearch customers={customers} openByCustomer={new Map([['b', 12_345]])} selectedId={null} onSelect={onSelect} />)
    const box = screen.getByRole('combobox', { name: 'Search customers' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'bat' } })
    expect(screen.getByText('Batory Foods')).toBeTruthy()
    expect(screen.getByText('$123.45 open')).toBeTruthy()
    fireEvent.click(screen.getByText('Batory Foods'))
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('picks the highlighted suggestion with Enter', () => {
    const onSelect = vi.fn()
    render(<CustomerSearch customers={customers} openByCustomer={new Map()} selectedId={null} onSelect={onSelect} />)
    const box = screen.getByRole('combobox', { name: 'Search customers' })
    fireEvent.change(box, { target: { value: 'acme' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  it('shows the picked customer as a chip with an × that goes back to everyone', () => {
    const onSelect = vi.fn()
    render(<CustomerSearch customers={customers} openByCustomer={new Map()} selectedId="b" selectedName="Batory Foods" onSelect={onSelect} />)
    expect(screen.getByTestId('customer-search-selected').textContent).toContain('Batory Foods')
    fireEvent.click(screen.getByRole('button', { name: 'Show all customers' }))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('says so when nobody matches', () => {
    render(<CustomerSearch customers={customers} openByCustomer={new Map()} selectedId={null} onSelect={() => {}} />)
    const box = screen.getByRole('combobox', { name: 'Search customers' })
    fireEvent.change(box, { target: { value: 'zzzz' } })
    expect(screen.getByText('No customer matches.')).toBeTruthy()
  })
})
