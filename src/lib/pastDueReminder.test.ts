import { describe, it, expect } from 'vitest'
import {
  isPastDueReminderEligible,
  pastDueReason,
  pastDueReminderEmail,
  pastDueRows,
  pastDueSentence,
  remindedRecently,
} from './pastDueReminder'
import type { InvoiceRecord } from '../types/tms'

const AS_OF = '2026-11-17'

function inv(over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: 'i1', number: '14051', shipmentId: 's1', shipmentNumber: '14051', customerId: 'c1',
    status: 'ISSUED', invoiceDate: '2026-08-05', dueAt: '2026-09-04', totalCents: 22995, paidCents: 0, writtenOffCents: 0, balanceCents: 22995,
    references: [{ type: 'PO', value: 'PO-77' }], factored: false,
    ...over,
  } as unknown as InvoiceRecord
}

describe('past-due eligibility', () => {
  it('accepts an open, owing, past-due, hand-billed invoice', () => {
    expect(isPastDueReminderEligible(inv(), AS_OF)).toBe(true)
  })
  it('refuses current, paid, void, zero-balance and factored invoices', () => {
    expect(pastDueReason(inv({ dueAt: '2026-11-20' }), AS_OF)).toBe('Not past due yet')
    expect(pastDueReason(inv({ dueAt: AS_OF }), AS_OF)).toBe('Not past due yet')
    expect(pastDueReason(inv({ status: 'PAID' }), AS_OF)).toMatch(/open invoice/)
    expect(pastDueReason(inv({ status: 'VOID' }), AS_OF)).toMatch(/open invoice/)
    expect(pastDueReason(inv({ balanceCents: 0 }), AS_OF)).toMatch(/Nothing is owed/)
    expect(pastDueReason(inv({ factored: true }), AS_OF)).toMatch(/OTR collects/)
    expect(pastDueReason(inv({ factoringItemId: 'f1' }), AS_OF)).toMatch(/OTR collects/)
  })
})

describe('the e-mail', () => {
  it('names the days for one invoice, in Ryne\'s words', () => {
    const rows = pastDueRows([inv()], AS_OF)
    expect(rows[0].daysPastDue).toBe(74)
    expect(pastDueSentence(rows)).toBe('Hi, the invoice below is 74 days past due. Can you please advise when payment will be made?')
  })
  it('says "1 day" in the singular', () => {
    expect(pastDueSentence([{ daysPastDue: 1 }])).toContain('is 1 day past due')
  })
  it('points several invoices at the table and sorts the oldest first', () => {
    const rows = pastDueRows([inv({ id: 'a', number: '2', dueAt: '2026-11-10' }), inv({ id: 'b', number: '1', dueAt: '2026-10-01' })], AS_OF)
    expect(rows.map((r) => r.invoiceNumber)).toEqual(['1', '2'])
    expect(pastDueSentence(rows)).toContain('invoices below are past due')
  })
  it('builds a table with a total and carries nothing but billed amounts', () => {
    const rows = pastDueRows([inv(), inv({ id: 'b', number: '14052', balanceCents: 10000, totalCents: 10000, dueAt: '2026-10-01' })], AS_OF)
    const mail = pastDueReminderEmail({ customerName: 'ROHLIG LOGISTICS', asOf: AS_OF, companyName: 'BCAT Logistics Corporation', rows })
    expect(mail.totalCents).toBe(32995)
    expect(mail.body).toContain('Total past due: $329.95')
    expect(mail.htmlBody).toContain('<table')
    expect(mail.htmlBody).toContain('$329.95')
    expect(mail.subject).toContain('ROHLIG LOGISTICS')
    expect(`${mail.body}${mail.htmlBody}`.toLowerCase()).not.toMatch(/carrier|margin|cost|rate con/)
  })
  it('escapes customer text in the HTML', () => {
    const rows = pastDueRows([inv({ shipmentNumber: '<b>1</b>' })], AS_OF)
    const mail = pastDueReminderEmail({ customerName: 'X', asOf: AS_OF, companyName: 'BCAT', rows })
    expect(mail.htmlBody).not.toContain('<b>1</b>')
    expect(mail.htmlBody).toContain('&lt;b&gt;1')
  })
})

describe('reminder cooldown', () => {
  it('flags a reminder inside three days and not older', () => {
    expect(remindedRecently('2026-11-16T15:00:00Z', AS_OF)).toBe(true)
    expect(remindedRecently('2026-11-14T15:00:00Z', AS_OF)).toBe(false)
    expect(remindedRecently(null, AS_OF)).toBe(false)
  })
})
