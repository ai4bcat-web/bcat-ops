// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

const spot = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/features/spot-quoter/useSpotRequests', () => ({ useSpotNewCount: () => spot.count }))
vi.mock('@/features/spot-quoter/SpotInboxPage', () => ({ SpotInboxPage: () => <div data-testid="body-inbox" /> }))
vi.mock('./QuotesPage', () => ({ QuotesPage: () => <div data-testid="body-quotes" /> }))

import { QuotePage } from './QuotePage'

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function draw(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tms/rates" element={<QuotePage tab="quotes" />} />
        <Route path="/tms/rates/spot" element={<QuotePage tab="inbox" />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
}

describe('QuotePage', () => {
  it('lists Quote inbox first, Quotes second, and lights the tab for the URL', () => {
    draw('/tms/rates/spot')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Quote inbox', 'Quotes'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('body-inbox')).toBeInTheDocument()
    expect(screen.queryByTestId('body-quotes')).toBeNull()
  })

  it('draws the Quotes body at /tms/rates and moves between tabs through the URL', () => {
    draw('/tms/rates')
    expect(screen.getByTestId('body-quotes')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Quotes' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'Quote inbox' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/rates/spot')
    expect(screen.getByTestId('body-inbox')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Quotes' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/tms\/rates$/)
  })

  it('puts the new-request count on the inbox tab only, and none when zero', () => {
    spot.count = 4
    const { unmount } = draw('/tms/rates')
    expect(screen.getByRole('tab', { name: /Quote inbox/ })).toHaveTextContent('4')
    expect(screen.getByRole('tab', { name: /^Quotes/ })).not.toHaveTextContent(/\d/)
    unmount()
    spot.count = 0
    draw('/tms/rates')
    expect(screen.getByRole('tab', { name: 'Quote inbox' })).toHaveTextContent(/^Quote inbox$/)
  })
})
