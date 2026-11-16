import { describe, expect, it } from 'vitest'
import { customerMatchKey, findCustomerMatches } from './tmsDirectory'
import type { CustomerRecord } from '@/types/tms'

const c = (id: string, name: string, aliases: string[] = []): CustomerRecord => ({ id, name, aliases, createdAt: '', updatedAt: '' } as CustomerRecord)

describe('customerMatchKey (Ryne 2026-11-16, 20007 "R&R Transport, Inc.")', () => {
  it('treats & and "and" alike and drops Inc/LLC/Co and a leading "the"', () => {
    expect(customerMatchKey('R&R Transport, Inc.')).toBe(customerMatchKey('R and R Transport LLC'))
    expect(customerMatchKey('The Royal Group')).toBe(customerMatchKey('Royal Group'))
    expect(customerMatchKey('Acme Trucking Co.')).toBe(customerMatchKey('Acme Trucking Company'))
  })

  it('finds "R and R Transport" for the typed "R&R Transport, Inc." as an exact match, and matches merged aliases', () => {
    const list = [c('a', 'R and R Transport'), c('b', 'ICAT LOGISTICS, INC', ['ICAT LOGISTICS INC. - ORD']), c('z', 'Zeta Freight')]
    expect(findCustomerMatches('R&R Transport, Inc.', list)[0]).toMatchObject({ record: { id: 'a' }, score: 1 })
    expect(findCustomerMatches('ICAT Logistics Inc. - ORD', list)[0]).toMatchObject({ record: { id: 'b' }, score: 1 })
    expect(findCustomerMatches('Nothing Like It', list)).toEqual([])
  })
})

describe('customerMatchKey — "and" is not a shared word', () => {
  it('does not match "R&R Transport" to "C and W Transport" just because both have "and"', () => {
    const list = [{ id: 'cw', name: 'C AND W TRANSPORT', aliases: [], createdAt: '', updatedAt: '' } as unknown as CustomerRecord]
    expect((findCustomerMatches('R&R Transport, Inc.', list)[0]?.score ?? 0)).toBeLessThan(0.5)
  })
})
