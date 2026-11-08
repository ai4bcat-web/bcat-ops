import { describe, expect, it } from 'vitest'
import { BILL_WRITABLE_COLUMNS, VENDOR_WRITABLE_COLUMNS, pickAllowed, planBillUpdate, planVendorUpdate } from './applyPlan'
import { fxBill, fxExtraction, fxVendor } from './fixtures'

const auto = { mode: 'AUTO' } as const

describe('planBillUpdate', () => {
  it('fills a placeholder IN_REVIEW bill together; billMonth follows billDate and variance follows billed', () => {
    const p = planBillUpdate(fxBill(), fxExtraction(), auto)
    expect(p.set).toEqual({
      billNumber: 'SH-5521', billDate: '2026-11-03', billMonth: '2026-11', dueAt: '2026-12-03', billedCents: 150_050, varianceCents: 50,
    })
  })

  it('billMonth always follows a billDate that crosses a month', () => {
    const p = planBillUpdate(fxBill(), fxExtraction({ invoiceDate: '2026-10-30', dueDate: '2026-11-29' }), auto)
    expect(p.set.billDate).toBe('2026-10-30')
    expect(p.set.billMonth).toBe('2026-10')
  })

  it('due-date ladder: stated, else invoice date + stated terms, else + the bill terms', () => {
    expect(planBillUpdate(fxBill(), fxExtraction({ dueDate: null, termsDays: 45 }), auto).set.dueAt).toBe('2026-12-18')
    expect(planBillUpdate(fxBill({ termsDays: 15 }), fxExtraction({ dueDate: null, termsDays: null }), auto).set.dueAt).toBe('2026-11-18')
  })

  it('a due date before the bill date is skipped, the rest still written', () => {
    const p = planBillUpdate(fxBill(), fxExtraction({ dueDate: '2026-11-02', invoiceDate: '2026-11-03' }), auto)
    expect(p.set.dueAt).toBeUndefined()
    expect(p.skipped).toContainEqual({ field: 'dueAt', reason: 'DUE_BEFORE_BILL_DATE' })
    expect(p.set.billNumber).toBe('SH-5521')
  })

  it('TO_BE_PAID: number and dates only, never the amount', () => {
    const p = planBillUpdate(fxBill({ status: 'TO_BE_PAID' }), fxExtraction(), auto)
    expect(Object.keys(p.set).sort()).toEqual(['billDate', 'billMonth', 'billNumber', 'dueAt'])
    expect(p.skipped).toContainEqual({ field: 'billedCents', reason: 'STATUS' })
  })

  it('PARTIAL: nothing is written', () => {
    const p = planBillUpdate(fxBill({ status: 'PARTIAL' }), fxExtraction(), auto)
    expect(p.set).toEqual({})
  })

  it('the amount is written only when nobody entered one (billed == gross) and it is not far off', () => {
    expect(planBillUpdate(fxBill({ billedCents: 149_000 }), fxExtraction(), auto).conflicts.map((c) => c.field)).toEqual(['billedCents'])
    expect(planBillUpdate(fxBill(), fxExtraction({ amountCents: 400_000 }), auto).skipped).toContainEqual({ field: 'billedCents', reason: 'AMOUNT_FAR' })
  })

  it('a typed bill number is never overwritten: AUTO writes nothing when anything conflicts', () => {
    const bill = fxBill({ billNumber: 'OLD-1', billDate: '2026-10-01', dueAt: '2026-10-31' })
    const p = planBillUpdate(bill, fxExtraction(), auto)
    expect(p.placeholder).toBe(false)
    expect(p.conflicts.map((c) => c.field)).toEqual(['billNumber', 'billDate', 'dueAt', 'billedCents'])
    expect(p.set).toEqual({})
  })

  it('equal values are a no-op', () => {
    const bill = fxBill({ billNumber: 'SH-5521', billDate: '2026-11-03', dueAt: '2026-12-03', billedCents: 150_050 })
    const p = planBillUpdate(bill, fxExtraction(), auto)
    expect(p.fields).toEqual([])
    expect(p.conflicts).toEqual([])
  })

  it('HUMAN may tick a conflict; unticked conflicts stay unwritten; defaults are the non-conflicts', () => {
    const bill = fxBill({ billNumber: 'OLD-1', billDate: '2026-10-01', dueAt: '2026-10-31' })
    const ext = fxExtraction({ invoiceNumber: 'OLD1', amountCents: 150_000 })
    const none = planBillUpdate(bill, ext, { mode: 'HUMAN' })
    expect(none.conflicts.map((c) => c.field)).toEqual(['billDate', 'dueAt'])
    expect(none.set).toEqual({})
    const picked = planBillUpdate(bill, ext, { mode: 'HUMAN', picks: { billDate: true } })
    expect(picked.set).toEqual({ billDate: '2026-11-03', billMonth: '2026-11' })
  })

  it('HUMAN cannot pick the amount on a TO_BE_PAID bill', () => {
    const p = planBillUpdate(fxBill({ status: 'TO_BE_PAID' }), fxExtraction(), { mode: 'HUMAN', picks: { billedCents: true } })
    expect(p.set.billedCents).toBeUndefined()
  })

  it('the result keys are always a subset of the D8 allow-list', () => {
    for (const status of ['IN_REVIEW', 'TO_BE_PAID', 'PARTIAL'] as const) {
      for (const mode of ['AUTO', 'HUMAN'] as const) {
        const p = planBillUpdate(fxBill({ status }), fxExtraction(), { mode, picks: { billNumber: true, billDate: true, dueAt: true, billedCents: true } })
        for (const k of Object.keys(p.set)) expect(BILL_WRITABLE_COLUMNS as readonly string[]).toContain(k)
      }
    }
  })
})

describe('planVendorUpdate', () => {
  const ext = fxExtraction({ pros: [], issuer: { name: 'Acme Tire Co', kind: 'VENDOR', mc: null, dot: null }, invoiceNumber: 'AT-7781', amountCents: 48_000 })

  it('fills blanks only', () => {
    const p = planVendorUpdate(fxVendor(), ext, auto)
    expect(p.set).toEqual({ invoiceDate: '2026-11-03', dueDate: '2026-12-03' })
  })

  it('a differing non-blank value is a conflict and blocks AUTO', () => {
    const p = planVendorUpdate(fxVendor({ invoiceDate: '2026-10-01' }), ext, auto)
    expect(p.conflicts.map((c) => c.field)).toEqual(['invoiceDate'])
    expect(p.set).toEqual({})
  })

  it('amount only when the model was sure', () => {
    const p = planVendorUpdate(fxVendor({ amount: null }), { ...ext, confidence: 'medium' }, auto)
    expect(p.set.amount).toBeUndefined()
    expect(planVendorUpdate(fxVendor({ amount: null }), ext, auto).set.amount).toBe(48_000)
  })

  it('stays inside the vendor allow-list', () => {
    for (const k of Object.keys(planVendorUpdate(fxVendor({ vendor: null, amount: null }), ext, auto).set)) {
      expect(VENDOR_WRITABLE_COLUMNS as readonly string[]).toContain(k)
    }
  })
})

describe('pickAllowed', () => {
  it('drops every key off the list (status, money, payee, approval)', () => {
    const out = pickAllowed({ billNumber: 'X', status: 'PAID', paidCents: 1, remitTo: 'evil', approvedAt: 'x' }, BILL_WRITABLE_COLUMNS)
    expect(out).toEqual({ billNumber: 'X' })
  })
})
