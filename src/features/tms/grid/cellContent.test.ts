import { describe, expect, it } from 'vitest'
import { cellContent } from './denseGridModel'

const col = { key: 'amount', text: (r: { cents: number }) => `$${r.cents / 100}` }

describe('cellContent', () => {
  it("draws the column's text when renderCell returns undefined (the blank-cell bug, 2026-11-15)", () => {
    expect(cellContent(() => undefined, { cents: 500 }, col)).toBe('$5')
  })
  it('draws what renderCell returns, and nothing for an explicit null', () => {
    expect(cellContent(() => 'custom', { cents: 500 }, col)).toBe('custom')
    expect(cellContent(() => null, { cents: 500 }, col)).toBeNull()
  })
  it('draws the text when there is no renderCell', () => {
    expect(cellContent(undefined, { cents: 500 }, col)).toBe('$5')
  })
})
