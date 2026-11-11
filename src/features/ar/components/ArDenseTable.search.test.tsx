// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArDenseTable, type ArGrid } from './ArDenseTable'

vi.mock('@/hooks/useAuth', () => ({ useAuthUser: () => ({ email: 'a@b.test' }) }))

type R = { id: string; invoice: string; customer: string; balance: string }
const rows: R[] = [
  { id: '1', invoice: '20001', customer: 'THE ROYAL GROUP', balance: '$85,406.50' },
  { id: '2', invoice: '20002', customer: 'DANISCO US INC.', balance: '$73,664.96' },
]
const grid: ArGrid<R> = {
  gridId: 'ar-test', label: 'AR test', rowKey: (r) => r.id, empty: 'none', rows,
  columns: [
    { key: 'invoice', header: 'Invoice', text: (r) => r.invoice },
    { key: 'customer', header: 'Customer', text: (r) => r.customer },
    { key: 'balance', header: 'Balance', text: (r) => r.balance },
  ],
  renderCell: (r, key) => r[key as keyof R],
}

describe('ArDenseTable search', () => {
  it('narrows the rows by any visible text, including an amount typed without symbols', () => {
    render(<ArDenseTable<R> grid={grid} />)
    expect(screen.getByText('DANISCO US INC.')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('ar-search'), { target: { value: 'royal' } })
    expect(screen.queryByText('DANISCO US INC.')).toBeNull()
    expect(screen.getByText('THE ROYAL GROUP')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 rows')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('ar-search'), { target: { value: '73664.96' } })
    expect(screen.getByText('DANISCO US INC.')).toBeInTheDocument()
    expect(screen.queryByText('THE ROYAL GROUP')).toBeNull()
  })
})
