import { describe, expect, it } from 'vitest'
import type { CarrierBillRecord, CarrierPaymentMethodRecord } from '../../../src/types/tms'
import { assertSamePayTo, autoRemittanceDecision, payToIdentityOf, remitRecipientsFor, remittanceOptions } from './apPayments'

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

describe('the remit address is the pay to\'s (Ryne 2026-11-19)', () => {
  const direct = (name: string) => [{ id: 'b1', carrierId: 'car1', paymentMethodId: 'pm1', carrierName: name, payeeKind: 'CARRIER' } as CarrierBillRecord]

  it('sends a direct payee to the address filed for its name, over the snapshot and its own method copy', () => {
    const decision = autoRemittanceDecision(
      ctx({ bills: direct('Green Haul Inc'), factorEmails: { 'GREEN HAUL': { name: 'Green Haul Inc', email: 'filed@green.test' } }, payment: { remitTo: { payeeEmail: 'snap@green.test' } } }),
      undefined,
    )
    expect(decision).toEqual({ action: 'SEND', to: ['filed@green.test'] })
  })

  it('sends two carriers paid through the same factor to the same address', () => {
    const factorEmails = { 'RTS FINANCIAL': { name: 'RTS Financial', email: 'remit@rts.test' } }
    const method = (carrierId: string, factorName: string) => [{ id: 'pm1', carrierId, status: 'ACTIVE', recipientType: 'FACTOR', factorName, payeeEmail: `own-${carrierId}@rts.test` }] as CarrierPaymentMethodRecord[]
    const a = autoRemittanceDecision(ctx({ methods: method('car1', 'RTS Financial'), factorEmails }), undefined)
    const b = autoRemittanceDecision(ctx({ methods: method('car2', 'RTS FINANCIAL'), factorEmails }), undefined)
    expect(a).toEqual({ action: 'SEND', to: ['remit@rts.test'] })
    expect(b).toEqual(a)
  })

  it('names a payee frozen on the bill, so a pay to that is not the carrier gets its own address', () => {
    const bills = [{ id: 'b1', carrierId: 'car1', paymentMethodId: 'pm1', carrierName: 'Owner Op', payeeKind: 'CARRIER', remitTo: { name: 'Fleet Manager LLC' } } as CarrierBillRecord]
    const factorEmails = { 'FLEET MANAGER': { name: 'Fleet Manager LLC', email: 'pay@fleetmanager.test' } }
    expect(autoRemittanceDecision(ctx({ bills, factorEmails }), undefined)).toEqual({ action: 'SEND', to: ['pay@fleetmanager.test'] })
  })

  it('falls back to the carrier\'s own address while nothing is filed for the pay to', () => {
    expect(autoRemittanceDecision(ctx({ bills: direct('Green Haul Inc'), factorEmails: {} }), undefined)).toEqual({ action: 'SEND', to: ['ap@blue.com'] })
  })
})

describe('remittanceOptions (historical payments)', () => {
  it('suppresses only on a literal true and says so in the note', () => {
    expect(remittanceOptions(true, 'Zelle')).toEqual({
      suppressRemittance: true,
      note: 'Historical payment recorded outside the app, no remittance sent — Zelle',
    })
    expect(remittanceOptions(true, undefined).note).toBe('Historical payment recorded outside the app, no remittance sent')
  })

  it('still e-mails by default and for anything that is not true', () => {
    expect(remittanceOptions(undefined, 'x')).toEqual({ suppressRemittance: false, note: 'x' })
    expect(remittanceOptions('true', null).suppressRemittance).toBe(false)
    expect(remittanceOptions(1, null).suppressRemittance).toBe(false)
  })
})

describe('assertSamePayTo (paying carriers together)', () => {
  const id = (carrierId: string, payTo: string, to: string[]) => ({ carrierId, payTo, key: payTo.toUpperCase().replace(/[^A-Z0-9 ]/g, ''), to })

  it('lets carriers paid to the same pay-to at the same address go together', () => {
    expect(() => assertSamePayTo([id('c1', 'Triumph Capital', ['AP@triumph.test']), id('c2', 'Triumph Capital', ['ap@triumph.test'])])).not.toThrow()
  })

  it('lets a single carrier through whatever its pay-to', () => {
    expect(() => assertSamePayTo([id('c1', 'Blue Line', ['a@b.test'])])).not.toThrow()
  })

  it('refuses different pay-tos and names them', () => {
    expect(() => assertSamePayTo([id('c1', 'Triumph Capital', ['a@t.test']), id('c2', 'OTR Capital', ['a@o.test'])]))
      .toThrow(/different payees \(Triumph Capital; OTR Capital\)/)
  })

  it('refuses one pay-to with two remit addresses', () => {
    expect(() => assertSamePayTo([id('c1', 'Triumph Capital', ['a@t.test']), id('c2', 'Triumph Capital', ['b@t.test'])]))
      .toThrow(/different remittance e-mail/)
  })
})

describe('payToIdentityOf', () => {
  it('reads a factor-paid carrier as the factor, and a direct one as itself', () => {
    const factored = payToIdentityOf({
      carrierId: 'c1',
      bills: [{ id: 'b1', carrierId: 'c1', paymentMethodId: 'pm1', carrierName: 'Blue Line' } as CarrierBillRecord],
      carrier: null,
      contacts: [],
      methods: [{ id: 'pm1', carrierId: 'c1', status: 'ACTIVE', recipientType: 'FACTOR', factorName: 'Triumph Capital LLC', payeeEmail: 'ap@t.test' } as CarrierPaymentMethodRecord],
    })
    expect(factored.payTo).toBe('Triumph Capital LLC')
    expect(factored.to).toEqual(['ap@t.test'])
    const direct = payToIdentityOf({
      carrierId: 'c2',
      bills: [{ id: 'b2', carrierId: 'c2', paymentMethodId: 'pm2', carrierName: 'Red Line' } as CarrierBillRecord],
      carrier: null,
      contacts: [],
      methods: [{ id: 'pm2', carrierId: 'c2', status: 'ACTIVE', payeeEmail: 'ap@r.test' } as CarrierPaymentMethodRecord],
    })
    expect(direct.payTo).toBe('Red Line')
    expect(direct.key).not.toBe(factored.key)
  })
})
