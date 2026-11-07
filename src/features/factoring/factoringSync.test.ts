import { describe, expect, it } from 'vitest'
import { dollarsToCents, factoringChangesFor } from './factoringSync'

describe('factoringChangesFor', () => {
  it('turns the amount into cents and refuses anything that is not a positive amount', () => {
    expect(dollarsToCents('$1,234.50')).toBe(123_450)
    expect(dollarsToCents('1250')).toBe(125_000)
    for (const bad of ['', '0', '-5', '12.345', 'abc']) expect(dollarsToCents(bad)).toBeNull()
    expect(factoringChangesFor('InvoiceAmount', 'abc')).toMatchObject({ ok: false })
    expect(factoringChangesFor('InvoiceAmount', '99.10')).toEqual({ ok: true, changes: { invoiceAmountCents: 9910 } })
  })

  it('maps the PO to its own key and every other field to the queue row\'s manual fields', () => {
    expect(factoringChangesFor('PoNumber', ' PO-7 ')).toEqual({ ok: true, changes: { poNumber: 'PO-7' } })
    expect(factoringChangesFor('FromCity', 'Gary')).toEqual({ ok: true, changes: { otrManualFields: { FromCity: 'Gary' } } })
  })
})
