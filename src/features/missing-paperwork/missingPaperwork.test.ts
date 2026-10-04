import { describe, it, expect } from 'vitest'
import {
  daysBetween, deliveredWithoutPaperwork, loadHasPaperwork, unmatchedPaperwork,
} from './missingPaperwork'
import type { Driver, Load } from '@/types'

const ASOF = new Date('2026-10-04T12:00:00Z')

function load(over: Partial<Load> = {}): Load {
  return {
    id: 'l1', aljexId: '14538', customer: 'Wayfinder',
    deliveryAppt: '2026-10-01T15:00:00Z', deliveryDriverId: 'd1',
    originCity: 'Chicago, IL', destinationCity: 'Indianapolis, IN',
    ...over,
  } as Load
}
const drivers = [{ id: 'd1', name: 'Ivan Driver' } as Driver]
const none = { byLoadId: new Set<string>(), byPro: new Set<string>() }

describe('which loads are waiting on paperwork', () => {
  it('lists a load whose appointment has passed with no POD', () => {
    const rows = deliveredWithoutPaperwork({ loads: [load()], drivers, pods: none, asOf: ASOF, withinDays: null })
    expect(rows).toHaveLength(1)
    expect(rows[0].reference).toBe('14538')
    expect(rows[0].driverName).toBe('Ivan Driver')
    expect(rows[0].lane).toBe('Chicago, IL → Indianapolis, IN')
    expect(rows[0].ageDays).toBe(3)
  })

  it('leaves out a load that is not due yet', () => {
    // Nothing to chase: it has not delivered.
    const rows = deliveredWithoutPaperwork({
      loads: [load({ deliveryAppt: '2026-10-09T15:00:00Z' })],
      drivers, pods: none, asOf: ASOF, withinDays: null,
    })
    expect(rows).toEqual([])
  })

  it('leaves out today’s appointments, which may still be running', () => {
    const rows = deliveredWithoutPaperwork({
      loads: [load({ deliveryAppt: '2026-10-04T08:00:00Z' })],
      drivers, pods: none, asOf: ASOF, withinDays: null,
    })
    expect(rows).toEqual([])
  })

  it('leaves out a load whose POD is matched by load id', () => {
    const pods = { byLoadId: new Set(['l1']), byPro: new Set<string>() }
    expect(deliveredWithoutPaperwork({ loads: [load()], drivers, pods, asOf: ASOF, withinDays: null })).toEqual([])
  })

  it('leaves out a load whose POD is matched only by PRO', () => {
    // A texted POD assigned by reference, never linked by id, still counts.
    const pods = { byLoadId: new Set<string>(), byPro: new Set(['14538']) }
    expect(loadHasPaperwork(load(), pods)).toBe(true)
    expect(deliveredWithoutPaperwork({ loads: [load()], drivers, pods, asOf: ASOF, withinDays: null })).toEqual([])
  })

  it('puts the oldest first, because that is the one that has gone cold', () => {
    const rows = deliveredWithoutPaperwork({
      loads: [
        load({ id: 'new', aljexId: '1', deliveryAppt: '2026-10-03T15:00:00Z' }),
        load({ id: 'old', aljexId: '2', deliveryAppt: '2026-08-01T15:00:00Z' }),
        load({ id: 'mid', aljexId: '3', deliveryAppt: '2026-09-20T15:00:00Z' }),
      ],
      drivers, pods: none, asOf: ASOF, withinDays: null,
    })
    expect(rows.map((r) => r.load.id)).toEqual(['old', 'mid', 'new'])
  })

  it('honours the window, which is what keeps this a queue and not the load table', () => {
    /*
     * With coverage as thin as it is in this data, no window lists hundreds of rows. The
     * page defaults to a recent window for exactly this reason.
     */
    const loads = [
      load({ id: 'recent', aljexId: '1', deliveryAppt: '2026-10-01T15:00:00Z' }), // 3 days
      load({ id: 'ancient', aljexId: '2', deliveryAppt: '2026-06-01T15:00:00Z' }), // ~125
    ]
    const within = deliveredWithoutPaperwork({ loads, drivers, pods: none, asOf: ASOF, withinDays: 30 })
    expect(within.map((r) => r.load.id)).toEqual(['recent'])
    const all = deliveredWithoutPaperwork({ loads, drivers, pods: none, asOf: ASOF, withinDays: null })
    expect(all).toHaveLength(2)
  })

  it('skips a load with no delivery appointment at all', () => {
    // Nothing to measure against; it cannot be called overdue.
    const rows = deliveredWithoutPaperwork({
      loads: [load({ deliveryAppt: undefined })], drivers, pods: none, asOf: ASOF, withinDays: null,
    })
    expect(rows).toEqual([])
  })

  it('counts age in whole days', () => {
    expect(daysBetween('2026-10-01', ASOF)).toBe(3)
    expect(daysBetween('2026-10-04', ASOF)).toBe(0)
    expect(daysBetween('nonsense', ASOF)).toBe(0)
  })
})

describe('paperwork waiting for a load', () => {
  const loads = [load({ id: 'l1', aljexId: '14538' })]

  it('lists a texted POD nobody assigned', () => {
    const out = unmatchedPaperwork({
      jobsdone: [{ id: 'p1', loadId: null, referenceNumber: '', senderName: 'Chad', receivedAt: '2026-10-02T10:00:00Z' }],
      submissions: [], loads,
    })
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('JOBSDONE')
    expect(out[0].from).toBe('Chad')
    expect(out[0].reference).toBeNull()
    expect(out[0].suggestedLoadId).toBeNull()
  })

  it('suggests the load when the document carries a readable PRO', () => {
    // The point of showing both halves: this is one click from being filed.
    const out = unmatchedPaperwork({
      jobsdone: [{ id: 'p1', loadId: null, referenceNumber: 'PRO 14538', receivedAt: '2026-10-02T10:00:00Z' }],
      submissions: [], loads,
    })
    expect(out[0].suggestedLoadId).toBe('l1')
    expect(out[0].suggestedReference).toBe('14538')
  })

  it('ignores anything already assigned to a load', () => {
    const out = unmatchedPaperwork({
      jobsdone: [{ id: 'p1', loadId: 'l1', receivedAt: '2026-10-02T10:00:00Z' }],
      submissions: [{ id: 's1', loadId: 'l1', createdAt: '2026-10-02T10:00:00Z', docs: [{ kind: 'POD' }] }],
      loads,
    })
    expect(out).toEqual([])
  })

  it('ignores a submission that holds no POD', () => {
    // A delivered load is not waiting on a rate confirmation.
    const out = unmatchedPaperwork({
      jobsdone: [],
      submissions: [{ id: 's1', loadId: null, createdAt: '2026-10-02T10:00:00Z', docs: [{ kind: 'RATECON' }] }],
      loads,
    })
    expect(out).toEqual([])
  })

  it('distinguishes a driver’s own upload from a staff one', () => {
    const out = unmatchedPaperwork({
      jobsdone: [],
      submissions: [
        { id: 's1', loadId: null, source: 'STAFF', driverName: 'Ivan Driver', createdAt: '2026-10-03T10:00:00Z', docs: [{ kind: 'POD' }] },
        { id: 's2', loadId: null, source: null, driverName: 'Chad', createdAt: '2026-10-02T10:00:00Z', docs: [{ kind: 'POD' }] },
      ],
      loads,
    })
    expect(out.map((d) => d.source)).toEqual(['STAFF', 'DRIVER_PWA'])
  })

  it('puts the newest first, since that is what someone just sent', () => {
    const out = unmatchedPaperwork({
      jobsdone: [
        { id: 'old', loadId: null, receivedAt: '2026-09-01T10:00:00Z' },
        { id: 'new', loadId: null, receivedAt: '2026-10-03T10:00:00Z' },
      ],
      submissions: [], loads,
    })
    expect(out.map((d) => d.id)).toEqual(['new', 'old'])
  })
})
