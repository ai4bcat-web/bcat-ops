import { describe, it, expect } from 'vitest'
import { proConflict } from './proConflict'

const loads = [
  { id: 'a', aljexId: '14578' },
  { id: 'b', aljexId: '14578' }, // the 7 Oct double-click twin
  { id: 'c', aljexId: '14579' },
]

describe('proConflict', () => {
  it('is quiet when the Pro # is unique', () => {
    expect(proConflict(loads, '14580', null)).toEqual({ kind: 'none' })
    expect(proConflict(loads, '14579', { id: 'c', aljexId: '14579' })).toEqual({ kind: 'none' })
  })

  it('refuses a NEW load that would reuse a Pro #', () => {
    expect(proConflict(loads, '14579', null)).toMatchObject({ kind: 'block', other: { id: 'c' } })
  })

  it('refuses CHANGING a load onto a Pro # another load holds', () => {
    expect(proConflict(loads, '14579', { id: 'a', aljexId: '14578' })).toMatchObject({ kind: 'block', other: { id: 'c' } })
  })

  it('lets a load that ALREADY shares its Pro # be edited, with a warning', () => {
    // Ruben moving the dates on 14578: the duplicate was there before his edit.
    expect(proConflict(loads, '14578', { id: 'a', aljexId: '14578' })).toMatchObject({ kind: 'warn', other: { id: 'b' } })
    expect(proConflict(loads, '14578', { id: 'b', aljexId: '14578' })).toMatchObject({ kind: 'warn', other: { id: 'a' } })
  })

  it('compares trimmed values and ignores a blank Pro #', () => {
    expect(proConflict(loads, ' 14579 ', null).kind).toBe('block')
    expect(proConflict(loads, '', null)).toEqual({ kind: 'none' })
    expect(proConflict(loads, null, null)).toEqual({ kind: 'none' })
  })
})
