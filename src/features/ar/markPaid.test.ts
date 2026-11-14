import { describe, expect, it } from 'vitest'
import { applyDefaults, editRow, initialRows, planPostings, rowProblem } from './markPaid'
import type { InvoiceRecord } from '@/types/tms'

const inv = (id: string, customerId: string, balanceCents: number): InvoiceRecord =>
  ({ id, number: id, customerId, balanceCents, status: 'ISSUED' } as InvoiceRecord)
const invoices = [inv('i1', 'c1', 100_00), inv('i2', 'c1', 250_00), inv('i3', 'c2', 75_50)]
const byId = new Map(invoices.map((i) => [i.id, i]))
const defaults = { paidOn: '2026-11-10', method: 'CHECK' as const, reference: '1042' }

describe('mark paid', () => {
  it('starts each row at its open balance and the defaults', () => {
    const rows = initialRows(invoices, defaults)
    expect(rows.map((r) => r.amount)).toEqual(['100.00', '250.00', '75.50'])
    expect(rows.every((r) => r.paidOn === '2026-11-10' && r.reference === '1042')).toBe(true)
  })

  it('a new default only reaches rows not edited by hand', () => {
    let rows = initialRows(invoices, defaults)
    rows = editRow(rows, 'i2', { reference: '2001', method: 'ACH' })
    rows = applyDefaults(rows, { paidOn: '2026-11-12', method: 'CHECK', reference: '1043' })
    expect(rows.find((r) => r.invoiceId === 'i1')).toMatchObject({ paidOn: '2026-11-12', reference: '1043', method: 'CHECK' })
    expect(rows.find((r) => r.invoiceId === 'i2')).toMatchObject({ paidOn: '2026-11-12', reference: '2001', method: 'ACH' })
  })

  it('needs a check # on a paper check, a date not in the future, and no more than the balance', () => {
    const [row] = initialRows([invoices[0]], { ...defaults, reference: '' })
    expect(rowProblem(row, invoices[0], '2026-11-14')).toMatch(/Check #/)
    expect(rowProblem({ ...row, method: 'ACH' }, invoices[0], '2026-11-14')).toBeNull()
    expect(rowProblem({ ...row, reference: '9', paidOn: '2026-11-20' }, invoices[0], '2026-11-14')).toMatch(/future/)
    expect(rowProblem({ ...row, reference: '9', amount: '100.01' }, invoices[0], '2026-11-14')).toMatch(/open balance/)
    expect(rowProblem({ ...row, reference: '9', amount: '40' }, invoices[0], '2026-11-14')).toBeNull()
  })

  it('posts one payment per customer + date + method + check #, with partial amounts as typed', () => {
    let rows = initialRows(invoices, defaults)
    rows = editRow(rows, 'i2', { amount: '200' })
    const postings = planPostings(rows, byId)
    expect(postings).toHaveLength(2)
    expect(postings[0]).toMatchObject({
      customerId: 'c1', receivedAt: '2026-11-10', method: 'CHECK', reference: '1042', amountCents: 300_00,
      applications: [{ invoiceId: 'i1', amountCents: 100_00 }, { invoiceId: 'i2', amountCents: 200_00 }],
    })
    expect(postings[1]).toMatchObject({ customerId: 'c2', amountCents: 75_50 })
    rows = editRow(rows, 'i1', { reference: '1099' })
    expect(planPostings(rows, byId)).toHaveLength(3)
  })
})
