// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { TmsPillBarChart } from './TmsPillBarChart'

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return { ...actual, ResponsiveContainer: (props: React.ComponentProps<typeof actual.ResponsiveContainer>) => <actual.ResponsiveContainer {...props} width={800} height={300} /> }
})
const series = [{ key: 'a', label: 'Brokerage' }, { key: 'b', label: 'Assets' }]

describe('TmsPillBarChart', () => {
  it('always exposes the data as a table formatted by format()', () => {
    render(
      <TmsPillBarChart
        ariaLabel="Weekly revenue"
        series={series}
        format={(v) => `$${v / 100}`}
        data={[{ label: 'Oct 6', values: { a: 10000, b: 500 } }, { label: 'Oct 13', values: { a: 0 } }]}
      />,
    )
    const table = screen.getByRole('table', { name: 'Weekly revenue' })
    expect(table).toHaveTextContent('Oct 6')
    expect(table).toHaveTextContent('$100')
    expect(table).toHaveTextContent('$5')
    expect(table).toHaveTextContent('Brokerage')
  })

  it('says so when every value is zero', () => {
    render(<TmsPillBarChart ariaLabel="x" series={series} emptyText="Nothing yet" data={[{ label: 'w', values: { a: 0, b: 0 } }]} />)
    expect(screen.getByText('Nothing yet')).toBeInTheDocument()
  })
})
