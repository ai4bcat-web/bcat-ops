import { describe, expect, it } from 'vitest'
import { BankVaultError, bankContext, decryptBankDetails, encryptBankDetails, normalizeBankDetails, redactBankNumbers } from './bankVault'
import { fakeKms } from './fakeKms'

// Synthetic numbers only: 011000015 is a public Federal Reserve routing number, the account is made up.
const FAKE_ROUTING = '011000015'
const FAKE_ACCOUNT = '000123456789'
const deps = () => ({ kms: fakeKms(), carrierTable: 'Carrier-5ucwdyvwivelbo4k4jomvrwel4-NONE' })

describe('normalizeBankDetails', () => {
  it('accepts a valid routing and account, ignoring spaces and dashes', () => {
    const out = normalizeBankDetails({ routingNumber: '0110-00015', accountNumber: '0001 2345 6789', accountType: 'SAVINGS' })
    expect(out).toMatchObject({ routingNumber: FAKE_ROUTING, accountNumber: FAKE_ACCOUNT, accountType: 'SAVINGS', routingLast4: '0015', accountLast4: '6789' })
  })
  it('defaults to checking', () => {
    expect(normalizeBankDetails({ routingNumber: FAKE_ROUTING, accountNumber: FAKE_ACCOUNT }).accountType).toBe('CHECKING')
  })
  it('refuses bad numbers with sentences that never echo them', () => {
    const cases: Array<[unknown, unknown, string]> = [
      ['12345', FAKE_ACCOUNT, 'exactly 9 digits'],
      ['011000016', FAKE_ACCOUNT, 'check-digit'],
      [FAKE_ROUTING, '12', '4 to 17 digits'],
      [FAKE_ROUTING, 'ABCD1234', '4 to 17 digits'],
    ]
    for (const [routingNumber, accountNumber, message] of cases) {
      try {
        normalizeBankDetails({ routingNumber, accountNumber })
        throw new Error('should have refused')
      } catch (err) {
        expect(err).toBeInstanceOf(BankVaultError)
        const text = (err as Error).message
        expect(text).toContain(message)
        expect(text).not.toContain(String(routingNumber))
        expect(text).not.toContain(String(accountNumber))
      }
    }
    expect(() => normalizeBankDetails({ routingNumber: FAKE_ROUTING, accountNumber: FAKE_ACCOUNT, accountType: 'MONEY' })).toThrow('checking or savings')
  })
})

describe('encrypt / decrypt', () => {
  const ids = { carrierId: 'car-1', methodId: 'pm-1' }
  const details = normalizeBankDetails({ routingNumber: FAKE_ROUTING, accountNumber: FAKE_ACCOUNT, accountType: 'CHECKING' })

  it('round-trips under the bankAccount field and the carrier', async () => {
    const d = deps()
    const cipher = await encryptBankDetails(d, ids, details)
    expect(d.kms.sent[0].context).toEqual({ carrierId: 'car-1', field: 'bankAccount', api: '5ucwdyvwivelbo4k4jomvrwel4' })
    expect(await decryptBankDetails(d, ids, cipher)).toEqual({ routingNumber: FAKE_ROUTING, accountNumber: FAKE_ACCOUNT, accountType: 'CHECKING' })
  })
  it('does not decrypt for another carrier or another payment method', async () => {
    const d = deps()
    const cipher = await encryptBankDetails(d, ids, details)
    await expect(decryptBankDetails(d, { carrierId: 'car-2', methodId: 'pm-1' }, cipher)).rejects.toThrow('could not be read')
    await expect(decryptBankDetails(d, { carrierId: 'car-1', methodId: 'pm-2' }, cipher)).rejects.toThrow('do not belong')
  })
  it('pins the same three context keys the key policy requires', () => {
    expect(Object.keys(bankContext(deps(), 'car-1')).sort()).toEqual(['api', 'carrierId', 'field'])
  })
})

describe('redactBankNumbers', () => {
  it('scrubs long digit runs', () => {
    expect(redactBankNumbers(`bad ${FAKE_ACCOUNT} and ${FAKE_ROUTING}`)).toBe('bad [redacted] and [redacted]')
  })
})
