import { describe, expect, it } from 'vitest'
import type { InvoiceRecord } from '@/types/tms'
import {
  allocateOldestFirst, daysLate, factorFeeCents, factorFeeReason, filterOutstanding, filterTableRows, groupOutstanding, lateBucket, planReceive, prefillCents,
  recordPaymentInput, tableRows, type ReceiveDraft,
} from './outstanding'

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

describe('tableRows (Outstanding as one table)', () => {
  it('is one flat list: customer A→Z, then due date, each row says Manual or Factored and how late it is', () => {
    const rows = tableRows([
      inv('2', { customerId: 'c2', dueAt: '2026-11-20' }),
      inv('1', { dueAt: '2026-11-10', termsText: 'Net 30', divisionKey: 'BCAT_LOGISTICS', sentAt: '2026-10-02T15:00:00.000Z' }),
      inv('0', { dueAt: '2026-10-31', termsDays: 45 }),
      inv('F', { factored: true, customerId: 'c2', dueAt: '2026-11-01' }),
      inv('P', { status: 'PAID', balanceCents: 0 }),
    ], nameOf, '2026-11-16')
    expect(rows.map((r) => r.invoiceId)).toEqual(['0', '1', 'F', '2'])
    expect(rows.map((r) => r.type)).toEqual(['manual', 'manual', 'factored', 'manual'])
    expect(rows[0]).toMatchObject({ customerName: 'ACME', termsText: 'Net 45', daysLate: 16 })
    expect(rows[1]).toMatchObject({ termsText: 'Net 30', divisionKey: 'BCAT_LOGISTICS', sentOn: '2026-10-02', daysLate: 6 })
    expect(rows[3].daysLate).toBe(0)
  })

  it('narrows to one customer, a type chip and a typed search', () => {
    const rows = tableRows([
      inv('A1', { po: undefined, references: [{ type: 'PO', value: 'PO-9' }] as never }),
      inv('B1', { customerId: 'c2' }),
      inv('B2', { customerId: 'c2', factored: true }),
    ], nameOf, '2026-11-16')
    expect(filterTableRows(rows, { customerId: 'c2' }).map((r) => r.invoiceId)).toEqual(['B1', 'B2'])
    expect(filterTableRows(rows, { customerId: 'c2', type: 'factored' }).map((r) => r.invoiceId)).toEqual(['B2'])
    expect(filterTableRows(rows, { query: 'b1' }).map((r) => r.invoiceId)).toEqual(['B1'])
    expect(filterTableRows(rows, {}).length).toBe(3)
  })

  it('buckets how late an invoice is', () => {
    expect(daysLate('2026-11-20', '2026-11-16')).toBe(0)
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(lateBucket)).toEqual([
      'Current', '1–30 days late', '1–30 days late', '31–60 days late', '31–60 days late', '61–90 days late', '61–90 days late', '90+ days late',
    ])
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


describe('filterOutstanding (work on one customer)', () => {
  const sections = () => groupOutstanding([
    inv('1', { invoiceDate: '2026-10-09', references: [{ code: 'PO', value: 'PO-777', visibility: 'CUSTOMER' }] as never }),
    inv('2', { customerId: 'c2', invoiceDate: '2026-10-05' }),
    inv('F', { factored: true, customerId: 'c2' }),
    inv('G', { factored: true }),
  ], nameOf, '2026-11-16')

  it('shows only that customer, in both sections, with totals recomputed', () => {
    const only = filterOutstanding(sections(), { customerId: 'c2' })
    expect(only.map((s) => s.key)).toEqual(['manual', 'factored'])
    expect(only[0].groups.map((g) => g.customerId)).toEqual(['c2'])
    expect(only[0]).toMatchObject({ count: 1, openCents: 10_000 })
    expect(only[1].groups.map((g) => g.rows.map((r) => r.invoiceId))).toEqual([['F']])
  })

  it('drops a section that has nothing left', () => {
    const only = filterOutstanding(sections(), { customerId: 'c1' })
    expect(only.map((s) => `${s.key}:${s.count}`)).toEqual(['manual:1', 'factored:1'])
    expect(filterOutstanding(sections(), { customerId: 'nobody' })).toEqual([])
  })

  it('searches invoice #, PRO and PO, ignoring case', () => {
    expect(filterOutstanding(sections(), { query: 'po-777' }).flatMap((s) => s.groups.flatMap((g) => g.rows.map((r) => r.invoiceId)))).toEqual(['1'])
    expect(filterOutstanding(sections(), { query: 'f' }).flatMap((s) => s.groups.flatMap((g) => g.rows.map((r) => r.invoiceId)))).toEqual(['F'])
    expect(filterOutstanding(sections(), { customerId: 'c1', query: 'zzz' })).toEqual([])
  })

  it('returns everything when nothing is asked', () => {
    expect(filterOutstanding(sections(), {})).toHaveLength(2)
    expect(filterOutstanding(sections(), { customerId: null, query: '  ' })).toHaveLength(2)
  })
})

describe('allocateOldestFirst (a check spent on the oldest invoices first)', () => {
  const rows = () => groupOutstanding([
    inv('A', { invoiceDate: '2026-09-01', balanceCents: 30_000, totalCents: 30_000 }),
    inv('B', { invoiceDate: '2026-10-01', balanceCents: 20_000, totalCents: 20_000 }),
    inv('C', { invoiceDate: '2026-08-01', balanceCents: 10_000, totalCents: 10_000 }),
  ], nameOf, '2026-11-16')[0].groups[0].rows

  it('fills the oldest in full and gives the last one what is left', () => {
    const a = allocateOldestFirst(rows(), 25_000, 200)
    expect([...a]).toEqual([['C', 10_000], ['A', 15_000]])
  })

  it('pays everything when the check covers it, and stops there', () => {
    expect([...allocateOldestFirst(rows(), 999_999, 200)].map(([id]) => id)).toEqual(['C', 'A', 'B'])
    expect(allocateOldestFirst(rows(), 0, 200).size).toBe(0)
  })

  it('spends a factored invoice at its balance less the OTR fee', () => {
    const f = groupOutstanding([inv('F', { factored: true, balanceCents: 100_00, totalCents: 100_00 })], nameOf, '2026-11-16')[0].groups[0].rows
    expect([...allocateOldestFirst(f, 98_00, 200)]).toEqual([['F', 98_00]])
    expect([...allocateOldestFirst(f, 50_00, 200)]).toEqual([['F', 50_00]])
  })
})
