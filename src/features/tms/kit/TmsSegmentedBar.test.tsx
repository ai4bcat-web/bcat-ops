// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { TmsSegmentedBar } from './TmsSegmentedBar'
import { segmentShares } from './segmentShares'

describe('segmentShares', () => {
  it.each([[[33.3, 33.3, 33.4]], [[1, 1, 1]], [[1, 2, 4, 7]], [[0.1, 0.2, 0.7]]])('sums to exactly 100 for %j', (values) => {
    expect(segmentShares(values).reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('ignores negative and NaN segments', () => {
    expect(segmentShares([-5, Number.NaN, 10])).toEqual([0, 0, 100])
  })
})

describe('TmsSegmentedBar', () => {
  it('shows "No data" when the total is 0', () => {
    render(<TmsSegmentedBar ariaLabel="Aging" segments={[{ key: 'a', label: 'Current', value: 0 }]} />)
    expect(screen.getByText('No data')).toBeInTheDocument()
  })

  it('renders shares for each non-empty segment', () => {
    render(<TmsSegmentedBar ariaLabel="Aging" segments={[{ key: 'a', label: 'Current', value: 1 }, { key: 'b', label: 'Late', value: 1 }, { key: 'c', label: 'Gone', value: 0 }]} />)
    expect(screen.getAllByText('50%')).toHaveLength(2)
    expect(screen.queryByText('Gone')).toBeNull()
  })
})
