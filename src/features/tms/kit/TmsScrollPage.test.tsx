// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TmsScrollPage } from './TmsScrollPage'

describe('TmsScrollPage', () => {
  it('renders the title as the only h1, with actions and toolbar after it in order', () => {
    const { container } = render(
      <TmsScrollPage title="Fleet" subtitle="All trucks" actions={<button>Add</button>} toolbar={<input aria-label="filter" />}>
        <p>body</p>
      </TmsScrollPage>,
    )
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Fleet')
    const order = [screen.getByRole('heading', { level: 1 }), screen.getByText('Add'), screen.getByLabelText('filter')]
    order.slice(1).forEach((el, i) => {
      expect(order[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
    expect(container.querySelector('.tms-scroll-body')).toContainElement(screen.getByText('body'))
  })

  it('is a scroll container by default and a non-scrolling flex column with scroll={false}', () => {
    const { container, rerender } = render(<TmsScrollPage title="A">x</TmsScrollPage>)
    expect(container.firstElementChild).not.toHaveClass('tms-scroll-page-fill')
    rerender(<TmsScrollPage title="A" scroll={false}>x</TmsScrollPage>)
    expect(container.firstElementChild).toHaveClass('tms-scroll-page-fill')
  })

  it('pins the head only when asked', () => {
    const { container, rerender } = render(<TmsScrollPage title="A">x</TmsScrollPage>)
    expect(container.firstElementChild).not.toHaveClass('tms-scroll-page-sticky')
    rerender(<TmsScrollPage title="A" stickyHead>x</TmsScrollPage>)
    expect(container.firstElementChild).toHaveClass('tms-scroll-page-sticky')
  })
})
