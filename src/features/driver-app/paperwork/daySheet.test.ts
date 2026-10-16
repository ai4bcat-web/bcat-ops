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

describe('a load keeps its pickup before its delivery', () => {
  it('does not let an earlier delivery window sort ahead of the pickup that feeds it', () => {
    // 14712: delivery window opens 08:00, pickup is 09:00–11:00. The pickup still comes first.
    const items = stopsForDay([
      load('14712', [stop('pu', 'pickup', '2026-10-16', '2026-10-16T14:00:00Z', 0), stop('de', 'delivery', '2026-10-16', '2026-10-16T13:00:00Z', 1)]),
      load('14705', [stop('pu2', 'pickup', '2026-10-16', '2026-10-16T11:30:00Z', 0), stop('de2', 'delivery', '2026-10-16', '2026-10-16T16:00:00Z', 1)]),
    ], '2026-10-16')
    expect(items.map((i) => `${i.load.id}:${i.stop.id}`)).toEqual(['14705:pu2', '14705:de2', '14712:pu', '14712:de'])
  })
})

describe('untimed stops', () => {
  it('lists a first-come-first-served stop after the timed appointments of the day', async () => {
    const { stopsForDay } = await import('./daySheet')
    const mk = (id: string, appt: string, apptType?: string) => ({ id, reference: id, stops: [{ id: `${id}-d`, type: 'delivery', date: '2026-10-13', yours: true, appt, apptType, sequence: 1, name: id }] }) as unknown as import('../driverApi').PaperworkLoad
    const amazon = mk('amazon', '2026-10-13T12:00:00.000Z')
    const carlyn = mk('carlyn', '2026-10-13T05:00:00.000Z', 'fcfs')
    expect(stopsForDay([carlyn, amazon], '2026-10-13').map((x) => x.load.reference)).toEqual(['amazon', 'carlyn'])
  })
})

describe('the schedule order', () => {
  it("follows the dispatcher's calendar order before appointment times", async () => {
    const { stopsForDay } = await import('./daySheet')
    const mk = (id: string, appt: string, sortOrder: number | null) => ({ id, reference: id, sortOrder, stops: [{ id: `${id}-d`, type: 'delivery', date: '2026-10-13', yours: true, appt, sequence: 1, name: id }] }) as unknown as import('../driverApi').PaperworkLoad
    const second = mk('second', '2026-10-13T12:00:00.000Z', 2)
    const first = mk('first', '2026-10-13T16:00:00.000Z', 1)
    const unordered = mk('unordered', '2026-10-13T11:00:00.000Z', null)
    expect(stopsForDay([unordered, second, first], '2026-10-13').map((x) => x.load.reference)).toEqual(['first', 'second', 'unordered'])
  })
})
