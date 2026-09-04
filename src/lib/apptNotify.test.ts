import { describe, it, expect } from 'vitest'
import { apptNotices } from './apptNotify'
import { fromDateInput, fromDateTimeInput } from './date'
import type { Stop } from '@/types'

const stop = (over: Partial<Stop> = {}): Stop => ({
  id: 's1', type: 'pickup', appt: fromDateInput('2026-08-20'),
  apptType: 'exact', driverId: null, sequence: 0, ...over,
})

describe('apptNotices — flagging NEED', () => {
  it('reports a stop that just became NEED', () => {
    const before = [stop()]
    const after = [stop({ apptType: 'tbd' })]
    expect(apptNotices(after, before)).toEqual([
      { kind: 'needed', stopId: 's1', stopKind: 'pickup', apptLabel: 'Aug 20, 2026 · NEED' },
    ])
  })

  it('stays quiet when a NEED stop is merely re-saved', () => {
    // Otherwise #appts-ivan becomes a commentary on every edit and people mute it.
    const s = [stop({ apptType: 'tbd' })]
    expect(apptNotices(s, s)).toEqual([])
  })

  it('fires from EVERY other status — exact-with-time, pending, FCFS, range', () => {
    const t = fromDateTimeInput('2026-08-20T09:30')
    const froms: Partial<Stop>[] = [
      { apptType: 'exact', appt: t },                       // booked
      { apptType: 'exact' },                                // pending (no time)
      { apptType: undefined },                              // legacy default
      { apptType: 'fcfs' },
      { apptType: 'range', appt: t, apptEnd: fromDateTimeInput('2026-08-20T12:00') },
    ]
    for (const was of froms) {
      const out = apptNotices([stop({ ...was, apptType: 'tbd' })], [stop(was)])
      expect(out.map((n) => n.kind)).toEqual(['needed'])
    }
  })

  it('still fires when a time is set alongside the NEED flag in the same save', () => {
    // Status + time are saved exactly as picked — a NEED with a requested time is NEED.
    const after = [stop({ apptType: 'tbd', appt: fromDateTimeInput('2026-08-20T09:30') })]
    expect(apptNotices(after, [stop()])).toEqual([
      { kind: 'needed', stopId: 's1', stopKind: 'pickup', apptLabel: 'Aug 20, 2026 · NEED 09:30' },
    ])
  })

  it('reports a brand-new stop authored as NEED', () => {
    expect(apptNotices([stop({ apptType: 'tbd' })], [])).toHaveLength(1)
  })

  it('says nothing about an ordinary new load', () => {
    // New loads default to Pending, not NEED, so normal load entry is silent.
    expect(apptNotices([stop()], [])).toEqual([])
  })

  it('names the delivery end when it is the delivery that needs booking', () => {
    const [n] = apptNotices([stop({ type: 'delivery', apptType: 'tbd' })], [stop({ type: 'delivery' })])
    expect(n.stopKind).toBe('delivery')
  })
})

describe('apptNotices — updating the thread', () => {
  const asked = stop({ apptType: 'tbd', apptThreadTs: '1699999999.000100' })

  it('replies in the thread when the appointment time moves', () => {
    const after = [{ ...asked, apptType: 'exact' as const, appt: fromDateTimeInput('2026-08-20T09:30') }]
    expect(apptNotices(after, [asked])).toEqual([
      { kind: 'updated', stopId: 's1', stopKind: 'pickup',
        threadTs: '1699999999.000100', apptLabel: 'Aug 20, 2026 · 09:30' },
    ])
  })

  it('replies when the date changes, not just the time', () => {
    const after = [{ ...asked, appt: fromDateInput('2026-08-25') }]
    const [n] = apptNotices(after, [asked])
    expect(n.kind).toBe('updated')
    // The date is what makes the Slack reply readable — "NEED" alone says nothing.
    expect(n.apptLabel).toBe('Aug 25, 2026 · NEED')
  })

  it('replies when a window end moves', () => {
    const ranged = { ...asked, apptType: 'range' as const, appt: fromDateTimeInput('2026-08-20T08:00'), apptEnd: fromDateTimeInput('2026-08-20T12:00') }
    const after = [{ ...ranged, apptEnd: fromDateTimeInput('2026-08-20T15:00') }]
    expect(apptNotices(after, [ranged])[0].kind).toBe('updated')
  })

  it('says nothing when the save did not move the appointment', () => {
    const after = [{ ...asked, driverId: 'd1' }]   // driver assigned, appointment untouched
    expect(apptNotices(after, [asked])).toEqual([])
  })

  it('does NOT post an update for a stop nobody was asked about', () => {
    // No thread means no conversation to update; posting anyway turns the channel into a
    // feed of every appointment change.
    const plain = stop({ apptType: 'exact' })
    const after = [{ ...plain, appt: fromDateTimeInput('2026-08-20T09:30') }]
    expect(apptNotices(after, [plain])).toEqual([])
  })

  it('emits ONE notice when a stop becomes NEED, not both', () => {
    const was = stop({ apptType: 'exact', apptThreadTs: '1699999999.000100' })
    const after = [{ ...was, apptType: 'tbd' as const, appt: fromDateInput('2026-08-25') }]
    const notices = apptNotices(after, [was])
    expect(notices).toHaveLength(1)
    expect(notices[0].kind).toBe('needed')
  })
})

describe('apptNotices — NEED stop whose time changes', () => {
  const t1 = fromDateTimeInput('2026-08-20T09:30')
  const t2 = fromDateTimeInput('2026-08-20T13:00')

  it('replies in the thread when a NEED stop gets a different time', () => {
    const before = [stop({ apptType: 'tbd', appt: t1, apptThreadTs: '1.1' })]
    const after  = [stop({ apptType: 'tbd', appt: t2, apptThreadTs: '1.1' })]
    expect(apptNotices(after, before)).toEqual([
      { kind: 'updated', stopId: 's1', stopKind: 'pickup', threadTs: '1.1', apptLabel: 'Aug 20, 2026 · NEED 13:00' },
    ])
  })

  it('posts fresh when a NEED stop changes time and there is no thread yet', () => {
    const before = [stop({ apptType: 'tbd', appt: t1 })]
    const after  = [stop({ apptType: 'tbd', appt: t2 })]
    expect(apptNotices(after, before)).toEqual([
      { kind: 'needed', stopId: 's1', stopKind: 'pickup', apptLabel: 'Aug 20, 2026 · NEED 13:00' },
    ])
  })

  it('posts fresh when a NEED stop moves to another day', () => {
    const before = [stop({ apptType: 'tbd' })]
    const after  = [stop({ apptType: 'tbd', appt: fromDateInput('2026-08-21') })]
    expect(apptNotices(after, before).map((n) => n.kind)).toEqual(['needed'])
  })

  it('still stays quiet when a NEED stop is re-saved unchanged', () => {
    const s = [stop({ apptType: 'tbd', appt: t1 })]
    expect(apptNotices(s, s)).toEqual([])
  })

  it('a non-NEED stop without a thread still says nothing when its time moves', () => {
    const before = [stop({ appt: t1 })]
    const after  = [stop({ appt: t2 })]
    expect(apptNotices(after, before)).toEqual([])
  })
})

describe('apptNotices — several stops at once', () => {
  it('handles a multi-stop save independently per stop', () => {
    const before = [
      stop({ id: 'a', type: 'pickup' }),
      stop({ id: 'b', type: 'delivery', sequence: 1, apptType: 'tbd', apptThreadTs: 'TS-B' }),
      stop({ id: 'c', type: 'delivery', sequence: 2 }),
    ]
    const after = [
      { ...before[0], apptType: 'tbd' as const },                                     // → needed
      { ...before[1], apptType: 'exact' as const, appt: fromDateTimeInput('2026-08-21T10:00') }, // → updated
      before[2],                                                                       // → nothing
    ]
    expect(apptNotices(after, before).map((n) => [n.stopId, n.kind])).toEqual([
      ['a', 'needed'], ['b', 'updated'],
    ])
  })
})

describe('apptNotices — needs to be moved', () => {
  const t1 = fromDateTimeInput('2026-08-20T09:30')
  const t2 = fromDateTimeInput('2026-08-20T13:00')
  const booked = (over: Partial<Stop> = {}) => stop({ appt: t1, ...over })

  it('flagging a booked stop yields a move alert (new post without a thread)', () => {
    const out = apptNotices([booked({ apptMoveRequested: true })], [booked()])
    expect(out).toEqual([
      { kind: 'move', stopId: 's1', stopKind: 'pickup', threadTs: undefined, apptLabel: 'Aug 20, 2026 · 09:30' },
    ])
  })

  it('flagging replies in the existing thread when one exists', () => {
    const out = apptNotices(
      [booked({ apptMoveRequested: true, apptThreadTs: '1.1' })],
      [booked({ apptThreadTs: '1.1' })],
    )
    expect(out[0]).toMatchObject({ kind: 'move', threadTs: '1.1' })
  })

  it('re-saving a still-flagged stop stays quiet', () => {
    const s = [booked({ apptMoveRequested: true })]
    expect(apptNotices(s, s)).toEqual([])
  })

  it('changing the time on a flagged stop resolves it — moved, carrying the task id', () => {
    const out = apptNotices(
      [booked({ appt: t2, apptMoveRequested: true, apptMoveTaskId: 'task-9', apptThreadTs: '1.1' })],
      [booked({ apptMoveRequested: true, apptMoveTaskId: 'task-9', apptThreadTs: '1.1' })],
    )
    expect(out).toEqual([{
      kind: 'moved', stopId: 's1', stopKind: 'pickup', threadTs: '1.1',
      apptLabel: 'Aug 20, 2026 · 13:00', moveTaskId: 'task-9',
    }])
  })

  it('withdrawing the flag by hand also resolves it', () => {
    const out = apptNotices(
      [booked({ apptMoveRequested: false, apptMoveTaskId: null })],
      [booked({ apptMoveRequested: true, apptMoveTaskId: 'task-9' })],
    )
    expect(out.map((n) => n.kind)).toEqual(['moved'])
    expect(out[0].moveTaskId).toBe('task-9')
  })

  it('flagging NEED wins over move — an unbooked stop cannot be "moved"', () => {
    const out = apptNotices(
      [booked({ apptType: 'tbd', apptMoveRequested: true })],
      [booked()],
    )
    expect(out.map((n) => n.kind)).toEqual(['needed'])
  })
})
