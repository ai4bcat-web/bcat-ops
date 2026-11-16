import { describe, expect, it } from 'vitest'
import { cellContent } from './cellContent'

describe('cellContent', () => {
  const col = { key: 'amount', text: (row: { amount: string }) => row.amount }
  const row = { amount: '$5.00' }

  it("falls back to the column's text when renderCell has nothing for that column (the blank Aging / Payments received cells)", () => {
    expect(cellContent(() => undefined, row, col)).toBe('$5.00')
    expect(cellContent(undefined, row, col)).toBe('$5.00')
  })

  it('keeps what renderCell draws, and null still draws nothing', () => {
    expect(cellContent(() => 'custom', row, col)).toBe('custom')
    expect(cellContent(() => null, row, col)).toBeNull()
  })
})
