import { describe, expect, it } from 'vitest'
import { authorityDigits, duplicateCustomerMessage, findDuplicateCustomer, parseDuplicateCustomerError } from './customerCreateDuplicates'

const existing = [
  { id: 'a', name: 'ADDISON TRANSPORTATION, INC.', mcNumber: '326834' },
  { id: 'b', name: 'Standard Express Inc', dotNumber: '0099' },
  { id: 'c', name: 'Gone', mcNumber: '111', mergedIntoId: 'a' },
  { id: 'd', name: 'Royal', aliases: ['The Royal Group'] },
]

describe('findDuplicateCustomer', () => {
  it('matches MC by digits only', () => {
    expect(findDuplicateCustomer({ mcNumber: 'MC-326834' }, existing)?.id).toBe('a')
  })
  it('matches DOT ignoring leading zeros', () => {
    expect(findDuplicateCustomer({ dotNumber: '99' }, existing)).toMatchObject({ id: 'b', reason: 'DOT' })
  })
  it('matches names regardless of case, punctuation and legal suffix', () => {
    expect(findDuplicateCustomer({ name: 'addison transportation' }, existing)).toMatchObject({ id: 'a', reason: 'NAME' })
    expect(findDuplicateCustomer({ name: 'Royal Group' }, existing)?.id).toBe('d')
  })
  it('ignores merged-away rows and the record being edited', () => {
    expect(findDuplicateCustomer({ mcNumber: '111' }, existing)).toBeNull()
    expect(findDuplicateCustomer({ mcNumber: '326834' }, existing, { excludeId: 'a' })).toBeNull()
  })
  it('returns null for a new company', () => {
    expect(findDuplicateCustomer({ name: 'New Co', mcNumber: '5' }, existing)).toBeNull()
    expect(authorityDigits('MC ')).toBeNull()
  })
})

describe('duplicate refusal text', () => {
  it('round-trips the id and name so the dialog can open the existing customer', () => {
    const msg = duplicateCustomerMessage({ id: 'cus-1', name: 'ADDISON TRANSPORTATION, INC.', mcNumber: '326834', reason: 'MC' })
    expect(parseDuplicateCustomerError(`GraphQL error: ${msg}`)).toEqual({
      id: 'cus-1',
      name: 'ADDISON TRANSPORTATION, INC.',
      text: 'This customer already exists: ADDISON TRANSPORTATION, INC. (MC 326834) — same MC number',
    })
    expect(parseDuplicateCustomerError('Something else')).toBeNull()
  })
})
