import { describe, it, expect } from 'vitest'
import { customerInvoiceEmailState, carrierRemitEmailState, groupRemitMethods, partitionForPostAll } from './emailReadiness'

describe('email readiness', () => {
  it('flags unset and manual invoice addresses, and demotes only factored missing/invalid addresses', () => {
    expect(customerInvoiceEmailState({ apEmail: '  ' })).toBe('MISSING')
    expect(customerInvoiceEmailState({ billingMethod: 'MANUAL', apEmail: 'not-email' })).toBe('INVALID')
    expect(customerInvoiceEmailState({ billingMethod: 'FACTOR' })).toBe('FACTORED_QUEUE_ONLY')
    expect(customerInvoiceEmailState({ billingMethod: 'FACTOR', apEmail: 'bad' })).toBe('FACTORED_QUEUE_ONLY')
    expect(customerInvoiceEmailState({ billingMethod: 'FACTOR', apEmail: ' ap@example.test ' })).toBe('OK')
    expect(customerInvoiceEmailState({ apEmail: 'ap@example.test' })).toBe('OK')
  })
  it('joins only the carrier’s methods, never its contact email; valid wins over blank/invalid', () => {
    const carrier = { id: 'a', email: 'dispatch@example.test' }
    const methods = [{ carrierId: 'b', payeeEmail: 'remit@example.test' }, { carrierId: 'a', payeeEmail: ' ' }]
    expect(carrierRemitEmailState(carrier, methods)).toBe('MISSING')
    methods.push({ carrierId: 'a', payeeEmail: 'bad' })
    expect(carrierRemitEmailState(carrier, methods)).toBe('INVALID')
    methods.push({ carrierId: 'a', payeeEmail: 'pay@example.test' })
    expect(carrierRemitEmailState(carrier, groupRemitMethods(methods).get('a')!)).toBe('OK')
    expect(methods[1].payeeEmail).toBe(' ')
  })
  it('accounts for every skipped row with a reason, preserving ready rows and order', () => {
    const rows = [{ id: 'yes', emailState: 'OK' }, { id: 'missing', emailState: 'MISSING' }, { id: 'factor', emailState: 'FACTORED_QUEUE_ONLY' }, { id: 'invalid', emailState: 'INVALID' }] as const
    const result = partitionForPostAll(rows)
    expect(result.ready).toEqual([rows[0]])
    expect(result.skipped).toEqual([
      { id: 'missing', reason: 'Missing e-mail address' },
      { id: 'factor', reason: 'Factored: use the factoring queue' },
      { id: 'invalid', reason: 'Invalid e-mail address' },
    ])
    expect(partitionForPostAll([])).toEqual({ ready: [], skipped: [] })
  })
})

import { carrierPayToText } from './emailReadiness'
describe('carrierPayToText', () => {
  const carrier = { name: 'Blue Star Express' }
  it('names the factor when the preferred method pays a factor', () => {
    expect(carrierPayToText(carrier, [{ carrierId: 'c', recipientType: 'FACTOR', factorName: 'OTR Solutions', isPreferred: true }])).toBe('Factor: OTR Solutions')
  })
  it('is Manual with the payee and method otherwise, skipping inactive methods', () => {
    expect(carrierPayToText(carrier, [
      { carrierId: 'c', recipientType: 'FACTOR', factorName: 'Old', status: 'INACTIVE' },
      { carrierId: 'c', recipientType: 'CARRIER', accountName: 'Blue Star LLC', method: 'ACH' },
    ])).toBe('Manual: Blue Star LLC (ACH)')
    expect(carrierPayToText(carrier, [{ carrierId: 'c', recipientType: 'CARRIER' }])).toBe('Manual: Blue Star Express')
  })
  it('falls back to the carrier factor link, else blank', () => {
    expect(carrierPayToText({ ...carrier, factorPaymentMethodId: 'x' }, [])).toBe('Factor')
    expect(carrierPayToText(carrier, [])).toBe('')
  })
})
