import { describe, expect, it } from 'vitest'
import type { InvoiceRecord } from '@/types/tms'
import { factorFeeCents, factorFeeReason, groupOutstanding, planReceive, prefillCents, recordPaymentInput, type ReceiveDraft } from './outstanding'

const inv = (id: string, p: Partial<InvoiceRecord>): InvoiceRecord => ({
  id, number: id, shipmentNumber: id, customerId: 'c1', customerName: 'ACME', status: 'ISSUED', invoiceDate: '2026-10-01', dueAt: '2026-10-31',
  totalCents: 10_000, paidCents: 0, balanceCents: 10_000, ...p,
} as InvoiceRecord)

const names: Record<string, string> = { c1: 'ACME', c2: 'BETA' }
const nameOf = (id: string, f: string) => names[id] ?? f

describe('groupOutstanding', () => {
  it('splits Manually invoiced and Factored (OTR), each grouped by customer A→Z, oldest first', () => {
    const sections = groupOutstanding([
      inv('2', { customerId: 'c2', invoiceDate: '2026-10-05' }),
      inv('1', { invoiceDate: '2026-10-09' }),
      inv('0', { invoiceDate: '2026-09-01' }),
      inv('F', { factored: true, customerId: 'c2' }),
      inv('G', { factoringItemId: 'G' }),
      inv('P', { status: 'PAID', balanceCents: 0 }),
    ], nameOf, '2026-11-16')
    expect(sections.map((s) => s.label)).toEqual(['Manually invoiced', 'Factored (OTR)'])
    expect(sections[0].groups.map((g) => g.label)).toEqual(['ACME', 'BETA'])
    expect(sections[0].groups[0].rows.map((r) => r.invoiceId)).toEqual(['0', '1'])
    expect(sections[0]).toMatchObject({ count: 3, openCents: 30_000 })
    expect(sections[1].groups.map((g) => g.label)).toEqual(['ACME', 'BETA'])
    expect(sections[1]).toMatchObject({ count: 2, openCents: 20_000 })
    expect(sections[0].groups[0].rows[0].daysOutstanding).toBe(76)
  })
})

describe('factoring fee', () => {
  it('pre-fills a factored invoice at the balance less 2%, a manual one at the balance', () => {
    const [manual, factored] = groupOutstanding([inv('M', {}), inv('F', { factored: true, balanceCents: 123_45 })], nameOf, '2026-11-16')
    expect(prefillCents(manual.groups[0].rows[0], 200)).toBe(10_000)
    expect(factorFeeCents(123_45, 200)).toBe(247)
    expect(prefillCents(factored.groups[0].rows[0], 200)).toBe(120_98)
    expect(factorFeeReason(200)).toBe('Factoring fee (OTR 2%)')
  })
})

describe('planReceive', () => {
  const [manual, factored] = groupOutstanding([
    inv('A', {}),
    inv('B', { balanceCents: 4_000, paidCents: 6_000 }),
    inv('F1', { factored: true, balanceCents: 50_000 }),
    inv('F2', { factored: true, customerId: 'c2', balanceCents: 100_000 }),
  ], nameOf, '2026-11-16')
  const rows = [...manual.groups.flatMap((g) => g.rows), ...factored.groups.flatMap((g) => g.rows)]
  const draft = (amounts: Record<string, string>, extra: Partial<ReceiveDraft> = {}): ReceiveDraft => ({
    reference: '1042', receivedAt: '2026-11-16', method: 'CHECK', feeBps: 200,
    lines: rows.filter((r) => r.invoiceId in amounts).map((row) => ({ row, amount: amounts[row.invoiceId] })), ...extra,
  })

  it('builds one RECORD_PAYMENT for a customer whose applications are the ticked invoices', () => {
    const d = draft({ A: '100.00', B: '25' })
    const plan = planReceive(d)
    expect(plan.ok).toBe(true)
    expect(plan.feeCents).toBe(0)
    expect(plan.payments).toHaveLength(1)
    expect(recordPaymentInput(d, plan.payments[0], 'req-1')).toEqual({
      customerId: 'c1', receivedAt: '2026-11-16', method: 'CHECK', reference: '1042', amountCents: 12_500,
      applications: [{ invoiceId: 'A', amountCents: 10_000 }, { invoiceId: 'B', amountCents: 2_500 }],
      creditApplications: [], clientRequestId: 'req-1',
    })
  })

  it('receives an OTR remittance at 98%: one payment per customer, and the 2% closes each invoice', () => {
    const plan = planReceive(draft({ F1: '490.00', F2: '980.00' }, { method: 'FACTOR', reference: 'OTR-77' }))
    expect(plan.ok).toBe(true)
    expect(plan.payments.map((p) => [p.customerId, p.amountCents])).toEqual([['c1', 49_000], ['c2', 98_000]])
    expect(plan.lines.map((l) => [l.invoiceId, l.paidCents, l.feeCents, l.leftCents])).toEqual([['F1', 49_000, 1_000, 0], ['F2', 98_000, 2_000, 0]])
    expect([plan.receivedCents, plan.feeCents, plan.invoiceCents]).toEqual([147_000, 3_000, 150_000])
  })

  it('a short pay closes only the 2%; the rest stays open', () => {
    const plan = planReceive(draft({ F1: '400.00' }, { method: 'FACTOR', reference: 'OTR-78' }))
    expect(plan.lines[0]).toMatchObject({ paidCents: 40_000, feeCents: 1_000, leftCents: 9_000 })
  })

  it('paying more than 98% only closes what is left', () => {
    const plan = planReceive(draft({ F1: '495.00' }, { method: 'FACTOR', reference: 'x' }))
    expect(plan.lines[0]).toMatchObject({ paidCents: 49_500, feeCents: 500, leftCents: 0 })
  })

  it('refuses more than the balance, a blank amount, and a check with no number', () => {
    expect(planReceive(draft({ B: '41' })).errors[0]).toMatch(/more than the \$40\.00 balance/)
    expect(planReceive(draft({ A: '' })).ok).toBe(false)
    expect(planReceive(draft({ A: '10' }, { reference: ' ' })).errors).toContain('Enter the check number.')
    expect(planReceive(draft({ A: '10' }, { reference: '', method: 'ACH' })).ok).toBe(true)
  })
})
