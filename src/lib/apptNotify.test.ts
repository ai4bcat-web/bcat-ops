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
