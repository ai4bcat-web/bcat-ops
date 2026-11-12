// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { LifecycleTabs } from './LifecycleTabs'

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function setup(pathname: string, canOpenPage: (k: string) => boolean = () => true, badgeCounts?: Record<string, number>) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <LifecycleTabs pathname={pathname} canOpenPage={canOpenPage} badgeCounts={badgeCounts} />
      <input aria-label="field" />
      <Where />
    </MemoryRouter>,
  )
}

describe('LifecycleTabs', () => {
  it('draws the six tabs in flow order and lights the one for the page', () => {
    setup('/tms/carrier-sales')
    const nav = screen.getByRole('navigation', { name: 'Shipment lifecycle' })
    expect(nav.querySelectorAll('a')).toHaveLength(6)
    expect([...nav.querySelectorAll('a')].map((a) => a.getAttribute('data-testid'))).toEqual(
      ['quote', 'build', 'view', 'book', 'track', 'review'].map((k) => `lifecycle-tab-${k}`),
    )
    expect(screen.getByTestId('lifecycle-tab-book')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('lifecycle-tab-book')).toHaveClass('tms-active')
    expect(screen.getByTestId('lifecycle-tab-track')).not.toHaveAttribute('aria-current')
  })

  it('tints only the tabs before the lit one as done', () => {
    setup('/tms/shipments/SHP-1')
    for (const key of ['quote', 'build']) expect(screen.getByTestId(`lifecycle-tab-${key}`)).toHaveClass('tms-lifecycle-done')
    for (const key of ['view', 'book', 'track', 'review']) expect(screen.getByTestId(`lifecycle-tab-${key}`)).not.toHaveClass('tms-lifecycle-done')
  })

  it('lights nothing and tints nothing on a page outside the flow', () => {
    setup('/tms/customers')
    expect(document.querySelector('.tms-active, .tms-lifecycle-done')).toBeNull()
  })

  it('shows count badges for non-zero counts only', () => {
    setup('/tms/rates', () => true, { quotesToReply: 3, intakeLoads: 2, loadReview: 120, carrierSales: 0 })
    expect(screen.getByTestId('lifecycle-badge-quote')).toHaveTextContent('3')
    expect(screen.getByTestId('lifecycle-badge-build')).toHaveTextContent('2')
    expect(screen.getByTestId('lifecycle-badge-review')).toHaveTextContent('120')
    expect(screen.queryByTestId('lifecycle-badge-book')).not.toBeInTheDocument()
    expect(screen.queryByTestId('lifecycle-badge-view')).not.toBeInTheDocument()
  })

  it('badges View with the active shipment count', () => {
    setup('/tms/shipments', () => true, { activeShipments: 123 })
    expect(screen.getByTestId('lifecycle-badge-view')).toHaveTextContent('123')
  })

  it('draws five tabs for a user who may not open Load Review', () => {
    setup('/tms/rates', (k) => k !== 'loadReview')
    expect(screen.getAllByTestId(/^lifecycle-tab-/)).toHaveLength(5)
    expect(screen.queryByTestId('lifecycle-tab-review')).not.toBeInTheDocument()
  })

  it('jumps with Alt+digit, but not while typing and not to a hidden tab', () => {
    setup('/tms/rates', (k) => k !== 'loadReview')
    fireEvent.keyDown(window, { altKey: true, code: 'Digit4' })
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/carrier-sales')
    fireEvent.keyDown(window, { altKey: true, code: 'Digit6' })
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/carrier-sales')
    fireEvent.keyDown(screen.getByLabelText('field'), { altKey: true, code: 'Digit5' })
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/carrier-sales')
    fireEvent.keyDown(window, { altKey: true, code: 'Digit5' })
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/tracking')
  })

  it('the Quote tab links the inbox and stays lit on the Quotes tab', () => {
    setup('/tms/rates')
    expect(screen.getByTestId('lifecycle-tab-quote')).toHaveAttribute('href', '/tms/rates/spot')
    expect(screen.getByTestId('lifecycle-tab-quote')).toHaveAttribute('aria-current', 'page')
  })

  it('scrolls the lit tab into view so a narrow, scrolling strip never hides it', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const view = setup('/tms/load-review')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByTestId('lifecycle-tab-review'))
    view.unmount()
  })
})
