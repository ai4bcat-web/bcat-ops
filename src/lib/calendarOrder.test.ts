import { describe, it, expect } from 'vitest'
import { groupRowsByDriver } from './calendarOrder'

describe('groupRowsByDriver', () => {
  type Row = { id: string; driver: string | null; slot: number | null }
  const run = (rows: Row[]) => groupRowsByDriver(rows, (r) => r.driver, (r) => r.slot)

  it("stacks a driver's loads together, in slot order, where their first row was", () => {
    const rows: Row[] = [
      { id: 'a-2', driver: 'a', slot: 2 },
      { id: 'b-1', driver: 'b', slot: 1 },
      { id: 'a-1', driver: 'a', slot: 1 },
      { id: 'none', driver: null, slot: null },
      { id: 'a-x', driver: 'a', slot: null },
    ]
    const { rows: out, firstByDriver } = run(rows)
    expect(out.map((r) => r.id)).toEqual(['a-1', 'a-2', 'a-x', 'b-1', 'none'])
    expect(firstByDriver.get('a')?.id).toBe('a-1')
    expect(firstByDriver.get('b')?.id).toBe('b-1')
  })

  it('leaves a day with no drivers exactly as it came', () => {
    const rows: Row[] = [{ id: '1', driver: null, slot: 3 }, { id: '2', driver: null, slot: 1 }]
    expect(run(rows).rows.map((r) => r.id)).toEqual(['1', '2'])
  })
})
