// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ApDenseList, type ApListConfig } from './ApDenseList'

type R = { id: string; bill: string; carrier: string }
const rows: R[] = [{ id: '1', bill: '12464', carrier: 'TEX-LA LOGISTICS INC' }, { id: '2', bill: '12528', carrier: 'ROADMAX LLC' }]
const config: ApListConfig<R> = {
  gridId: 'ap-test',
  columns: [
    { key: 'bill', header: 'Bill', text: (r) => r.bill, render: (r) => r.bill },
    { key: 'carrier', header: 'Carrier', text: (r) => r.carrier, render: (r) => r.carrier },
  ],
  rows, rowKey: (r) => r.id,
}

describe('ApDenseList search', () => {
  it('narrows the rows to those containing every word, and shows the count', () => {
    render(<ApDenseList<R> config={config} email="a@b.test" onRefresh={vi.fn()} />)
    expect(screen.getByText('ROADMAX LLC')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('ap-search'), { target: { value: 'roadmax' } })
    expect(screen.queryByText('TEX-LA LOGISTICS INC')).toBeNull()
    expect(screen.getByText('ROADMAX LLC')).toBeInTheDocument()
    expect(screen.getByTestId('ap-count')).toHaveTextContent('1 of 2 items')
    fireEvent.change(screen.getByTestId('ap-search'), { target: { value: '' } })
    expect(screen.getByText('TEX-LA LOGISTICS INC')).toBeInTheDocument()
  })
})
