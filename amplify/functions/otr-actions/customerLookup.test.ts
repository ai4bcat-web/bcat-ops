import { describe, expect, it } from 'vitest'
import { customerLookupFrom } from './customerLookup'

describe('customerLookupFrom', () => {
  it('reads OTR v2 broker-check reply into the new-customer fields', () => {
    const r = customerLookupFrom('764581', {
      decision: 'APPROVED',
      message: '',
      brokerName: 'American Logistics Group',
      raw: { id: '759', Name: 'American Logistics Group', McNumber: '764581', BrokerTestResult: 'Approved', NoBuy: false, ResponseStatus: 200 },
    })
    expect(r).toEqual({ found: true, mcNumber: '764581', name: 'American Logistics Group', decision: 'APPROVED', noBuy: false, otrId: '759', message: '' })
  })
  it('says plainly when OTR has no such MC', () => {
    const r = customerLookupFrom('77731', { decision: 'NOT FOUND', message: 'x', brokerName: null, raw: { Message: 'not found', ResponseStatus: 404 } })
    expect(r.found).toBe(false)
    expect(r.message).toBe('OTR has no customer with MC 77731')
  })
  it('flags No Buy', () => {
    expect(customerLookupFrom('1', { decision: 'NO BUY', message: '', brokerName: 'X', raw: {} }).noBuy).toBe(true)
  })
})
