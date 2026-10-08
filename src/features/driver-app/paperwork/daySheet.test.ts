import { describe, it, expect } from 'vitest'
import { stopsForDay, isDelivery } from './daySheet'
import type { PaperworkLoad, PaperworkStop } from '../driverApi'

const stop = (id: string, type: string, date: string, appt: string, sequence = 0): PaperworkStop =>
  ({ id, type, sequence, name: id, city: null, state: null, appt, apptType: 'exact', apptEnd: null, date, detention: false, yours: true, arrivedAt: null, departedAt: null, etaAt: null, etaBasis: null })
const load = (id: string, stops: PaperworkStop[]) => ({ id, reference: id, stops } as unknown as PaperworkLoad)

describe('stopsForDay', () => {
  it('takes every stop dated today from every load, and nothing else', () => {
    const items = stopsForDay([
      load('A', [stop('a-pu', 'pickup', '2026-10-07', '2026-10-07T13:00:00Z'), stop('a-de', 'delivery', '2026-10-08', '2026-10-08T13:00:00Z', 1)]),
      load('B', [stop('b-pu', 'pickup', '2026-10-06', '2026-10-06T13:00:00Z'), stop('b-de', 'delivery', '2026-10-07', '2026-10-07T18:00:00Z', 1)]),
    ], '2026-10-07')
    expect(items.map((i) => `${i.load.id}:${i.stop.id}`)).toEqual(['A:a-pu', 'B:b-de'])
  })

  it('orders the day by appointment, then by stop sequence', () => {
    const items = stopsForDay([
      load('A', [stop('late', 'delivery', '2026-10-07', '2026-10-07T20:00:00Z', 1)]),
      load('B', [stop('early', 'pickup', '2026-10-07', '2026-10-07T12:00:00Z'), stop('early-2', 'delivery', '2026-10-07', '2026-10-07T12:00:00Z', 1)]),
    ], '2026-10-07')
    expect(items.map((i) => i.stop.id)).toEqual(['early', 'early-2', 'late'])
  })

  it("leaves out a stop that is another driver's, even on this driver's load", () => {
    const theirs = { ...stop('de', 'delivery', '2026-10-07', '2026-10-07T18:00:00Z', 1), yours: false }
    const items = stopsForDay([load('A', [stop('pu', 'pickup', '2026-10-07', '2026-10-07T13:00:00Z'), theirs])], '2026-10-07')
    expect(items.map((i) => i.stop.id)).toEqual(['pu'])
  })

  it('is empty on a day with nothing scheduled', () => {
    expect(stopsForDay([load('A', [stop('x', 'pickup', '2026-10-06', '2026-10-06T13:00:00Z')])], '2026-10-07')).toEqual([])
  })

  it('tells deliveries from pickups however the type is cased', () => {
    expect(isDelivery(stop('d', 'DELIVERY', '2026-10-07', ''))).toBe(true)
    expect(isDelivery(stop('p', 'pickup', '2026-10-07', ''))).toBe(false)
  })
})
