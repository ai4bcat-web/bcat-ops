import { describe, it, expect } from 'vitest'
import { mergeExtraction } from './merge'

const x = { vendor: 'Lyons Truck Parts', invoiceNumber: '157588', amountDollars: 1234.56, invoiceDate: '2026-10-01', dueDate: '2026-10-31', confidence: 'high' as const, note: null }

describe('mergeExtraction', () => {
  it('fills every blank, in cents', () => {
    expect(mergeExtraction({ id: 'r' }, x)).toEqual({ vendor: 'Lyons Truck Parts', invoiceNumber: '157588', amount: 123456, invoiceDate: '2026-10-01', dueDate: '2026-10-31' })
  })
  it('never overwrites what a person typed', () => {
    expect(mergeExtraction({ id: 'r', vendor: 'Lyons', amount: 100, invoiceDate: '2026-09-30' }, x)).toEqual({ invoiceNumber: '157588', dueDate: '2026-10-31' })
  })
  it('leaves a low-confidence amount, a zero, and a malformed date alone', () => {
    expect(mergeExtraction({ id: 'r' }, { ...x, confidence: 'low' })).not.toHaveProperty('amount')
    expect(mergeExtraction({ id: 'r' }, { ...x, amountDollars: 0 })).not.toHaveProperty('amount')
    expect(mergeExtraction({ id: 'r' }, { ...x, dueDate: '10/31/2026' })).not.toHaveProperty('dueDate')
    expect(mergeExtraction({ id: 'r' }, { ...x, vendor: '  ' })).not.toHaveProperty('vendor')
  })
})
