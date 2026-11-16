import { describe, expect, it } from 'vitest'
import type { InvoiceRecord } from '@/types/tms'
import { FACTORED_GROUP, groupOutstanding, planReceive, recordPaymentInput, type ReceiveDraft } from './outstanding'

const inv = (id: string, p: Partial<InvoiceRecord>): InvoiceRecord => ({
  id, number: id, shipmentNumber: id, customerId: 'c1', customerName: 'ACME', status: 'ISSUED', invoiceDate: '2026-10-01', dueAt: '2026-10-31',
  totalCents: 10_000, paidCents: 0, balanceCents: 10_000, ...p,
} as InvoiceRecord)

const names: Record<string, string> = { c1: 'ACME', c2: 'BETA' }
const nameOf = (id: string, f: string) => names[id] ?? f

describe('groupOutstanding', () => {
  it('groups open invoices by customer A→Z, oldest first, factored ones in their own group last', () => {
    const groups = groupOutstanding([
      inv('2', { customerId: 'c2', invoiceDate: '2026-10-05' }),
      inv('1', { invoiceDate: '2026-10-09' }),
      inv('0', { invoiceDate: '2026-09-01' }),
      inv('F', { factored: true, customerId: 'c2' }),
      inv('P', { status: 'PAID', balanceCents: 0 }),
      inv('D', { status: 'DRAFT' as InvoiceRecord['status'] }),
    ], nameOf, '2026-11-16')
    expect(groups.map((g) => g.label)).toEqual(['ACME', 'BETA', 'Factored (OTR)'])
    expect(groups[0].rows.map((r) => r.invoiceId)).toEqual(['0', '1'])
    expect(groups[0].openCents).toBe(20_000)
    expect(groups[2]).toMatchObject({ key: FACTORED_GROUP, receivable: false })
    expect(groups[0].rows[0].daysOutstanding).toBe(76)
  })
})

describe('planReceive', () => {
  const [g] = groupOutstanding([inv('A', {}), inv('B', { balanceCents: 4_000, paidCents: 6_000 })], nameOf, '2026-11-16')
  const draft = (amounts: Record<string, string>, extra: Partial<ReceiveDraft> = {}): ReceiveDraft => ({
    customerId: 'c1', reference: '1042', receivedAt: '2026-11-16', method: 'CHECK',
    lines: g.rows.filter((r) => r.invoiceId in amounts).map((row) => ({ row, amount: amounts[row.invoiceId] })), ...extra,
  })

  it('builds one RECORD_PAYMENT whose applications are the ticked invoices', () => {
    const d = draft({ A: '100.00', B: '25' })
    const plan = planReceive(d)
    expect(plan.ok).toBe(true)
    expect(recordPaymentInput(d, plan, 'req-1')).toEqual({
      customerId: 'c1', receivedAt: '2026-11-16', method: 'CHECK', reference: '1042', amountCents: 12_500,
      applications: [{ invoiceId: 'A', amountCents: 10_000 }, { invoiceId: 'B', amountCents: 2_500 }],
      creditApplications: [], clientRequestId: 'req-1',
    })
  })

  it('refuses more than the balance, a blank amount, and a check with no number', () => {
    expect(planReceive(draft({ B: '41' })).errors[0]).toMatch(/more than the \$40\.00 balance/)
    expect(planReceive(draft({ A: '' })).ok).toBe(false)
    expect(planReceive(draft({ A: '10' }, { reference: ' ' })).errors).toContain('Enter the check number.')
    expect(planReceive(draft({ A: '10' }, { reference: '', method: 'ACH' })).ok).toBe(true)
  })

  it('never receives a factored invoice', () => {
    const [, otr] = groupOutstanding([inv('A', {}), inv('F', { factoringItemId: 'F' })], nameOf, '2026-11-16')
    const plan = planReceive({ customerId: 'c1', reference: '1', receivedAt: '2026-11-16', method: 'CHECK', lines: [{ row: otr.rows[0], amount: '100' }] })
    expect(plan.ok).toBe(false)
  })
})
