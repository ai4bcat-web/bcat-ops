import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIX_LINE_LIMIT, fitFixItems, fixLinesOf } from './fixChips'

describe('What to fix chips', () => {
  const many = ['POD missing', 'Rate con missing', 'No expense entered', 'Profit not available', 'Stop 2 needs an appointment', 'No AP e-mail on the customer', 'Pickup ZIP missing for factoring']

  it('keeps a short list whole', () => {
    expect(fitFixItems(['POD missing', 'Rate con missing'], 2)).toEqual({ shown: ['POD missing', 'Rate con missing'], hidden: 0 })
  })

  it('fits a long list in the line limit and counts the rest, so nothing is lost', () => {
    const { shown, hidden } = fitFixItems(many, FIX_LINE_LIMIT.compact)
    expect(shown.length + hidden).toBe(many.length)
    expect(hidden).toBeGreaterThan(0)
    expect(fixLinesOf([...shown, `+${hidden} more`])).toBeLessThanOrEqual(FIX_LINE_LIMIT.compact)
  })

  it('shows more in comfortable than in compact', () => {
    expect(fitFixItems(many, FIX_LINE_LIMIT.comfortable).shown.length).toBeGreaterThan(fitFixItems(many, FIX_LINE_LIMIT.compact).shown.length)
  })

  it('always shows at least the first item', () => {
    expect(fitFixItems(['x'.repeat(200), 'y'], 1).shown).toEqual(['x'.repeat(200)])
  })
})

describe('Load Review scrolling', () => {
  it('bounds the page to the scrolling column on desktop so the grid body scrolls', () => {
    const css = readFileSync(resolve(__dirname, 'loadReview.css'), 'utf8')
    expect(css).toMatch(/\.tms-shell\.tms-scroll-main \.aa-load-review \{[^}]*display: flex;[^}]*min-height: 0;/)
    expect(css).toMatch(/\.aa-load-review > \.tms-dense-page \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/)
  })
})
