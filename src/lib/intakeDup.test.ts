import { describe, expect, it } from 'vitest'
import { INTAKE_DELETED_REASON, dupBodyKey, dupSubjectKey, isDeletedIntake, isSameEmail, isSameTender } from './intakeDup'

const mail = (over: Record<string, unknown> = {}) => ({ subject: 'Fwd: Rate Confirmation for Load: 69902922', bodyText: 'Please see attached rate con.\n\nThanks', receivedAt: '2026-11-11T14:19:00Z', ...over })

describe('dupSubjectKey', () => {
  it('ignores Re:/Fwd: chains, quotes, case and spacing', () => {
    expect(dupSubjectKey('RE: Fwd:  "Truck  Request"')).toBe('truck request')
    expect(dupSubjectKey(null)).toBe('')
  })
})

describe('isSameEmail', () => {
  it('matches the same message arriving twice, including the group copy', () => {
    expect(isSameEmail(mail(), mail())).toBe(true)
    expect(isSameEmail(mail(), mail({ receivedAt: '2026-11-11T14:21:30Z', bodyText: 'Please see attached rate con.\n\nThanks\n\n-- \nYou received this via the BCAT Loads group' }))).toBe(true)
  })
  it('does not match another tender with the same subject, a far-apart time, or a different body', () => {
    expect(isSameEmail(mail(), mail({ bodyText: 'Different load, different lane' }))).toBe(false)
    expect(isSameEmail(mail(), mail({ receivedAt: '2026-11-11T15:19:00Z' }))).toBe(false)
    expect(isSameEmail(mail(), mail({ subject: 'Fwd: Rate Confirmation for Load: 11111111' }))).toBe(false)
  })
  it('never matches an empty body or a missing time', () => {
    expect(isSameEmail(mail({ bodyText: '' }), mail({ bodyText: '' }))).toBe(false)
    expect(isSameEmail(mail({ receivedAt: null }), mail())).toBe(false)
    expect(dupBodyKey('  A   b ')).toBe('a b')
  })
})

describe('isSameTender', () => {
  const t = (over: Record<string, unknown> = {}) => ({ reference: 'PO-77', fromEmail: 'a@broker.com', customerId: 'cus-1', customerName: 'Acme', attachments: [], ...over })
  it('same reference from the same sender, or from another sender of the same customer', () => {
    expect(isSameTender(t(), t())).toBe(true)
    expect(isSameTender(t(), t({ fromEmail: 'b@broker.com' }))).toBe(true)
    expect(isSameTender(t({ customerId: null }), t({ fromEmail: 'b@broker.com', customerId: null, customerName: ' ACME ' }))).toBe(true)
  })
  it('a reference alone is not enough: another customer may reuse a PO number', () => {
    expect(isSameTender(t(), t({ fromEmail: 'b@x.com', customerId: 'cus-2', customerName: 'Other' }))).toBe(false)
    expect(isSameTender(t({ reference: '' }), t({ reference: '' }))).toBe(false)
  })
  it('the same rate-confirmation file from the same sender is the same load even with another subject or no reference', () => {
    const file = { attachments: [{ name: 'RC 123.pdf', size: 5000 }] }
    expect(isSameTender(t({ reference: '', ...file }), t({ reference: '', ...file }))).toBe(true)
    expect(isSameTender(t({ reference: '', ...file }), t({ reference: '', fromEmail: 'b@x.com', ...file }))).toBe(false)
    expect(isSameTender(t({ reference: '', ...file }), t({ reference: '', attachments: [{ name: 'RC 123.pdf', size: 5001 }] }))).toBe(false)
  })
  it('a Slack-forwarded row counts as any sender for the same reference', () => {
    expect(isSameTender(t(), t({ fromEmail: 'USLACKBOT', customerId: null, customerName: null }))).toBe(true)
  })
})

describe('isDeletedIntake', () => {
  it('only a dismissed row carrying the admin-delete reason', () => {
    expect(isDeletedIntake({ status: 'DISMISSED', dismissReason: INTAKE_DELETED_REASON })).toBe(true)
    expect(isDeletedIntake({ status: 'DISMISSED', dismissReason: `${INTAKE_DELETED_REASON}: spam` })).toBe(true)
    expect(isDeletedIntake({ status: 'DISMISSED', dismissReason: 'spam' })).toBe(false)
    expect(isDeletedIntake({ status: 'OPEN', dismissReason: INTAKE_DELETED_REASON })).toBe(false)
  })
})
