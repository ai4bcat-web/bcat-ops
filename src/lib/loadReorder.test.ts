import { describe, it, expect } from 'vitest'
import { reorderedSortValues } from './loadReorder'

const L = (id: string, sortOrder: number | null) => ({ id, sortOrder })
const obj = (m: Map<string, number>) => Object.fromEntries(m)

describe('reorderedSortValues', () => {
  it("hands the loads' own values back in the new order, so other drivers' positions stay put", () => {
    // Day line: A=1, X(other driver)=2, B=3, Y=4, C=5. The driver puts C, A, B.
    expect(obj(reorderedSortValues([L('C', 5), L('A', 1), L('B', 3)]))).toEqual({ C: 1, A: 3, B: 5 })
  })
  it('keeps a load that did not move at its value', () => {
    expect(obj(reorderedSortValues([L('A', 1), L('B', 3), L('C', 5)]))).toEqual({ A: 1, B: 3, C: 5 })
  })
  it('gives a load with no value the next number above the set, and handles duplicates', () => {
    expect(obj(reorderedSortValues([L('N', null), L('A', 4), L('B', 2)]))).toEqual({ N: 2, A: 4, B: 5 })
    expect(obj(reorderedSortValues([L('A', 2), L('B', 2)]))).toEqual({ A: 2, B: 3 })
    expect(obj(reorderedSortValues([L('A', null), L('B', null)]))).toEqual({ A: 1, B: 2 })
  })
  it('works with fractional values', () => {
    expect(obj(reorderedSortValues([L('B', 2), L('A', 1.5)]))).toEqual({ B: 1.5, A: 2 })
  })
})
