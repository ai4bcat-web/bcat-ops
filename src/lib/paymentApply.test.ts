import { describe, expect, it } from 'vitest'
import {
  invoiceStatusAfter,
  planPayment,
  reversalPlan,
  suggestAllocation,
  writeOffPlan,
  type PlanCredit,
  type PlanInvoice,
} from './paymentApply'

function invoice(over: Partial<PlanInvoice> = {}): PlanInvoice {
  const totalCents = over.totalCents ?? 100_000
  const paidCents = over.paidCents ?? 0
  const writtenOffCents = over.writtenOffCents ?? 0
  return {
    id: 'INV-000001',
    customerId: 'cus-1',
    status: 'ISSUED',
    totalCents,
    paidCents,
    writtenOffCents,
    balanceCents: totalCents - paidCents - writtenOffCents,
    number: 'INV-000001',
    ...over,
  }
}

function credit(over: Partial<PlanCredit> = {}): PlanCredit {
  return {
    id: 'cm-1',
    customerId: 'cus-1',
    kind: 'CREDIT_MEMO',
    unappliedCents: 25_000,
    ...over,
  }
}

describe('invoiceStatusAfter', () => {
  it('is ISSUED untouched, PARTIAL part-paid and PAID at zero balance', () => {
    expect(invoiceStatusAfter(100_000, 0, 0)).toBe('ISSUED')
    expect(invoiceStatusAfter(100_000, 40_000, 0)).toBe('PARTIAL')
    expect(invoiceStatusAfter(100_000, 100_000, 0)).toBe('PAID')
  })

  it('settles an invoice written off as readily as one paid', () => {
    expect(invoiceStatusAfter(100_000, 90_000, 10_000)).toBe('PAID')
    expect(invoiceStatusAfter(100_000, 0, 10_000)).toBe('PARTIAL')
  })
})

describe('planPayment', () => {
  it('applies a payment in full and flips the invoice to PAID', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 100_000,
      applications: [{ invoiceId: 'INV-000001', amountCents: 100_000 }],
      creditApplications: [],
      invoices: [invoice()],
      credits: [],
    })
    expect(plan.ok).toBe(true)
    expect(plan.appliedCents).toBe(100_000)
    expect(plan.unappliedCents).toBe(0)
    expect(plan.invoices[0]).toMatchObject({ balanceCents: 0, status: 'PAID', becamePaid: true })
  })

  it('refuses more than the invoice still owes, naming both figures', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 150_000,
      applications: [{ invoiceId: 'INV-000001', amountCents: 150_000 }],
      creditApplications: [],
      invoices: [invoice()],
      credits: [],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/\$1,000\.00 outstanding; \$1,500\.00 was applied/)
  })

  it('keeps an overpayment on the row as customer credit', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 120_000,
      applications: [{ invoiceId: 'INV-000001', amountCents: 100_000 }],
      creditApplications: [],
      invoices: [invoice()],
      credits: [],
    })
    expect(plan.ok).toBe(true)
    expect(plan.unappliedCents).toBe(20_000)
  })

  it('refuses to spend more of a credit than is left on it', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 0,
      applications: [{ invoiceId: 'INV-000001', amountCents: 40_000 }],
      creditApplications: [{ paymentId: 'cm-1', amountCents: 40_000 }],
      invoices: [invoice()],
      credits: [credit({ unappliedCents: 25_000 })],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/has \$250\.00 left; \$400\.00 was asked for/)
  })

  it('refuses another customer\u2019s credit and another customer\u2019s invoice', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 0,
      applications: [{ invoiceId: 'INV-000001', amountCents: 10_000 }],
      creditApplications: [{ paymentId: 'cm-1', amountCents: 10_000 }],
      invoices: [invoice({ customerId: 'cus-2' })],
      credits: [credit({ customerId: 'cus-2' })],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.filter((e) => /belongs to another customer/.test(e))).toHaveLength(2)
  })

  it('refuses a void invoice and a settled one', () => {
    const voided = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 10_000,
      applications: [{ invoiceId: 'INV-000001', amountCents: 10_000 }],
      creditApplications: [],
      invoices: [invoice({ status: 'VOID' })],
      credits: [],
    })
    expect(voided.errors.join(' ')).toMatch(/void and takes no payment/)

    const settled = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 10_000,
      applications: [{ invoiceId: 'INV-000001', amountCents: 10_000 }],
      creditApplications: [],
      invoices: [invoice({ status: 'PAID', paidCents: 100_000 })],
      credits: [],
    })
    expect(settled.errors.join(' ')).toMatch(/already settled/)
  })

  it('posts a zero-cash payment that spends a credit', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 0,
      applications: [{ invoiceId: 'INV-000001', amountCents: 25_000 }],
      creditApplications: [{ paymentId: 'cm-1', amountCents: 25_000 }],
      invoices: [invoice()],
      credits: [credit()],
    })
    expect(plan.ok).toBe(true)
    expect(plan.fromCreditsCents).toBe(25_000)
    expect(plan.unappliedCents).toBe(0)
    expect(plan.credits[0].unappliedAfterCents).toBe(0)
    expect(plan.invoices[0]).toMatchObject({ balanceCents: 75_000, status: 'PARTIAL' })
  })

  it('never turns a credit back into a fresh credit', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 0,
      applications: [{ invoiceId: 'INV-000001', amountCents: 10_000 }],
      creditApplications: [{ paymentId: 'cm-1', amountCents: 25_000 }],
      invoices: [invoice()],
      credits: [credit()],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/only be spent on an invoice/)
  })

  it('refuses the same invoice or the same credit listed twice', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 60_000,
      applications: [
        { invoiceId: 'INV-000001', amountCents: 30_000 },
        { invoiceId: 'INV-000001', amountCents: 30_000 },
      ],
      creditApplications: [],
      invoices: [invoice()],
      credits: [],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/listed twice/)
  })

  it('refuses fractional cents', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      customerId: 'cus-1',
      amountCents: 10_000.5,
      applications: [],
      creditApplications: [],
      invoices: [],
      credits: [],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/whole number of cents/)
  })

  it('issues a credit memo unapplied and refuses one that tries to apply itself', () => {
    const clean = planPayment({
      kind: 'CREDIT_MEMO',
      customerId: 'cus-1',
      amountCents: 25_000,
      applications: [],
      creditApplications: [],
      invoices: [],
      credits: [],
    })
    expect(clean.ok).toBe(true)
    expect(clean.unappliedCents).toBe(25_000)

    const applied = planPayment({
      kind: 'CREDIT_MEMO',
      customerId: 'cus-1',
      amountCents: 25_000,
      applications: [{ invoiceId: 'INV-000001', amountCents: 25_000 }],
      creditApplications: [],
      invoices: [invoice()],
      credits: [],
    })
    expect(applied.ok).toBe(false)
    expect(applied.errors.join(' ')).toMatch(/issued unapplied/)
  })
})

describe('writeOffPlan', () => {
  it('settles the rest of an invoice without touching paidCents', () => {
    const plan = writeOffPlan(invoice({ paidCents: 95_000 }), 5_000)
    expect(plan.ok).toBe(true)
    expect(plan.invoices[0]).toMatchObject({
      paidCents: 95_000,
      writtenOffCents: 5_000,
      balanceCents: 0,
      status: 'PAID',
      becamePaid: true,
    })
  })

  it('refuses a write-off larger than the balance', () => {
    const plan = writeOffPlan(invoice({ paidCents: 95_000 }), 6_000)
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/\$50\.00 outstanding/)
  })
})

describe('reversalPlan', () => {
  const posted = {
    id: 'pay-1',
    customerId: 'cus-1',
    kind: 'PAYMENT' as const,
    amountCents: 100_000,
    appliedCents: 100_000,
    unappliedCents: 0,
    applications: [{ invoiceId: 'INV-000001', amountCents: 100_000 }],
    creditApplications: [],
    reversedByPaymentId: null,
  }

  it('restores the balance and takes the invoice back off PAID', () => {
    const plan = reversalPlan(posted, [invoice({ status: 'PAID', paidCents: 100_000 })], [])
    expect(plan.ok).toBe(true)
    expect(plan.invoices[0]).toMatchObject({ paidCents: 0, balanceCents: 100_000, status: 'ISSUED' })
  })

  it('gives a spent credit back to the row it came from', () => {
    const plan = reversalPlan(
      { ...posted, amountCents: 75_000, creditApplications: [{ paymentId: 'cm-1', amountCents: 25_000 }] },
      [invoice({ status: 'PAID', paidCents: 100_000 })],
      [credit({ unappliedCents: 0 })],
    )
    expect(plan.ok).toBe(true)
    expect(plan.credits[0].unappliedAfterCents).toBe(25_000)
  })

  it('refuses once the unapplied remainder has been spent elsewhere', () => {
    const plan = reversalPlan(
      { ...posted, amountCents: 120_000, appliedCents: 100_000, unappliedCents: 5_000 },
      [invoice({ status: 'PAID', paidCents: 100_000 })],
      [],
    )
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/\$150\.00 of this row has since been applied/)
  })

  it('refuses a second reversal and a reversal of a reversal', () => {
    expect(reversalPlan({ ...posted, reversedByPaymentId: 'rev-1' }, [invoice()], []).errors.join(' '))
      .toMatch(/already been reversed/)
    expect(reversalPlan({ ...posted, kind: 'REVERSAL' }, [invoice()], []).errors.join(' '))
      .toMatch(/cannot itself be reversed/)
  })

  it('refuses when the invoice no longer carries what this row put on it', () => {
    const plan = reversalPlan(posted, [invoice({ paidCents: 40_000 })], [])
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/no longer carries/)
  })
})

describe('suggestAllocation', () => {
  const a = invoice({ id: 'INV-1', number: 'INV-1', totalCents: 50_000 })
  const b = invoice({ id: 'INV-2', number: 'INV-2', totalCents: 30_000 })
  const due = { 'INV-1': '2026-03-01', 'INV-2': '2026-01-15' }

  it('takes an exact balance match ahead of the oldest invoice', () => {
    expect(suggestAllocation(50_000, [a, b], due)).toEqual([{ invoiceId: 'INV-1', amountCents: 50_000 }])
  })

  it('otherwise fills oldest-due first and stops when the money runs out', () => {
    expect(suggestAllocation(40_000, [a, b], due)).toEqual([
      { invoiceId: 'INV-2', amountCents: 30_000 },
      { invoiceId: 'INV-1', amountCents: 10_000 },
    ])
  })

  it('suggests nothing for nothing', () => {
    expect(suggestAllocation(0, [a, b], due)).toEqual([])
  })
})
