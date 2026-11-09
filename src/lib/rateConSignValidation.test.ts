import { describe, it, expect } from 'vitest'
import { normalizeUsPhone, signErrors, signerNameError } from './rateConSignValidation'

describe('normalizeUsPhone', () => {
  it.each([
    ['(312) 555-0101', '+13125550101'],
    ['312.555.0101', '+13125550101'],
    ['1-312-555-0101', '+13125550101'],
    ['+1 312 555 0101', '+13125550101'],
  ])('%s -> %s', (raw, e164) => expect(normalizeUsPhone(raw)).toBe(e164))

  it.each(['555-0101', '012-555-0101', '312-155-0101', '1112223333x', '2222222222', '', '+44 20 7946 0958'])('refuses %s', (raw) => {
    expect(normalizeUsPhone(raw)).toBeNull()
  })
})

describe('signerNameError', () => {
  it('wants a real name', () => {
    expect(signerNameError('Yuri Petrov')).toBeNull()
    expect(signerNameError("Mary-Ann O'Neil Jr.")).toBeNull()
    expect(signerNameError('')).not.toBeNull()
    expect(signerNameError('Y')).not.toBeNull()
    expect(signerNameError('1234')).not.toBeNull()
  })
})

describe('signErrors', () => {
  const ok = { signerName: 'Yuri Petrov', agreed: true, fields: { DRIVER_PHONE: '312-555-0101' }, required: ['DRIVER_PHONE'] }
  it('is empty only when name, agreement and every required field are good', () => {
    expect(signErrors(ok)).toEqual({})
    expect(Object.keys(signErrors({ ...ok, agreed: false }))).toEqual(['agreed'])
    expect(Object.keys(signErrors({ ...ok, fields: {} }))).toEqual(['DRIVER_PHONE'])
  })
})
