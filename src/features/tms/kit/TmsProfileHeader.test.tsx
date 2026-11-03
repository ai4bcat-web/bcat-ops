// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { Truck } from 'lucide-react'
import { TmsProfileHeader } from './TmsProfileHeader'
import { initialsOf } from './initialsOf'

describe('initialsOf', () => {
  it('derives initials from names, emails and empty text', () => {
    expect(initialsOf('Ryne Sanchez')).toBe('RS')
    expect(initialsOf('ryne@x.com')).toBe('R')
    expect(initialsOf('')).toBe('?')
    expect(initialsOf('Cher')).toBe('C')
  })
})

describe('TmsProfileHeader', () => {
  it('renders the requested heading level', () => {
    render(<TmsProfileHeader as="h1" name="PRO 123" icon={Truck} />)
    expect(screen.getByRole('heading', { level: 1, name: 'PRO 123' })).toBeInTheDocument()
  })

  it('omits hidden rows and columns left with no rows', () => {
    render(<TmsProfileHeader name="Acme" columns={[
      { title: 'Billing', rows: [{ label: 'MC', value: '123' }, { label: 'DOT', value: '999', hidden: true }] },
      { title: 'Empty', rows: [{ value: 'x', hidden: true }] },
    ]} />)
    expect(screen.getByText('123')).toBeInTheDocument()
    expect(screen.queryByText('999')).toBeNull()
    expect(screen.queryByText('Empty')).toBeNull()
  })
})
