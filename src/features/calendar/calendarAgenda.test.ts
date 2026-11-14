import { describe, it, expect } from 'vitest'
import { agendaForDay, agendaUnscheduled } from './calendarAgenda'
import type { Load } from '@/types'

const load = (over: Partial<Load>): Load => ({ id: 'x', aljexId: '1', tmsId: '', pickupDriverId: null, deliveryDriverId: null, ...over }) as Load

describe('agendaForDay', () => {
  // 15:00Z is 9-10am in Chicago, so these land on the date they say.
  const sameDay = load({ id: 'a', pickupAppt: '2026-11-14T16:00:00Z', deliveryAppt: '2026-11-14T20:00:00Z' })
  const early = load({ id: 'b', pickupAppt: '2026-11-14T14:00:00Z', deliveryAppt: '2026-11-14T18:00:00Z' })
  const multi = load({ id: 'c', pickupAppt: '2026-11-13T15:00:00Z', deliveryAppt: '2026-11-14T15:00:00Z' })

  it('lists a same-day load once, a multi-day load on each of its days, sorted by time', () => {
    const rows = agendaForDay([sameDay, early, multi], '2026-11-14')
    expect(rows.map((r) => r.key)).toEqual(['b:same-day', 'c:delivery', 'a:same-day'])
    expect(agendaForDay([multi], '2026-11-13').map((r) => r.role)).toEqual(['pickup'])
  })

  it('buckets by the Chicago date, not UTC', () => {
    // 03:00Z on the 15th is 9pm on the 14th in Chicago.
    const late = load({ id: 'd', pickupAppt: '2026-11-15T03:00:00Z' })
    expect(agendaForDay([late], '2026-11-14').map((r) => r.key)).toEqual(['d:same-day'])
  })

  it('keeps a saved drag order ahead of time order', () => {
    const rows = agendaForDay([load({ ...sameDay, sortOrder: 0 }), early], '2026-11-14')
    expect(rows.map((r) => r.load.id)).toEqual(['a', 'b'])
  })

  it('leaves voided and unscheduled loads off a day', () => {
    const voided = load({ id: 'v', pickupAppt: '2026-11-14T16:00:00Z', voidedAt: '2026-11-14T00:00:00Z' })
    const parked = load({ id: 'u', pickupAppt: '2026-11-14T16:00:00Z', unscheduled: true })
    expect(agendaForDay([voided, parked], '2026-11-14')).toEqual([])
  })
})

describe('agendaUnscheduled', () => {
  it('holds parked and undated loads, never canceled or voided freight', () => {
    const rows = agendaUnscheduled([
      load({ id: 'u', pickupAppt: '2026-11-14T16:00:00Z', unscheduled: true }),
      load({ id: 'n' }),
      load({ id: 'k', unscheduled: true, status: 'CANCELED' } as Partial<Load>),
      load({ id: 'v', voidedAt: '2026-11-14T00:00:00Z' }),
      load({ id: 'd', pickupAppt: '2026-11-14T16:00:00Z' }),
    ])
    expect(rows.map((r) => r.load.id)).toEqual(['u', 'n'])
  })
})
