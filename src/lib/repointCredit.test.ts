// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { planRepointCredit, type RepointInvoiceInput } from './repointCredit'

function invoice(over: Partial<RepointInvoiceInput> & { id: string }): RepointInvoiceInput {
  return {
    number: null,
    status: 'ISSUED',
    totalCents: 0,
    paidCents: 0,
    writtenOffCents: 0,
    balanceCents: 0,
    ...over,
  }
}

describe('planRepointCredit', () => {
  it('credits an unpaid invoice for its full balance with no unapplied remainder', () => {
    const plan = planRepointCredit([
      invoice({ id: 'inv-1', number: 'INV-000025', status: 'ISSUED', totalCents: 250_000, balanceCents: 250_000 }),
    ])
    expect(plan.refusal).toBeNull()
    expect(plan.moneyApplied).toBe(false)
    expect(plan.totalCreditCents).toBe(250_000)
    expect(plan.totalAppliedCents).toBe(250_000)
    expect(plan.totalUnappliedCents).toBe(0)
    expect(plan.entries).toEqual([
      { invoiceId: 'inv-1', number: 'INV-000025', creditCents: 250_000, appliedCents: 250_000, unappliedCents: 0, orderId: null },
    ])
  })

  it('credits a partly paid invoice for the full total and leaves the paid portion unapplied', () => {
    // Total $2,500; $1,500 paid; $1,000 open balance.
    const plan = planRepointCredit([
      invoice({ id: 'inv-2', number: 'INV-000025', status: 'PARTIAL', totalCents: 250_000, paidCents: 150_000, balanceCents: 100_000 }),
    ])
    expect(plan.refusal).toBeNull()
    expect(plan.moneyApplied).toBe(true)
    expect(plan.totalCreditCents).toBe(250_000)
    expect(plan.totalAppliedCents).toBe(100_000)
    expect(plan.totalUnappliedCents).toBe(150_000)
    expect(plan.entries[0].creditCents).toBe(250_000)
    expect(plan.entries[0].appliedCents).toBe(100_000)
    expect(plan.entries[0].unappliedCents).toBe(150_000)
  })

  it('credits a fully paid invoice for the full total with nothing applied', () => {
    const plan = planRepointCredit([
      invoice({ id: 'inv-3', number: 'INV-000026', status: 'PAID', totalCents: 300_000, paidCents: 300_000, balanceCents: 0 }),
    ])
    expect(plan.refusal).toBeNull()
    expect(plan.moneyApplied).toBe(true)
    expect(plan.totalCreditCents).toBe(300_000)
    expect(plan.totalAppliedCents).toBe(0)
    expect(plan.totalUnappliedCents).toBe(300_000)
    expect(plan.entries[0].appliedCents).toBe(0)
    expect(plan.entries[0].unappliedCents).toBe(300_000)
  })

  it('handles a mix of unpaid, partly paid and fully paid invoices', () => {
    const plan = planRepointCredit([
      invoice({ id: 'inv-a', number: 'A', status: 'ISSUED', totalCents: 100_000, balanceCents: 100_000 }),
      invoice({ id: 'inv-b', number: 'B', status: 'PARTIAL', totalCents: 200_000, paidCents: 50_000, balanceCents: 150_000 }),
      invoice({ id: 'inv-c', number: 'C', status: 'PAID', totalCents: 300_000, paidCents: 300_000, balanceCents: 0 }),
    ])
    expect(plan.refusal).toBeNull()
    expect(plan.moneyApplied).toBe(true)
    expect(plan.totalCreditCents).toBe(600_000)
    expect(plan.totalAppliedCents).toBe(250_000)
    expect(plan.totalUnappliedCents).toBe(350_000)
  })

  it('refuses a void invoice', () => {
    const plan = planRepointCredit([
      invoice({ id: 'inv-void', status: 'VOID', totalCents: 250_000, balanceCents: 250_000 }),
    ])
    expect(plan.refusal).toBe('This shipment has a void invoice; it cannot be repointed')
    expect(plan.entries).toHaveLength(0)
  })

  it('refuses any invoice with a write-off', () => {
    const plan = planRepointCredit([
      invoice({ id: 'inv-ok', number: 'OK', status: 'ISSUED', totalCents: 100_000, balanceCents: 100_000 }),
      invoice({ id: 'inv-wo', number: 'WO', status: 'PARTIAL', totalCents: 200_000, paidCents: 100_000, writtenOffCents: 50_000, balanceCents: 50_000 }),
    ])
    expect(plan.refusal).toBe('This shipment has an invoice with a write-off; reverse the write-off before repointing')
  })

  it('refuses any factored invoice', () => {
    const plan = planRepointCredit([
      invoice({ id: 'inv-ok', number: 'OK', status: 'ISSUED', totalCents: 100_000, balanceCents: 100_000 }),
      invoice({ id: 'inv-fac', number: 'FAC', status: 'ISSUED', totalCents: 200_000, balanceCents: 200_000, factoringItemId: 'fi-1' }),
    ])
    expect(plan.refusal).toBe('This shipment has a factored invoice; remove it from the factoring batch before repointing')
  })

  it('ignores zero-total invoices', () => {
    const plan = planRepointCredit([
      invoice({ id: 'inv-zero', number: 'ZERO', status: 'ISSUED', totalCents: 0, balanceCents: 0 }),
      invoice({ id: 'inv-real', number: 'REAL', status: 'ISSUED', totalCents: 100_000, balanceCents: 100_000 }),
    ])
    expect(plan.refusal).toBeNull()
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0].invoiceId).toBe('inv-real')
    expect(plan.totalCreditCents).toBe(100_000)
  })

  it('never returns negative applied cents when balance is somehow negative', () => {
    const plan = planRepointCredit([
      invoice({ id: 'inv-over', number: 'OVER', status: 'PAID', totalCents: 200_000, paidCents: 250_000, balanceCents: -50_000 }),
    ])
    expect(plan.entries[0].appliedCents).toBe(0)
    expect(plan.entries[0].unappliedCents).toBe(200_000)
    expect(plan.moneyApplied).toBe(true)
  })

  it('surfaces money as soon as any invoice has an unapplied remainder', () => {
    const plan = planRepointCredit([
      invoice({ id: 'inv-1', status: 'ISSUED', totalCents: 100_000, balanceCents: 100_000 }),
      invoice({ id: 'inv-2', status: 'PARTIAL', totalCents: 200_000, paidCents: 50_000, balanceCents: 150_000 }),
    ])
    expect(plan.moneyApplied).toBe(true)
  })

  it('includes order ids on planned entries', () => {
    const plan = planRepointCredit([
      invoice({ id: 'inv-1', status: 'ISSUED', totalCents: 100_000, balanceCents: 100_000, orderId: 'ord-1' }),
    ])
    expect(plan.entries[0].orderId).toBe('ord-1')
  })
})
