import { describe, expect, it } from 'vitest'
import type { CarrierPaymentMethodRecord } from '../../../src/types/tms'
import { basePro, classifyAchBill } from './achRows'

// Synthetic data only.
const carrier = { name: 'Fake Trucking LLC', address: null, email: null, factorPaymentMethodId: null }
const ach = (over: Partial<CarrierPaymentMethodRecord> = {}): CarrierPaymentMethodRecord =>
  ({ id: 'm1', carrierId: 'c1', method: 'ACH', recipientType: 'CARRIER', accountLast4: '3456', isPreferred: true, status: 'ACTIVE', ...over }) as CarrierPaymentMethodRecord
const bill = (over: Record<string, unknown> = {}) => ({
  id: 'b1', status: 'TO_BE_PAID', balanceCents: 95000, shipmentNumber: '14525-2', payeeKind: 'CARRIER', paymentMethodId: null, remitTo: null, carrierName: 'Fake Trucking LLC', ...over,
}) as never
const details = { routingNumber: '011000015', accountNumber: '000123456', accountType: 'CHECKING' as const }

describe('classifyAchBill', () => {
  it('turns an approved ACH bill with bank details into an entry', () => {
    const row = classifyAchBill(bill(), carrier, [ach()], details)
    expect(row.status).toBe('READY')
    if (row.status !== 'READY') return
    expect(row.entry).toMatchObject({ amountCents: 95000, identification: '14525', accountType: 'CHECKING' })
    expect(row.entry.addenda).toBe('BCAT PRO 14525')
    expect(row.preview.last4).toBe('3456')
    expect(JSON.stringify(row.preview)).not.toContain('000123456')
    expect(JSON.stringify(row.preview)).not.toContain('011000015')
  })
  it('skips every method that is not ACH, credit card included', () => {
    for (const method of ['CHECK', 'WIRE', 'ZELLE', 'CREDIT_CARD']) {
      const row = classifyAchBill(bill(), carrier, [ach({ method: method as never })], details)
      expect(row.status).toBe('SKIPPED')
    }
  })
  it('blocks a row with no bank details, a bad routing number or a mismatched account', () => {
    expect(classifyAchBill(bill(), carrier, [ach()], null)).toMatchObject({ status: 'BLOCKED' })
    expect(classifyAchBill(bill(), carrier, [ach()], { ...details, routingNumber: '011000016' })).toMatchObject({ status: 'BLOCKED' })
    expect(classifyAchBill(bill(), carrier, [ach()], { ...details, accountNumber: '000999999' })).toMatchObject({ status: 'BLOCKED' })
  })
  it('blocks no pay-to, a zero balance and an unapproved bill is skipped', () => {
    expect(classifyAchBill(bill(), carrier, [], details)).toMatchObject({ status: 'BLOCKED' })
    expect(classifyAchBill(bill({ balanceCents: 0 }), carrier, [ach()], details)).toMatchObject({ status: 'BLOCKED' })
    expect(classifyAchBill(bill({ status: 'IN_REVIEW' }), carrier, [ach()], details)).toMatchObject({ status: 'SKIPPED' })
  })
  it('warns when the account type was not recorded', () => {
    const row = classifyAchBill(bill(), carrier, [ach()], { ...details, accountType: null })
    expect(row.status === 'READY' && row.warnings.length).toBe(1)
  })
})

describe('basePro', () => {
  it('drops the leg suffix', () => {
    expect(basePro('14598-2')).toBe('14598')
    expect(basePro(null)).toBe('')
  })
})
