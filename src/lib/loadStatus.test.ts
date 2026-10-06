/**
 * The derived load status is the grid's whole claim to being a source of truth, so the
 * rules that decide it are pinned here rather than left to the page.
 */
import { describe, it, expect } from 'vitest'
import { loadStatus, isOpenStatus, LOAD_STATUSES, LOAD_STATUS_BY_ID, type StatusLoadLike } from './loadStatus'
import { fromDateInput, fromDateTimeInput } from './date'
import type { Stop } from '../types'

const stop = (over: Partial<Stop> = {}): Stop => ({
  id: 's', type: 'pickup', appt: fromDateTimeInput('2026-10-09T08:00'), apptType: 'exact',
  driverId: 'd1', sequence: 0, ...over,
} as Stop)

const load = (stops: Stop[], over: Partial<StatusLoadLike> = {}): StatusLoadLike => ({
  id: 'l1', readyToInvoice: false, stops, ...over,
})

const booked = (over: Partial<Stop> = {}) => stop(over)
const pair = (p: Partial<Stop> = {}, d: Partial<Stop> = {}) =>
  [booked({ id: 'p', type: 'pickup', sequence: 0, ...p }),
   booked({ id: 'd', type: 'delivery', sequence: 1, ...d })]

describe('loadStatus — the lifecycle', () => {
  it('is Unassigned when nobody is on it', () => {
    expect(loadStatus(load(pair({ driverId: null }, { driverId: null })))).toBe('unassigned')
  })

  it('is Needs appt when a driver is on it but a stop has no booked time', () => {
    expect(loadStatus(load(pair({}, { apptType: 'tbd', appt: fromDateInput('2026-10-10') }))))
      .toBe('needs_appt')
  })

  it('is Planned once a driver is on it and every stop is booked', () => {
    expect(loadStatus(load(pair()))).toBe('planned')
  })

  it('is At pickup once the truck actually arrives', () => {
    expect(loadStatus(load(pair({ arrivedAt: '2026-10-09T13:00:00Z' })))).toBe('at_pickup')
  })

  it('is In transit once every pickup has been departed', () => {
    expect(loadStatus(load(pair({ arrivedAt: '2026-10-09T13:00:00Z', departedAt: '2026-10-09T14:00:00Z' }))))
      .toBe('in_transit')
  })

  it('is At delivery on arrival at the consignee', () => {
    expect(loadStatus(load(pair(
      { arrivedAt: '2026-10-09T13:00:00Z', departedAt: '2026-10-09T14:00:00Z' },
      { arrivedAt: '2026-10-10T09:00:00Z' },
    )))).toBe('at_delivery')
  })

  it('is Delivered — not POD in — when the POD is still missing', () => {
    const l = load(pair(
      { departedAt: '2026-10-09T14:00:00Z' },
      { arrivedAt: '2026-10-10T09:00:00Z', departedAt: '2026-10-10T10:00:00Z' },
    ))
    expect(loadStatus(l, false)).toBe('delivered')
  })

  it('is POD in once the paperwork is on file', () => {
    const l = load(pair(
      { departedAt: '2026-10-09T14:00:00Z' },
      { arrivedAt: '2026-10-10T09:00:00Z', departedAt: '2026-10-10T10:00:00Z' },
    ))
    expect(loadStatus(l, true)).toBe('pod_in')
  })

  it('reads an unknown POD as not-yet-arrived rather than claiming it is in', () => {
    // The index loads after the grid draws. Showing "POD in" on a guess would tell
    // somebody the paperwork is handled when nothing has said so.
    const l = load(pair(
      { departedAt: '2026-10-09T14:00:00Z' },
      { arrivedAt: '2026-10-10T09:00:00Z', departedAt: '2026-10-10T10:00:00Z' },
    ))
    expect(loadStatus(l, null)).toBe('delivered')
  })
})

describe('loadStatus — what outranks what', () => {
  it('lets a human marking it ready beat every derived state', () => {
    expect(loadStatus(load(pair({ driverId: null }, { driverId: null }), { readyToInvoice: true })))
      .toBe('ready')
  })

  it('keeps a load that is already rolling out of Unassigned', () => {
    // Clearing the driver off a truck that is carrying freight must not hide the trip.
    const l = load(pair(
      { driverId: null, arrivedAt: '2026-10-09T13:00:00Z', departedAt: '2026-10-09T14:00:00Z' },
      { driverId: null },
    ))
    expect(loadStatus(l)).toBe('in_transit')
  })

  it('does not advance on the clock — only on a real facility event', () => {
    // An appointment in the past is not an arrival. A late truck is still Planned.
    const past = pair(
      { appt: fromDateTimeInput('2020-01-01T08:00') },
      { appt: fromDateTimeInput('2020-01-02T08:00') },
    )
    expect(loadStatus(load(past))).toBe('planned')
  })

  it('needs EVERY pickup departed before it counts as in transit', () => {
    const multi = [
      booked({ id: 'p1', type: 'pickup', sequence: 0, departedAt: '2026-10-09T14:00:00Z' }),
      booked({ id: 'p2', type: 'pickup', sequence: 1 }),
      booked({ id: 'd', type: 'delivery', sequence: 2 }),
    ]
    expect(loadStatus(load(multi))).toBe('at_pickup')
  })
})

describe('the status table', () => {
  it('describes every status the derivation can return', () => {
    const ids = new Set(LOAD_STATUSES.map((s) => s.id))
    for (const id of ids) expect(LOAD_STATUS_BY_ID[id]).toBeDefined()
    expect(LOAD_STATUSES.length).toBe(ids.size)
  })

  it('counts everything except Ready as still needing someone', () => {
    expect(isOpenStatus('ready')).toBe(false)
    expect(isOpenStatus('pod_in')).toBe(true)
    expect(isOpenStatus('unassigned')).toBe(true)
  })

  it('gives every status a hint that says what to do next', () => {
    for (const s of LOAD_STATUSES) expect(s.hint.length).toBeGreaterThan(10)
  })
})
