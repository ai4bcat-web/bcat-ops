import { describe, expect, it } from 'vitest'
import { insuranceLines, shortMoney } from './coveredCarrierModel'

const NOW = new Date('2026-11-13T12:00:00Z')

describe('insuranceLines', () => {
  it('short chips with compact money and a two-digit year', () => {
    const chips = insuranceLines({ insurancePolicies: [
      { id: 'a', type: 'AUTO_LIABILITY', limitCents: 100_000_000, expiresAt: '2027-06-01T00:00:00.000Z' },
      { id: 'c', type: 'CARGO', limitCents: 10_000_000, expiresAt: '2027-01-01T00:00:00.000Z' },
      { id: 'g', type: 'GENERAL_LIABILITY', limitCents: 500_000_000, expiresAt: null },
    ] } as never, NOW)
    expect(chips.map((c) => [c.text, c.tone])).toEqual([
      ['Auto $1M · exp 06/01/27', 'ok'], ['Cargo $100K · exp 01/01/27', 'ok'], ['GL $5M', 'ok'],
    ])
  })

  it('flags missing and expired red, expiring within 30 days amber', () => {
    const chips = insuranceLines({ insurancePolicies: [
      { id: 'a', type: 'AUTO_LIABILITY', limitCents: 100_000_000, expiresAt: '2026-11-01T00:00:00.000Z' },
      { id: 'w', type: 'WORKERS_COMP', limitCents: 100_000_000, expiresAt: '2026-12-01T00:00:00.000Z' },
    ] } as never, NOW)
    expect(chips.map((c) => [c.text, c.tone])).toEqual([
      ['Auto $1M · expired 11/01/26', 'bad'], ['Cargo not on file', 'bad'], ['WC $1M · exp 12/01/26', 'soon'],
    ])
  })

  it('shortMoney', () => {
    expect([shortMoney(250_000_000), shortMoney(150_000), shortMoney(75_000)]).toEqual(['$2.5M', '$1.5K', '$750'])
  })
})
