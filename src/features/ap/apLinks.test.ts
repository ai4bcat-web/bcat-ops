import { describe, expect, it } from 'vitest'
import { AP_FROM_AUTO_SHIPPER, clearApIntent, openBillPath, payBillPath, readApIntent, recordLegBillPath } from './apLinks'

describe('AP deep links', () => {
  it('builds a pay link that reads back as a pay intent and remembers where it came from', () => {
    const path = payBillPath('bill 1', AP_FROM_AUTO_SHIPPER)
    expect(path.startsWith('/tms/invoicing/payable?')).toBe(true)
    const q = new URLSearchParams(path.split('?')[1])
    expect(readApIntent(q)).toEqual({ kind: 'pay', billId: 'bill 1' })
    expect(q.get('from')).toBe('auto-shipper-loads')
  })

  it('opens the Expected tab on the Record bill dialog for a leg with no bill', () => {
    const q = new URLSearchParams(recordLegBillPath('leg-9').split('?')[1])
    expect(q.get('tab')).toBe('expected')
    expect(readApIntent(q)).toEqual({ kind: 'record', legId: 'leg-9' })
  })

  it('reads an open link, and nothing from a plain AP URL', () => {
    expect(readApIntent(new URLSearchParams(openBillPath('b2').split('?')[1]))).toEqual({ kind: 'open', billId: 'b2' })
    expect(readApIntent(new URLSearchParams('tab=aging'))).toBeNull()
  })

  it('clears the one-time params and keeps the back link', () => {
    const q = clearApIntent(new URLSearchParams('payBill=b1&from=auto-shipper-loads&tab=aging'))
    expect(q.get('payBill')).toBeNull()
    expect(q.get('from')).toBe('auto-shipper-loads')
    expect(q.get('tab')).toBe('aging')
  })
})
