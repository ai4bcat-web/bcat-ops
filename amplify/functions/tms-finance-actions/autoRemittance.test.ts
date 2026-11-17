import { describe, expect, it } from 'vitest'
import type { CarrierBillRecord, CarrierPaymentMethodRecord } from '../../../src/types/tms'
import { autoRemittanceDecision, remitRecipientsFor } from './apPayments'

type Ctx = Parameters<typeof remitRecipientsFor>[0]

function ctx(over: Partial<Ctx> & { payment?: Record<string, unknown> } = {}): Ctx {
  return {
    payment: { id: 'app-1', kind: 'PAYMENT', carrierId: 'car1', ...(over.payment ?? {}) },
    bills: over.bills ?? [{ id: 'b1', carrierId: 'car1', paymentMethodId: 'pm1' } as CarrierBillRecord],
    carrier: over.carrier ?? null,
    contacts: over.contacts ?? [],
    methods: over.methods ?? [{ id: 'pm1', carrierId: 'car1', status: 'ACTIVE', payeeEmail: 'ap@blue.com' } as CarrierPaymentMethodRecord],
    factorEmails: over.factorEmails,
  }
}

describe('autoRemittanceDecision', () => {
  it('sends a fresh payment to the payee e-mail', () => {
    expect(autoRemittanceDecision(ctx(), undefined)).toEqual({ action: 'SEND', to: ['ap@blue.com'] })
  })

  it('reads the preferred active method when the bill names none, like the Remit to column', () => {
    const methods = [
      { id: 'old', carrierId: 'car1', status: 'INACTIVE', payeeEmail: 'old@blue.com' },
      { id: 'pm2', carrierId: 'car1', status: 'ACTIVE', isPreferred: true, payeeEmail: 'new@blue.com' },
    ] as CarrierPaymentMethodRecord[]
    const bills = [{ id: 'b1', carrierId: 'car1' } as CarrierBillRecord]
    expect(autoRemittanceDecision(ctx({ methods, bills }), undefined)).toEqual({ action: 'SEND', to: ['new@blue.com'] })
  })

  it('prefers the address snapshotted when the payment went out', () => {
    const decision = autoRemittanceDecision(ctx({ payment: { remitTo: { payeeEmail: 'factor@bank.com' } } }), undefined)
    expect(decision).toEqual({ action: 'SEND', to: ['factor@bank.com'] })
  })

  it('sends a carrier paid through a factor to the factor\'s one address, over the snapshot and the carrier\'s own copy', () => {
    const methods = [{ id: 'pm1', carrierId: 'car1', status: 'ACTIVE', recipientType: 'FACTOR', factorName: 'OTR Capital LLC', payeeEmail: 'old@otr.com' }] as CarrierPaymentMethodRecord[]
    const factorEmails = { 'OTR CAPITAL': { name: 'OTR Capital LLC', email: 'remit@otr.com' } }
    const decision = autoRemittanceDecision(ctx({ methods, factorEmails, payment: { remitTo: { payeeEmail: 'stale@otr.com' } } }), undefined)
    expect(decision).toEqual({ action: 'SEND', to: ['remit@otr.com'] })
  })

  it('falls back to the carrier\'s copy when the factor has no address of its own', () => {
    const methods = [{ id: 'pm1', carrierId: 'car1', status: 'ACTIVE', recipientType: 'FACTOR', factorName: 'OTR Capital LLC', payeeEmail: 'old@otr.com' }] as CarrierPaymentMethodRecord[]
    expect(autoRemittanceDecision(ctx({ methods, factorEmails: {} }), undefined)).toEqual({ action: 'SEND', to: ['old@otr.com'] })
  })

  it('never lets a factor\'s address reach a carrier that is paid directly', () => {
    const methods = [{ id: 'pm1', carrierId: 'car1', status: 'ACTIVE', recipientType: 'CARRIER', factorName: 'OTR Capital LLC', payeeEmail: 'ap@blue.com' }] as CarrierPaymentMethodRecord[]
    const factorEmails = { 'OTR CAPITAL': { name: 'OTR Capital LLC', email: 'remit@otr.com' } }
    expect(autoRemittanceDecision(ctx({ methods, factorEmails }), undefined)).toEqual({ action: 'SEND', to: ['ap@blue.com'] })
  })

  it('skips, and says so, when nobody is on file', () => {
    const methods = [{ id: 'pm1', carrierId: 'car1', status: 'ACTIVE', payeeEmail: null }] as CarrierPaymentMethodRecord[]
    expect(autoRemittanceDecision(ctx({ methods }), undefined)).toEqual({ action: 'SKIP', reason: 'NO_REMIT_EMAIL' })
  })

  it('never sends twice, or after a person has dealt with it', () => {
    for (const payment of [{ remittanceAttempts: 1 }, { remittanceSentAt: '2026-11-17T10:00:00Z' }, { markedSentAt: '2026-11-17T10:00:00Z' }]) {
      expect(autoRemittanceDecision(ctx({ payment }), undefined)).toEqual({ action: 'SKIP', reason: 'ALREADY_HANDLED' })
    }
  })

  it('only fires for a live payment: not a credit, a reversal or a reversed payment', () => {
    expect(autoRemittanceDecision(ctx({ payment: { kind: 'CREDIT_MEMO' } }), undefined)).toMatchObject({ reason: 'NOT_A_PAYMENT' })
    expect(autoRemittanceDecision(ctx({ payment: { kind: 'REVERSAL' } }), undefined)).toMatchObject({ reason: 'NOT_A_PAYMENT' })
    expect(autoRemittanceDecision(ctx({ payment: { reversedByPaymentId: 'x' } }), undefined)).toMatchObject({ reason: 'REVERSED' })
  })

  it('can be switched off', () => {
    expect(autoRemittanceDecision(ctx(), 'off')).toEqual({ action: 'SKIP', reason: 'TURNED_OFF' })
  })
})
