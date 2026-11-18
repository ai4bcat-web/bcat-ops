import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent: { name: string; input: Record<string, unknown> }[] = []
const book = { bills: [] as Record<string, unknown>[], payments: [] as Record<string, unknown>[] }
const audits: unknown[] = []
let conflict = new Set<string>()

vi.mock('./store', () => ({
  AP_PAYMENT_TABLE_NAME: 'ApPaymentT',
  CARRIER_BILL_TABLE_NAME: 'CarrierBillT',
  nowIso: () => '2026-11-18T23:00:00.000Z',
  dynamo: {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const key = String(((command.input.Key as { id: { S: string } }) ?? { id: { S: '' } }).id.S)
      sent.push({ name: command.constructor.name, input: command.input })
      if (conflict.has(key)) throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' })
      return {}
    },
  },
  queryIndex: async (table: string, _index: string, _key: string, value: string) =>
    table === 'CarrierBillT' ? book.bills.filter((b) => b.billMonth === value) : book.payments.filter((p) => p.carrierId === value),
  writeAudit: async (...args: unknown[]) => { audits.push(args) },
}))

import { archiveApPaymentsThrough, unarchiveApPayments } from './archivePayments'

const caller = { email: 'claude.for.ryne@bcatcorp.com', sub: 's', groups: ['ADMIN'], isAdmin: true }

beforeEach(() => {
  sent.length = 0
  audits.length = 0
  conflict = new Set()
  book.bills = [
    { id: 'cb:1', carrierId: 'c1', billMonth: '2026-10', status: 'PAID', paidAt: '2026-10-05T12:00:00.000Z', billDate: '2026-10-01', shipmentNumber: '14001', loadCarrierId: 'lcr-1', updatedAt: 'u1', netCents: 10000 },
    { id: 'cb:2', carrierId: 'c1', billMonth: '2026-11', status: 'PAID', paidAt: '2026-11-18T12:00:00.000Z', billDate: '2026-11-02', shipmentNumber: '14525', loadCarrierId: 'lcr-2', updatedAt: 'u2', netCents: 95000 },
    { id: 'cb:3', carrierId: 'c1', billMonth: '2026-09', status: 'PAID', paidAt: '2026-09-05T12:00:00.000Z', billDate: '2026-09-01', shipmentNumber: '14400', loadCarrierId: 'lcr-3', updatedAt: 'u3', netCents: 5000 },
  ]
  book.payments = [
    { id: 'p1', carrierId: 'c1', kind: 'PAYMENT', paidAt: '2026-10-05T12:00:00.000Z', amountCents: 10000, unappliedCents: 0, applications: [{ billId: 'cb:1', amountCents: 10000 }], updatedAt: 'pu1' },
    { id: 'p2', carrierId: 'c1', kind: 'PAYMENT', paidAt: '2026-11-18T12:00:00.000Z', amountCents: 95000, unappliedCents: 0, applications: [{ billId: 'cb:2', amountCents: 95000 }], updatedAt: 'pu2' },
    { id: 'p3', carrierId: 'c1', kind: 'PAYMENT', paidAt: '2026-09-05T12:00:00.000Z', amountCents: 5000, unappliedCents: 0, applications: [{ billId: 'cb:3', amountCents: 5000 }], updatedAt: 'pu3' },
  ]
})

describe('archiveApPaymentsThrough', () => {
  it('is a dry run unless told otherwise: it reports the plan and writes nothing', async () => {
    const out = await archiveApPaymentsThrough({ cutoff: '2026-11-12' }, caller)
    expect(out).toMatchObject({ dryRun: true, paymentsToArchive: 1, billsToArchive: 1, written: 0, paymentDollars: 100 })
    expect(out.keptPaymentReasons).toEqual({ VERIFY_GROUP: 1 })
    expect(out.keptBills).toEqual([{ pro: '14400', why: 'VERIFY' }])
    expect(sent).toHaveLength(0)
  })

  it('archives the payment and the bill it settled, guarded by updatedAt, leaving the verify bill and the 11/18 payment', async () => {
    const out = await archiveApPaymentsThrough({ cutoff: '2026-11-12', dryRun: false }, caller)
    expect(out).toMatchObject({ written: 2, remaining: 0 })
    const tables = sent.map((s) => s.input.TableName)
    expect(tables.sort()).toEqual(['ApPaymentT', 'CarrierBillT'])
    for (const s of sent) {
      expect(s.input.ConditionExpression).toContain('attribute_not_exists(#a)')
      expect(s.input.ConditionExpression).toContain('updatedAt = :u')
      expect(String(s.input.UpdateExpression)).not.toContain('updatedAt')
    }
    expect(audits).toHaveLength(1)
  })

  it('skips a row somebody changed since it was read, and says how many are left', async () => {
    conflict = new Set(['p1'])
    const out = await archiveApPaymentsThrough({ cutoff: '2026-11-12', dryRun: false }, caller)
    expect(out).toMatchObject({ written: 1, skipped: 1, remaining: 0 })
  })

  it('caps the writes per call and reports what remains', async () => {
    const out = await archiveApPaymentsThrough({ cutoff: '2026-11-12', dryRun: false, limit: 1 }, caller)
    expect(out).toMatchObject({ written: 1, remaining: 1 })
  })

  it('refuses a cutoff that is not a day', async () => {
    await expect(archiveApPaymentsThrough({ cutoff: 'Nov 12' }, caller)).rejects.toThrow('cutoff must be a date')
  })
})

describe('unarchiveApPayments', () => {
  it('counts archived rows in a dry run and removes the fields when applied', async () => {
    book.payments[0].archivedAt = '2026-11-18T22:00:00.000Z'
    book.bills[0].archivedAt = '2026-11-18T22:00:00.000Z'
    const dry = await unarchiveApPayments({}, caller)
    expect(dry).toMatchObject({ dryRun: true, payments: 1, bills: 1, written: 0 })
    expect(sent).toHaveLength(0)
    const done = await unarchiveApPayments({ dryRun: false }, caller)
    expect(done).toMatchObject({ written: 2, remaining: 0 })
    expect(String(sent[0].input.UpdateExpression)).toContain('REMOVE')
  })
})
