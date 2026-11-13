// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TmsHeadBand, TmsListCard } from './TmsListCard'

describe('TmsListCard', () => {
  it('renders label, sub-text and value rows; a clickable row is a button', () => {
    const onClick = vi.fn()
    render(<TmsListCard title="Payables" rows={[
      { key: 'a', label: 'Past due', value: '$10.00', sub: '1 bill', tone: 'bad', onClick },
      { key: 'b', label: 'Avg days', value: null },
    ]} />)
    expect(screen.getByRole('region', { name: 'Payables' })).toBeTruthy()
    expect(screen.getByText('1 bill')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
    const btn = screen.getByRole('button', { name: /Past due/ })
    expect(btn.className).toContain('tms-list-row-tone-bad')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Avg days/ })).toBeNull()
  })

  it('shows shares as percents only when a row has one', () => {
    render(<TmsListCard title="By division" total="$100.00" rows={[
      { key: 'x', label: 'BCAT', value: '$65.00', share: 0.65 },
      { key: 'y', label: 'Local', value: '$35.00', share: 0.35, kind: 'sub' },
    ]} />)
    expect(screen.getByText('$100.00')).toBeTruthy()
    expect(screen.getByText('65%')).toBeTruthy()
    expect(screen.getByText('Local').closest('.tms-list-row')?.className).toContain('tms-list-row-sub')
  })
})

describe('TmsHeadBand', () => {
  it('places cards beside the tabs, and drops the cards column when there are none', () => {
    const { container, rerender } = render(<TmsHeadBand top={<span>tabs</span>} bottom={<span>status</span>} cards={<span>cards</span>} />)
    expect(container.querySelector('.tms-head-band-cards')?.textContent).toBe('cards')
    rerender(<TmsHeadBand top={<span>tabs</span>} bottom={<span>status</span>} />)
    expect(container.querySelector('.tms-head-band-cards')).toBeNull()
    expect(container.querySelector('.tms-head-band-plain')).toBeTruthy()
  })
})
