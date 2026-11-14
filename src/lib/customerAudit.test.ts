import { describe, expect, it } from 'vitest'
import {
  changeNeedsReason, customerHistory, customerHistoryEntry, diffCustomer, formatAuditValue,
} from './customerAudit'

describe('diffCustomer', () => {
  it('lists only real changes, ignoring bookkeeping and blank-vs-missing', () => {
    const before = { name: 'Acme', contactName: null, aliases: [], billingAddress: { city: 'Austin', zip: '78701' }, updatedAt: 'a' }
    const after = { name: 'Acme', contactName: '', aliases: undefined, billingAddress: { zip: '78701', city: 'Austin' }, updatedAt: 'b', paymentTermsDays: 30 }
    expect(diffCustomer(before, after)).toEqual([{ field: 'paymentTermsDays', before: null, after: 30 }])
  })

  it('treats a create as every field with a value', () => {
    expect(diffCustomer(null, { name: 'Acme', notes: null, createdAt: 'x' })).toEqual([{ field: 'name', before: null, after: 'Acme' }])
  })

  it('reads AWSJSON strings as their objects', () => {
    expect(diffCustomer({ contacts: '[{"name":"A"}]' }, { contacts: [{ name: 'A' }] })).toEqual([])
  })
})

describe('changeNeedsReason', () => {
  it('asks for a reason on payment method, terms, factoring and billing e-mails only', () => {
    expect(changeNeedsReason([{ field: 'billingMethod', before: 'FACTOR', after: 'MANUAL' }])).toBe(true)
    expect(changeNeedsReason([{ field: 'apEmail', before: null, after: 'ap@x.com' }])).toBe(true)
    expect(changeNeedsReason([{ field: 'factored', before: false, after: true }])).toBe(true)
    expect(changeNeedsReason([{ field: 'contactName', before: null, after: 'Pat' }])).toBe(false)
  })
})

describe('customerHistoryEntry', () => {
  const row = (action: string, changes: unknown, user = 'ryne@bcatcorp.com', createdAt = '2026-11-14T10:00:00Z') =>
    ({ id: action + createdAt, action, user, createdAt, changes: JSON.stringify(changes) })

  it('reads the new shape', () => {
    const e = customerHistoryEntry(row('CUSTOMER_UPDATED', { kind: 'customer-change', fields: [{ field: 'paymentTermsDays', before: 30, after: 45 }], reason: 'Net 45 agreed', source: 'Customer profile' }))
    expect(e).toMatchObject({ title: 'Profile edited', reason: 'Net 45 agreed', source: 'Customer profile', fields: [{ field: 'paymentTermsDays', before: 30, after: 45 }] })
  })

  it('reads the import scripts\' previous/next rows with their source', () => {
    const e = customerHistoryEntry(row('AW_CUSTOMER_BILLING_EMAILS', { previous: { apEmail: null }, next: { apEmail: 'ap@x.com' }, source: 'OTR billing emails list' }, 'system:awCustomerBillingEmails'))
    expect(e).toMatchObject({ title: 'Updated by an import', user: 'Script awCustomerBillingEmails', source: 'OTR billing emails list', fields: [{ field: 'apEmail', before: null, after: 'ap@x.com' }] })
  })

  it('reads the OTR rejected → manual invoice row with the rejection as the reason', () => {
    const e = customerHistoryEntry(row('BILLING_METHOD_CHANGED', { oldMethod: 'FACTOR', newMethod: 'MANUAL', otrReason: 'Debtor not approved' }))
    expect(e).toMatchObject({ title: 'Payment method changed', reason: 'Debtor not approved', fields: [{ field: 'billingMethod', before: 'FACTOR', after: 'MANUAL' }] })
  })

  it('reads before/after billing rows and per-field from/to rows', () => {
    expect(customerHistoryEntry(row('BILLING_METHOD_SET', { name: 'A', before: { billingMethod: null }, after: { billingMethod: 'FACTOR' } })).fields)
      .toEqual([{ field: 'billingMethod', before: null, after: 'FACTOR' }])
    expect(customerHistoryEntry(row('AW_CUSTOMERS_ACTIVATE', { status: { from: 'DORMANT', to: 'ACTIVE' } })).fields)
      .toEqual([{ field: 'status', before: 'DORMANT', after: 'ACTIVE' }])
  })

  it('sorts newest first', () => {
    const h = customerHistory([row('A', {}, 'u', '2026-01-01T00:00:00Z'), row('B', {}, 'u', '2026-02-01T00:00:00Z')])
    expect(h.map((e) => e.action)).toEqual(['B', 'A'])
  })
})

describe('formatAuditValue', () => {
  it('prints values the way people read them', () => {
    expect(formatAuditValue('billingMethod', 'MANUAL')).toBe('Manual invoice')
    expect(formatAuditValue('paymentTermsDays', 45)).toBe('Net 45')
    expect(formatAuditValue('creditLimitCents', 500000)).toBe('$5,000')
    expect(formatAuditValue('apEmail', null)).toBe('(blank)')
    expect(formatAuditValue('factored', true)).toBe('Yes')
  })
})
