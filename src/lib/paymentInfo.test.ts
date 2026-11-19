import { describe, expect, it } from 'vitest'
import { paymentGapMessage, paymentInfoGap } from './paymentInfo'

const address = { street: '1 Main St', city: 'Joliet', state: 'IL', zip: '60431' }

describe('paymentInfoGap', () => {
  it('flags a bill with no method as having no payee', () => {
    expect(paymentInfoGap({ method: null, bankOnFile: false })).toBe('NO_PAYEE')
    expect(paymentInfoGap({ method: '  ', bankOnFile: true })).toBe('NO_PAYEE')
  })

  it('needs bank details on file for ACH, whatever else is filled in', () => {
    expect(paymentInfoGap({ method: 'ACH', bankOnFile: false, accountLast4: '1234', address })).toBe('NO_BANK')
    expect(paymentInfoGap({ method: 'ACH', bankOnFile: true })).toBeNull()
  })

  it('needs the account last four for a wire or an EFT', () => {
    expect(paymentInfoGap({ method: 'WIRE', bankOnFile: false })).toBe('NO_ACCOUNT')
    expect(paymentInfoGap({ method: 'EFT', bankOnFile: false, accountLast4: ' ' })).toBe('NO_ACCOUNT')
    expect(paymentInfoGap({ method: 'WIRE', bankOnFile: false, accountLast4: '9876' })).toBeNull()
  })

  it('needs a complete remit-to address for a check', () => {
    expect(paymentInfoGap({ method: 'CHECK', bankOnFile: false })).toBe('NO_ADDRESS')
    expect(paymentInfoGap({ method: 'CHECK', bankOnFile: false, address: { ...address, zip: '' } })).toBe('NO_ADDRESS')
    expect(paymentInfoGap({ method: 'CHECK', bankOnFile: false, address })).toBeNull()
  })

  it('needs the contact for Zelle and Venmo', () => {
    expect(paymentInfoGap({ method: 'ZELLE', bankOnFile: false })).toBe('NO_CONTACT')
    expect(paymentInfoGap({ method: 'VENMO', bankOnFile: false, contact: 'pay@example.com' })).toBeNull()
  })

  it('needs nothing more for a card', () => {
    expect(paymentInfoGap({ method: 'CARD', bankOnFile: false })).toBeNull()
  })

  it('names the payee and what to add', () => {
    expect(paymentGapMessage('NO_BANK', 'Blue Ridge Trucking')).toContain('Blue Ridge Trucking has no bank details')
    expect(paymentGapMessage('NO_CONTACT', 'Cardinal Express', 'VENMO')).toContain('Venmo')
  })
})
