// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RemitToCell } from './RemitToCell'

describe('RemitToCell', () => {
  it('shows the e-mail with the remit address under it when one is on file', () => {
    render(<RemitToCell email="ap@triumph.test" label="Triumph" address="1 Main St, Dallas, TX 75001" onAdd={vi.fn()} />)
    expect(screen.getByText('ap@triumph.test')).toBeTruthy()
    expect(screen.getByTestId('remit-address').textContent).toBe('1 Main St, Dallas, TX 75001')
  })

  it('shows only the e-mail when there is no address', () => {
    render(<RemitToCell email="ap@triumph.test" label="Triumph" onAdd={vi.fn()} />)
    expect(screen.queryByTestId('remit-address')).toBeNull()
  })

  it('offers Add remit e-mail when there is none, and still shows an address that is on file', () => {
    render(<RemitToCell email="" label="Triumph" address="1 Main St, Dallas, TX 75001" onAdd={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Add remit e-mail for Triumph' })).toBeTruthy()
    expect(screen.getByTestId('remit-address')).toBeTruthy()
  })
})
