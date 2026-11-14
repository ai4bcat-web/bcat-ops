import { describe, it, expect } from 'vitest'
import { intakeFields, intakeRow } from './testFixtures'
import { groupByCustomer, groupByDivision, parseView, resolveGroup, rowInGroup, withDivisionColumn } from './intakeGroups'

const row = (id: string, divisionCode: string | null, customerId: string | null, customerName: string | null = null) =>
  intakeRow({ id, divisionCode, fields: intakeFields({ customerId, customerName }) })

describe('intakeGroups', () => {
  const rows = [row('1', 'LOG', 'c1', 'Acme'), row('2', 'BRK', 'c2', 'Beta'), row('3', 'BRK', 'c2', 'Beta'), row('4', null, null, 'typed'), row('5', 'OLD', 'c3', 'Cee')]
  const divisions = [{ code: 'BRK', name: 'Brokerage' }, { code: 'LOG', name: 'Logistics' }, { code: 'EMP', name: 'Empty' }]

  it('groups by division in the given order with zero-count divisions, and unknown/missing divisions as Unassigned', () => {
    expect(groupByDivision(rows, divisions).map((g) => [g.id, g.count])).toEqual([['BRK', 2], ['LOG', 1], ['EMP', 0], ['unassigned', 2]])
  })

  it('groups by customer most rows first, ties by name, unmatched last and only when present', () => {
    expect(groupByCustomer(rows).map((g) => [g.id, g.label, g.count])).toEqual([
      ['c2', 'Beta', 2], ['c1', 'Acme', 1], ['c3', 'Cee', 1], ['not-matched', 'Not matched', 1],
    ])
    expect(groupByCustomer(rows.slice(0, 3)).some((g) => g.id === 'not-matched')).toBe(false)
  })

  it('group counts partition the rows and rowInGroup agrees with them', () => {
    const codes = new Set(divisions.map((d) => d.code))
    for (const g of groupByDivision(rows, divisions)) expect(rows.filter((r) => rowInGroup(r, 'division', g.id, codes)).length).toBe(g.count)
    for (const g of groupByCustomer(rows)) expect(rows.filter((r) => rowInGroup(r, 'customer', g.id, codes)).length).toBe(g.count)
    expect(rows.filter((r) => rowInGroup(r, 'all', 'BRK', codes)).length).toBe(rows.length)
  })

  it('falls back to All for a stale or missing group, and to the All view for an unknown view', () => {
    const groups = groupByCustomer(rows)
    expect(resolveGroup(groups, 'c1')).toBe('c1')
    expect(resolveGroup(groups, 'gone')).toBe('all')
    expect(resolveGroup(groups, null)).toBe('all')
    expect(parseView('bogus')).toBe('all')
    expect(parseView('customer')).toBe('customer')
  })
})

describe('withDivisionColumn', () => {
  it('adds Rev division once, right after Customer, and keeps the rest of a saved layout', () => {
    expect(withDivisionColumn(['received', 'from', 'customer', 'reference', 'source'])).toEqual(['received', 'from', 'customer', 'division', 'reference', 'source'])
    expect(withDivisionColumn(['received', 'customer', 'division'])).toEqual(['received', 'customer', 'division'])
    expect(withDivisionColumn(['received', 'from'])).toEqual(['received', 'from', 'division'])
  })
})
