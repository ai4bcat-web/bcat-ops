// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { TmsMetaList } from './TmsMetaList'

describe('TmsMetaList', () => {
  it('renders empty values as a dash and skips hidden items', () => {
    render(<TmsMetaList items={[
      { label: 'A', value: '' },
      { label: 'B', value: null },
      { label: 'C', value: undefined },
      { label: 'Hidden', value: 'x', hidden: true },
      { label: 'Zero', value: 0 },
    ]} />)
    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(screen.queryByText('Hidden')).toBeNull()
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('marks wide items and picks the column class', () => {
    const { container } = render(<TmsMetaList columns={3} items={[{ label: 'Note', value: 'v', wide: true }]} />)
    expect(container.querySelector('dl')).toHaveClass('tms-meta-cols-3')
    expect(container.querySelector('.tms-meta-row')).toHaveClass('tms-meta-wide')
  })
})
