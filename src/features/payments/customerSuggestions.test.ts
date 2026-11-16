import { describe, expect, it } from 'vitest'
import type { CustomerRecord } from '@/types/tms'
import { searchCustomers } from './customerSuggestions'

const c = (id: string, name: string, aliases: string[] = [], extra: Partial<CustomerRecord> = {}): CustomerRecord =>
  ({ id, name, aliases, createdAt: '', updatedAt: '', ...extra } as CustomerRecord)

const list = [
  c('a', 'ACME TRUCKING'),
  c('b', 'Batory Foods'),
  c('r', 'R and R Transport'),
  c('i', 'ICAT LOGISTICS, INC', ['ICAT LOGISTICS INC. - ORD']),
  c('d', 'Danisco US Inc.'),
  c('m', 'Old Merged Co', [], { mergedIntoId: 'a' } as Partial<CustomerRecord>),
]
const open = new Map([['b', 70_000], ['d', 1_000]])
const names = (q: string) => searchCustomers(q, list, open).map((s) => s.customer.id)

describe('searchCustomers', () => {
  it('lists the customers with money outstanding when nothing is typed', () => {
    expect(names('')).toEqual(['b', 'd'])
    expect(searchCustomers('', list, open)[0]).toMatchObject({ openCents: 70_000 })
  })

  it('finds a name by its start, then by a word inside it', () => {
    expect(names('bat')).toEqual(['b'])
    expect(names('foods')).toEqual(['b'])
    expect(names('acme')).toEqual(['a'])
  })

  it('treats & and "and" alike, and finds a merged alias', () => {
    expect(names('R&R Transport')[0]).toBe('r')
    expect(names('icat logistics inc - ord')[0]).toBe('i')
  })

  it('never offers a merged-away customer', () => {
    expect(names('old merged')).not.toContain('m')
  })

  it('puts a customer with open invoices before one without, within a rank', () => {
    const two = [c('x', 'Zed Freight'), c('y', 'Zed Logistics')]
    expect(searchCustomers('zed', two, new Map([['y', 5_00]])).map((s) => s.customer.id)).toEqual(['y', 'x'])
  })

  it('says nothing for a name nobody has', () => {
    expect(names('qqqqq')).toEqual([])
  })
})
