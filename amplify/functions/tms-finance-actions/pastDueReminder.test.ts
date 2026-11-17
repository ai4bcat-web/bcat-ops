/**
 * PAST_DUE_REMINDER: preview writes nothing; send stamps each invoice and audits it; refusals hold.
 * The sender is a mock (deliverNotice), so nothing is e-mailed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>

const mocks = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  deliverNotice: vi.fn(),
  transact: vi.fn(),
  writeAudit: vi.fn(),
}))

vi.mock('./store', () => ({
  CUSTOMER_TABLE_NAME: 'Customer', FROM_ADDRESS: 'noreply@bcatcorp.com', INVOICE_TABLE_NAME: 'Invoice',
  SHIPMENT_NOTICE_TABLE_NAME: 'Notice', SHIPMENT_TABLE_NAME: 'Shipment',
  dynamo: {}, ses: {},
  getById: async (table: string, id: string) => mocks.rows.get(`${table}:${id}`) ?? null,
  nowIso: () => '2026-11-17T15:00:00.000Z',
  transact: mocks.transact,
  updateTx: (table: string, id: string, patch: Row) => ({ table, id, patch }),
  writeAudit: mocks.writeAudit,
}))
vi.mock('../_shared/shipmentNotices', () => ({ deliverNotice: mocks.deliverNotice }))

import { pastDueReminder } from './pastDueReminder'

const caller = { email: 'ryne@bcatcorp.com', sub: 's', groups: [], isAdmin: true }

function seed(invoice: Row = {}) {
  mocks.rows.clear()
  mocks.rows.set('Customer:c1', { id: 'c1', name: 'ROHLIG LOGISTICS', apEmail: 'ap@rohlig.com', invoiceCopyEmails: ['copy@rohlig.com'] })
  mocks.rows.set('Shipment:s1', { id: 's1', revDivision: 'BCAT Logistics' })
  mocks.rows.set('Invoice:i1', {
    id: 'i1', number: '14051', shipmentId: 's1', shipmentNumber: '14051', customerId: 'c1', status: 'ISSUED',
    invoiceDate: '2026-08-05', dueAt: '2020-01-01', totalCents: 22995, paidCents: 0, writtenOffCents: 0, balanceCents: 22995, factored: false, ...invoice,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.deliverNotice.mockResolvedValue({ status: 'SENT', error: null })
  seed()
})

describe('PAST_DUE_REMINDER', () => {
  it('previews recipients and the table without sending or writing', async () => {
    const res = await pastDueReminder({ invoiceIds: ['i1'] }, caller)
    expect(res.preview).toBe(true)
    expect(res.to).toEqual(['ap@rohlig.com'])
    expect(res.cc).toEqual(['billing@bcatcorp.com', 'copy@rohlig.com'])
    expect((res.body as string)).toContain('past due. Can you please advise when payment will be made?')
    expect(mocks.deliverNotice).not.toHaveBeenCalled()
    expect(mocks.transact).not.toHaveBeenCalled()
    expect(mocks.writeAudit).not.toHaveBeenCalled()
  })

  it('sends once through the notice path, stamps the invoice and audits it', async () => {
    const res = await pastDueReminder({ invoiceIds: ['i1'], send: true }, caller)
    expect(res.emailStatus).toBe('SENT')
    expect(mocks.deliverNotice).toHaveBeenCalledTimes(1)
    const call = mocks.deliverNotice.mock.calls[0][0]
    expect(call.draft.to).toEqual(['ap@rohlig.com'])
    expect(call.attachments).toBeUndefined()
    expect(call.htmlBody).toContain('<table')
    expect(mocks.transact).toHaveBeenCalledTimes(1)
    expect(mocks.writeAudit).toHaveBeenCalledWith('Invoice', 'i1', 'PAST_DUE_REMINDER_SENT', caller, expect.objectContaining({ status: 'SENT' }))
  })

  it('uses edited recipients and rejects a bad address', async () => {
    const res = await pastDueReminder({ invoiceIds: ['i1'], send: true, to: ['Pay@Rohlig.com'], cc: [] }, caller)
    expect(res.to).toEqual(['pay@rohlig.com'])
    await expect(pastDueReminder({ invoiceIds: ['i1'], to: ['nope'] }, caller)).rejects.toThrow(/not a valid e-mail/)
  })

  it('does not stamp the invoice when the e-mail was not sent', async () => {
    mocks.deliverNotice.mockResolvedValue({ status: 'FAILED', error: 'denied' })
    const res = await pastDueReminder({ invoiceIds: ['i1'], send: true }, caller)
    expect(res.emailStatus).toBe('FAILED')
    expect(mocks.transact).not.toHaveBeenCalled()
  })

  it('refuses factored, paid and not-yet-due invoices', async () => {
    seed({ factored: true })
    await expect(pastDueReminder({ invoiceIds: ['i1'] }, caller)).rejects.toThrow(/OTR collects/)
    seed({ status: 'PAID' })
    await expect(pastDueReminder({ invoiceIds: ['i1'] }, caller)).rejects.toThrow(/open invoice/)
    seed({ dueAt: '2999-01-01' })
    await expect(pastDueReminder({ invoiceIds: ['i1'] }, caller)).rejects.toThrow(/Not past due/)
  })

  it('refuses invoices from two customers', async () => {
    mocks.rows.set('Invoice:i2', { ...(mocks.rows.get('Invoice:i1') as Row), id: 'i2', customerId: 'c2' })
    await expect(pastDueReminder({ invoiceIds: ['i1', 'i2'] }, caller)).rejects.toThrow(/one customer/)
  })

  it('asks for confirmation when a reminder went out in the last three days, and refuses with no address', async () => {
    seed({ pastDueReminderSentAt: '2026-11-16T12:00:00.000Z' })
    const preview = await pastDueReminder({ invoiceIds: ['i1'] }, caller)
    expect((preview.recent as unknown[]).length).toBe(1)
    await expect(pastDueReminder({ invoiceIds: ['i1'], send: true }, caller)).rejects.toThrow(/confirm to send another/)
    await expect(pastDueReminder({ invoiceIds: ['i1'], send: true, confirmRecent: true }, caller)).resolves.toMatchObject({ emailStatus: 'SENT' })
    seed()
    mocks.rows.set('Customer:c1', { id: 'c1', name: 'ROHLIG LOGISTICS' })
    await expect(pastDueReminder({ invoiceIds: ['i1'], send: true }, caller)).rejects.toThrow(/Missing invoice e-mail/)
  })
})
