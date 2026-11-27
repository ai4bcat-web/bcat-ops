import { describe, it, expect } from 'vitest'
import { paidDirectNote, lumperSuggestion } from './paidDirect'

describe('paidDirectNote', () => {
  it('says how the freight figure was reached', () => {
    expect(paidDirectNote(500)).toBe('less $500.00 lumper paid direct to driver')
    expect(paidDirectNote(1234.5)).toBe('less $1,234.50 lumper paid direct to driver')
  })
  it('is empty when nothing was paid direct', () => {
    expect(paidDirectNote(0)).toBe('')
  })
})

describe('lumperSuggestion', () => {
  const charges = [
    { side: 'CUSTOMER', code: 'LINEHAUL', loadId: 'L1', amountCents: 315000 },
    { side: 'CUSTOMER', code: 'LUMPER', loadId: 'L1', amountCents: 50000 },
    { side: 'CARRIER', code: 'LUMPER', loadId: 'L1', amountCents: 40000 },
    { side: 'CUSTOMER', code: 'LUMPER', loadId: 'L2', amountCents: 9900 },
  ]
  it('is the load\'s customer lumper charge in dollars, never the carrier side or another load', () => {
    expect(lumperSuggestion(charges, 'L1')).toBe(500)
  })
  it('is null when the load has no lumper charge', () => {
    expect(lumperSuggestion(charges, 'L3')).toBeNull()
    expect(lumperSuggestion([], 'L1')).toBeNull()
  })
})
