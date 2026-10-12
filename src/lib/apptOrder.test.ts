import { describe, it, expect } from 'vitest'
import { apptSortKey, isUntimedAppt } from './apptOrder'

describe('appointment order', () => {
  it('puts an untimed (FCFS / midnight) stop after the timed stops of its day', () => {
    const amazon = { appt: '2026-10-13T12:00:00.000Z' }          // 7:00 AM Chicago
    const carlyn = { appt: '2026-10-13T05:00:00.000Z', apptType: 'fcfs' }   // midnight Chicago, FCFS
    const midnightOnly = { appt: '2026-10-13T05:00:00.000Z' }
    expect(isUntimedAppt(carlyn)).toBe(true)
    expect(isUntimedAppt(midnightOnly)).toBe(true)
    expect(isUntimedAppt(amazon)).toBe(false)
    const order = [carlyn, amazon, midnightOnly].sort((a, b) => apptSortKey(a).localeCompare(apptSortKey(b)))
    expect(order[0]).toBe(amazon)
  })
  it('keeps days in order and puts a missing appointment last', () => {
    const keys = [
      { appt: '2026-10-14T05:00:00.000Z', apptType: 'fcfs' },
      { appt: '2026-10-13T20:00:00.000Z' },
      { appt: null },
      { appt: '2026-10-13T05:00:00.000Z', apptType: 'fcfs' },
    ].map(apptSortKey)
    expect([...keys].sort()).toEqual([keys[1], keys[3], keys[0], keys[2]])
  })
})
