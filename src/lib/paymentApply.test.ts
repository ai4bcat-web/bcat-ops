import { describe, expect, it } from 'vitest'
import {
  invoiceStatusAfter,
  planPayment,
  reversalPlan,
  suggestAllocation,
  writeOffPlan,
  type PlanCredit,
  type PlanDocument,
} from './paymentApply'

function invoice(over: Partial<PlanDocument> = {}): PlanDocument {
  const totalCents = over.totalCents ?? 100_000
  const paidCents = over.paidCents ?? 0
  const offsetCents = over.offsetCents ?? 0
  return {
    id: 'INV-000001',
    partyId: 'cus-1',
    totalCents,
    paidCents,
    offsetCents,
    balanceCents: totalCents - paidCents - offsetCents,
    number: 'INV-000001',
    ...over,
  }
}

function credit(over: Partial<PlanCredit> = {}): PlanCredit {
  return {
    id: 'cm-1',
    partyId: 'cus-1',
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
      partyId: 'cus-1',
      amountCents: 100_000,
      applications: [{ documentId: 'INV-000001', amountCents: 100_000 }],
      creditApplications: [],
      documents: [invoice()],
      credits: [],
    })
    expect(plan.ok).toBe(true)
    expect(plan.appliedCents).toBe(100_000)
    expect(plan.unappliedCents).toBe(0)
    expect(plan.documents[0]).toMatchObject({ balanceCents: 0, settled: true, becamePaid: true })
  })

  it('refuses more than the invoice still owes, naming both figures', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 150_000,
      applications: [{ documentId: 'INV-000001', amountCents: 150_000 }],
      creditApplications: [],
      documents: [invoice()],
      credits: [],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/\$1,000\.00 outstanding; \$1,500\.00 was applied/)
  })

  it('keeps an overpayment on the row as customer credit', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 120_000,
      applications: [{ documentId: 'INV-000001', amountCents: 100_000 }],
      creditApplications: [],
      documents: [invoice()],
      credits: [],
    })
    expect(plan.ok).toBe(true)
    expect(plan.unappliedCents).toBe(20_000)
  })

  it('refuses to spend more of a credit than is left on it', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 0,
      applications: [{ documentId: 'INV-000001', amountCents: 40_000 }],
      creditApplications: [{ paymentId: 'cm-1', amountCents: 40_000 }],
      documents: [invoice()],
      credits: [credit({ unappliedCents: 25_000 })],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/has \$250\.00 left; \$400\.00 was asked for/)
  })

  it('refuses another customer\u2019s credit and another customer\u2019s invoice', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 0,
      applications: [{ documentId: 'INV-000001', amountCents: 10_000 }],
      creditApplications: [{ paymentId: 'cm-1', amountCents: 10_000 }],
      documents: [invoice({ partyId: 'cus-2' })],
      credits: [credit({ partyId: 'cus-2' })],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.filter((e) => /belongs to another customer/.test(e))).toHaveLength(2)
  })

  it('refuses a void invoice and a settled one', () => {
    const voided = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 10_000,
      applications: [{ documentId: 'INV-000001', amountCents: 10_000 }],
      creditApplications: [],
      documents: [invoice({ voided: true })],
      credits: [],
    })
    expect(voided.errors.join(' ')).toMatch(/void and takes no payment/)

    const settled = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 10_000,
      applications: [{ documentId: 'INV-000001', amountCents: 10_000 }],
      creditApplications: [],
      documents: [invoice({ paidCents: 100_000 })],
      credits: [],
    })
    expect(settled.errors.join(' ')).toMatch(/already settled/)
  })

  it('posts a zero-cash payment that spends a credit', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 0,
      applications: [{ documentId: 'INV-000001', amountCents: 25_000 }],
      creditApplications: [{ paymentId: 'cm-1', amountCents: 25_000 }],
      documents: [invoice()],
      credits: [credit()],
    })
    expect(plan.ok).toBe(true)
    expect(plan.fromCreditsCents).toBe(25_000)
    expect(plan.unappliedCents).toBe(0)
    expect(plan.credits[0].unappliedAfterCents).toBe(0)
    expect(plan.documents[0]).toMatchObject({ balanceCents: 75_000, settled: false })
  })

  it('never turns a credit back into a fresh credit', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 0,
      applications: [{ documentId: 'INV-000001', amountCents: 10_000 }],
      creditApplications: [{ paymentId: 'cm-1', amountCents: 25_000 }],
      documents: [invoice()],
      credits: [credit()],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/only be spent on an invoice/)
  })

  it('refuses the same invoice or the same credit listed twice', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 60_000,
      applications: [
        { documentId: 'INV-000001', amountCents: 30_000 },
        { documentId: 'INV-000001', amountCents: 30_000 },
      ],
      creditApplications: [],
      documents: [invoice()],
      credits: [],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/listed twice/)
  })

  it('refuses fractional cents', () => {
    const plan = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 10_000.5,
      applications: [],
      creditApplications: [],
      documents: [],
      credits: [],
    })
    expect(plan.ok).toBe(false)
    expect(plan.errors.join(' ')).toMatch(/whole number of cents/)
  })

  it('issues a credit memo unapplied and refuses one that tries to apply itself', () => {
    const clean = planPayment({
      kind: 'CREDIT_MEMO',
      partyId: 'cus-1',
      amountCents: 25_000,
      applications: [],
      creditApplications: [],
      documents: [],
      credits: [],
    })
    expect(clean.ok).toBe(true)
    expect(clean.unappliedCents).toBe(25_000)

    const applied = planPayment({
      kind: 'CREDIT_MEMO',
      partyId: 'cus-1',
      amountCents: 25_000,
      applications: [{ documentId: 'INV-000001', amountCents: 25_000 }],
      creditApplications: [],
      documents: [invoice()],
      credits: [],
    })
    expect(applied.ok).toBe(false)
    expect(applied.errors.join(' ')).toMatch(/issued unapplied/)
  })

  it('refuses in the carrier vocabulary when AP plans a bill', () => {
    const ap = planPayment({
      kind: 'PAYMENT',
      partyId: 'car-1',
      amountCents: 10_000,
      applications: [{ documentId: 'cb:x:1', amountCents: 10_000 }],
      creditApplications: [{ paymentId: 'apcm-1', amountCents: 10_000 }],
      documents: [invoice({ id: 'cb:x:1', number: null, partyId: 'car-1', paidCents: 100_000 })],
      credits: [credit({ id: 'apcm-1', partyId: 'car-2' })],
      vocabulary: { party: 'carrier', document: 'bill' },
    })
    expect(ap.errors).toContain('Bill cb:x:1 is already settled')
    expect(ap.errors).toContain('Credit apcm-1 belongs to another carrier')

    const ar = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 10_000,
      applications: [{ documentId: 'INV-000001', amountCents: 10_000 }],
      creditApplications: [{ paymentId: 'cm-1', amountCents: 10_000 }],
      documents: [invoice({ paidCents: 100_000 })],
      credits: [credit({ partyId: 'cus-2' })],
    })
    expect(ar.errors).toContain('Invoice INV-000001 is already settled')
    expect(ar.errors).toContain('Credit cm-1 belongs to another customer')
  })

  it('calls an invoice newly paid only where the balance reached zero here', () => {
    const partial = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 40_000,
      applications: [{ documentId: 'INV-000001', amountCents: 40_000 }],
      creditApplications: [],
      documents: [invoice()],
      credits: [],
    })
    expect(partial.documents[0]).toMatchObject({ settled: false, becamePaid: false })

    // Settled before this row arrived: refused rather than planned, so the order is
    // never moved to PAID a second time by a payment that put nothing on it.
    const already = planPayment({
      kind: 'PAYMENT',
      partyId: 'cus-1',
      amountCents: 10_000,
      applications: [{ documentId: 'INV-000001', amountCents: 10_000 }],
      creditApplications: [],
      documents: [invoice({ paidCents: 100_000 })],
      credits: [],
    })
    expect(already.ok).toBe(false)
    expect(already.documents).toEqual([])
  })
})

describe('writeOffPlan', () => {
  it('settles the rest of an invoice without touching paidCents', () => {
    const plan = writeOffPlan(invoice({ paidCents: 95_000 }), 5_000)
    expect(plan.ok).toBe(true)
    expect(plan.documents[0]).toMatchObject({
      paidCents: 95_000,
      offsetCents: 5_000,
      balanceCents: 0,
      settled: true,
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
    partyId: 'cus-1',
    kind: 'PAYMENT' as const,
    amountCents: 100_000,
    appliedCents: 100_000,
    unappliedCents: 0,
    applications: [{ documentId: 'INV-000001', amountCents: 100_000 }],
    creditApplications: [] as { paymentId: string; amountCents: number }[],
    reversedByPaymentId: null,
  }

  it('restores the balance and takes the invoice back off PAID', () => {
    const plan = reversalPlan(posted, [invoice({ paidCents: 100_000 })], [])
    expect(plan.ok).toBe(true)
    expect(plan.documents[0]).toMatchObject({ paidCents: 0, balanceCents: 100_000, settled: false })
  })

  it('gives a spent credit back to the row it came from', () => {
    const plan = reversalPlan(
      { ...posted, amountCents: 75_000, creditApplications: [{ paymentId: 'cm-1', amountCents: 25_000 }] },
      [invoice({ paidCents: 100_000 })],
      [credit({ unappliedCents: 0 })],
    )
    expect(plan.ok).toBe(true)
    expect(plan.credits[0].unappliedAfterCents).toBe(25_000)
  })

  it('refuses once the unapplied remainder has been spent elsewhere', () => {
    const plan = reversalPlan(
      { ...posted, amountCents: 120_000, appliedCents: 100_000, unappliedCents: 5_000 },
      [invoice({ paidCents: 100_000 })],
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
    expect(suggestAllocation(50_000, [a, b], due)).toEqual([{ documentId: 'INV-1', amountCents: 50_000 }])
  })

  it('otherwise fills oldest-due first and stops when the money runs out', () => {
    expect(suggestAllocation(40_000, [a, b], due)).toEqual([
      { documentId: 'INV-2', amountCents: 30_000 },
      { documentId: 'INV-1', amountCents: 10_000 },
    ])
  })

  it('suggests nothing for nothing', () => {
    expect(suggestAllocation(0, [a, b], due)).toEqual([])
  })
})
