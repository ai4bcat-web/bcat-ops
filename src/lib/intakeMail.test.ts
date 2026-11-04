import { describe, it, expect } from 'vitest'
import {
  checkIntakeEmail,
  DEMO_INTAKE_ADDRESSES,
  RESERVED_INTAKE_ADDRESSES,
  intakeEmailOwner,
  matchDivisionByAddresses,
  normalizeIntakeEmail,
  suggestIntakeMailboxes,
} from './intakeMail'

const DIVS = [
  { code: 'BROKERAGE', name: 'BCAT Logistics', active: true, intakeEmail: 'Tenders@bcatcorp.com' },
  { code: 'ASSETS', name: 'Ivan Cartage', active: true, intakeEmail: 'assets@bcatcorp.com' },
  { code: 'OLD', name: 'Old', active: false, intakeEmail: 'old@bcatcorp.com' },
  { code: 'NONE', name: 'No address', active: true, intakeEmail: null },
]

describe('checkIntakeEmail', () => {
  it('normalises case and whitespace', () => {
    expect(checkIntakeEmail('  Tenders@BCATcorp.com ')).toMatchObject({ email: 'tenders@bcatcorp.com', problem: null })
    expect(normalizeIntakeEmail('   ')).toBeNull()
  })

  it.each([
    ['', 'EMPTY'],
    ['a b@bcatcorp.com', 'FORMAT'],
    ['a@b', 'FORMAT'],
    ['a@b.com, c@d.com', 'FORMAT'],
    ['Name <a@b.com>', 'FORMAT'],
    ['a@@b.com', 'FORMAT'],
    [`${'x'.repeat(65)}@bcatcorp.com`, 'FORMAT'],
    ['ai4bcat+tracking-shp-1@gmail.com', 'RESERVED'],
    ['quotes@bcatcorp.com', 'RESERVED'],
    ['trucks@bcatcorp.com', 'RESERVED'],
  ])('refuses %j as %s', (raw, problem) => {
    expect(checkIntakeEmail(raw)).toMatchObject({ problem })
    expect(checkIntakeEmail(raw).message).toBeTruthy()
  })

  it('allows the intake mailbox plus addresses and warns, not blocks, on an unknown domain', () => {
    expect(checkIntakeEmail('ai4bcat+tenders-assets@gmail.com')).toMatchObject({ problem: null, unverifiedDomain: false })
    expect(checkIntakeEmail('loads@partner.example')).toMatchObject({ problem: null, unverifiedDomain: true })
  })

  it('DEMO: the consumer demo mailbox may be owned by a division and routes; every other reserved address is still refused', () => {
    expect(DEMO_INTAKE_ADDRESSES).toEqual(['ai4bcat@gmail.com'])
    expect(checkIntakeEmail(' AI4BCAT@gmail.com ')).toMatchObject({ email: 'ai4bcat@gmail.com', problem: null, unverifiedDomain: false })
    for (const reserved of RESERVED_INTAKE_ADDRESSES.filter((a) => !DEMO_INTAKE_ADDRESSES.includes(a))) {
      expect(checkIntakeEmail(reserved)).toMatchObject({ problem: 'RESERVED' })
    }
    const divisions = [{ code: 'DEMO', active: true, intakeEmail: 'ai4bcat@gmail.com' }]
    expect(matchDivisionByAddresses(['stranger@else.com'], divisions)).toBeNull()
    expect(matchDivisionByAddresses(['stranger@else.com', 'AI4BCAT@gmail.com'], divisions)).toEqual({ divisionCode: 'DEMO', address: 'ai4bcat@gmail.com' })
  })
})

describe('intakeEmailOwner', () => {
  it('finds the active owner case-insensitively and ignores archived rows and the division itself', () => {
    expect(intakeEmailOwner(DIVS, 'tenders@BCATCORP.com')?.code).toBe('BROKERAGE')
    expect(intakeEmailOwner(DIVS, 'tenders@bcatcorp.com', 'BROKERAGE')).toBeNull()
    expect(intakeEmailOwner(DIVS, 'old@bcatcorp.com')).toBeNull()
    expect(intakeEmailOwner(DIVS, '')).toBeNull()
  })
})

describe('suggestIntakeMailboxes', () => {
  it('offers the shared and plus addresses, disabling what another division owns', () => {
    const s = suggestIntakeMailboxes({ divisionCode: 'BOX_TRUCK', divisions: DIVS })
    const shared = s.find((x) => x.email === 'tenders@bcatcorp.com')
    expect(shared?.disabledReason).toBe('Used by BCAT Logistics')
    expect(s.find((x) => x.email === 'ai4bcat+tenders-box-truck@gmail.com')?.disabledReason).toBeUndefined()
    expect(s.find((x) => x.email === 'assets@bcatcorp.com')?.disabledReason).toBe('Used by Ivan Cartage')
    expect(s.some((x) => x.email === 'old@bcatcorp.com')).toBe(false)
  })

  it('does not disable the address the division itself already owns', () => {
    const s = suggestIntakeMailboxes({ divisionCode: 'BROKERAGE', divisions: DIVS })
    expect(s.find((x) => x.email === 'tenders@bcatcorp.com')?.disabledReason).toBeUndefined()
  })
})

describe('matchDivisionByAddresses', () => {
  it('takes the first reported address an active division owns', () => {
    expect(matchDivisionByAddresses(['x@y.com', 'ASSETS@bcatcorp.com', 'tenders@bcatcorp.com'], DIVS))
      .toEqual({ divisionCode: 'ASSETS', address: 'assets@bcatcorp.com' })
  })

  it('returns null for unowned and archived addresses', () => {
    expect(matchDivisionByAddresses(['old@bcatcorp.com', 'nobody@bcatcorp.com'], DIVS)).toBeNull()
    expect(matchDivisionByAddresses([], DIVS)).toBeNull()
  })

  it('routes nothing by a seeded placeholder address until a person confirms it', () => {
    const divs = [
      { code: 'ASSETS', active: true, intakeEmail: 'tenders-ivan-cartage@bcatcorp.com', intakeEmailConfirmed: false },
      { code: 'BROKERAGE', active: true, intakeEmail: 'tenders@bcatcorp.com', intakeEmailConfirmed: true },
      { code: 'LEGACY', active: true, intakeEmail: 'legacy@bcatcorp.com', intakeEmailConfirmed: null },
    ]
    expect(matchDivisionByAddresses(['tenders-ivan-cartage@bcatcorp.com'], divs)).toBeNull()
    expect(matchDivisionByAddresses(['tenders-ivan-cartage@bcatcorp.com', 'tenders@bcatcorp.com'], divs))
      .toEqual({ divisionCode: 'BROKERAGE', address: 'tenders@bcatcorp.com' })
    expect(matchDivisionByAddresses(['legacy@bcatcorp.com'], divs)).toEqual({ divisionCode: 'LEGACY', address: 'legacy@bcatcorp.com' })
  })
})
