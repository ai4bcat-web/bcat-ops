import { describe, expect, it } from 'vitest'
import { applyFactorRemit } from '@/lib/factorRemit'
import { carrierNeedsRemit, carrierRemitRows, matchesSearch } from './remitDirectory'

const carriers = [
  { id: 'c1', name: 'Direct Haul', mcNumber: '111', status: 'ACTIVE', email: 'office@direct.test' },
  { id: 'c2', name: 'Factored Freight', mcNumber: '222', status: 'ACTIVE' },
  { id: 'c3', name: 'Nobody Trucking', mcNumber: '333', status: 'ACTIVE' },
  { id: 'c4', name: 'No Email Direct', status: 'ACTIVE', email: 'fallback@x.test' },
  { id: 'c5', name: 'Bad Email Direct', status: 'ACTIVE' },
]
const methods = [
  { carrierId: 'c1', recipientType: 'CARRIER', payeeEmail: 'ap@direct.test', isPreferred: true },
  { carrierId: 'c2', recipientType: 'FACTOR', factorName: 'RTS Financial', payeeEmail: 'old@rts.test', isPreferred: true },
  { carrierId: 'c4', recipientType: 'CARRIER', payeeEmail: null, isPreferred: true },
  { carrierId: 'c5', recipientType: 'CARRIER', payeeEmail: 'not-an-email', isPreferred: true },
]
const map = { 'RTS FINANCIAL': { name: 'RTS Financial', email: 'cash@rts.test' } }

describe('carrierRemitRows', () => {
  const rows = carrierRemitRows(carriers, applyFactorRemit(methods, map))
  const by = (id: string) => rows.find((r) => r.id === id)!

  it('shows a direct carrier its own address', () => {
    expect(by('c1')).toMatchObject({ state: 'OWN', email: 'ap@direct.test', paidVia: 'Direct' })
  })
  it('shows a factor-paid carrier the factor\'s one address, not its own copy', () => {
    expect(by('c2')).toMatchObject({ state: 'FACTOR', email: 'cash@rts.test', paidVia: 'RTS Financial', factorKey: 'RTS FINANCIAL' })
  })
  it('flags no payment info, a missing address and an invalid one', () => {
    expect(by('c3').state).toBe('NO_PAYMENT_INFO')
    expect(by('c4')).toMatchObject({ state: 'MISSING', carrierEmail: 'fallback@x.test' })
    expect(by('c5').state).toBe('INVALID')
    expect(rows.filter(carrierNeedsRemit).map((r) => r.id)).toEqual(['c3', 'c4', 'c5'])
  })
})

describe('matchesSearch', () => {
  it('matches any field, ignoring case, and everything for an empty search', () => {
    expect(matchesSearch('rts', 'Factored Freight', 'RTS Financial')).toBe(true)
    expect(matchesSearch('zzz', 'Factored Freight', null)).toBe(false)
    expect(matchesSearch('  ', 'anything')).toBe(true)
  })
})
