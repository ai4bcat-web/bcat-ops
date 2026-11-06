import { describe, it, expect } from 'vitest'
import { stopsForDay, isDelivery, orderOpenStops } from './daySheet'
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

describe('orderOpenStops', () => {
  const at = (s: PaperworkStop, p: Partial<PaperworkStop>): PaperworkStop => ({ ...s, ...p })
  it('keeps only the stop the driver is on site at on top, whatever the calendar says', () => {
    // Calendar: next load's FCFS pickup (A) is slotted before the delivery (B) the driver is sitting at.
    const aPu = stop('a-pu', 'pickup', '2026-10-19', '2026-10-19T05:00:00Z')
    const bPu = at(stop('b-pu', 'pickup', '2026-10-19', '2026-10-19T13:00:00Z'), { departedAt: '2026-10-19T14:24:00Z', arrivedAt: '2026-10-19T13:26:00Z' })
    const bDe = at(stop('b-de', 'delivery', '2026-10-19', '2026-10-19T14:30:00Z', 1), { arrivedAt: '2026-10-19T16:37:00Z' })
    const all = [{ load: load('A', [aPu]), stop: aPu }, { load: load('B', [bPu, bDe]), stop: bPu }, { load: load('B', [bPu, bDe]), stop: bDe }]
    const open = all.filter((it) => !it.stop.departedAt)
    expect(orderOpenStops(open).map((it) => it.stop.id)).toEqual(['b-de', 'a-pu'])
  })
  it('does not lift a load with freight on board over the dispatcher order once the driver has left', () => {
    // B was picked up early, but dispatch ordered A first: A still leads until the driver is ON SITE somewhere.
    const aPu = stop('a-pu', 'pickup', '2026-10-19', '2026-10-19T05:00:00Z')
    const bPu = at(stop('b-pu', 'pickup', '2026-10-19', '2026-10-19T13:00:00Z'), { arrivedAt: '2026-10-19T13:00:00Z', departedAt: '2026-10-19T13:30:00Z' })
    const bDe = stop('b-de', 'delivery', '2026-10-19', '2026-10-19T15:00:00Z', 1)
    const cPu = stop('c-pu', 'pickup', '2026-10-19', '2026-10-19T16:00:00Z')
    const B = load('B', [bPu, bDe])
    const all = [{ load: load('A', [aPu]), stop: aPu }, { load: B, stop: bPu }, { load: B, stop: bDe }, { load: load('C', [cPu]), stop: cPu }]
    const open = all.filter((it) => !it.stop.departedAt)
    expect(orderOpenStops(open).map((it) => it.stop.id)).toEqual(['a-pu', 'b-de', 'c-pu'])
  })
})

describe('the schedule order is numeric', () => {
  const mk = (id: string, sortOrder: number | null, appt = '2026-10-13T12:00:00.000Z') =>
    ({ id, reference: id, sortOrder, stops: [{ id: `${id}-d`, type: 'delivery', date: '2026-10-13', yours: true, appt, sequence: 1, name: id }] }) as unknown as PaperworkLoad
  it('puts 1.5 between 1 and 2, 10 after 9, and a negative first', () => {
    const loads = [mk('ten', 10), mk('one-half', 1.5), mk('two', 2), mk('nine', 9), mk('one', 1), mk('neg', -1)]
    expect(stopsForDay(loads, '2026-10-13').map((x) => x.load.reference)).toEqual(['neg', 'one', 'one-half', 'two', 'nine', 'ten'])
  })
  it('puts loads with no order after every ordered one, by appointment', () => {
    const loads = [mk('late-null', null, '2026-10-13T18:00:00.000Z'), mk('early-null', null, '2026-10-13T08:00:00.000Z'), mk('ordered', 99, '2026-10-13T23:00:00.000Z')]
    expect(stopsForDay(loads, '2026-10-13').map((x) => x.load.reference)).toEqual(['ordered', 'early-null', 'late-null'])
  })
})
