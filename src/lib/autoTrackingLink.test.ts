import { describe, expect, it } from 'vitest'
import { autoTrackingDecision, autoTrackingSendAt, maskPhone, trackingLinkStatusLabel } from './autoTrackingLink'

const leg = { status: 'ACTIVE', kind: 'CARRIER', trackingLinkId: null, trackingStartedAt: null }
// 2026-11-17 is CST (UTC-6): 14:00Z = 08:00 Chicago.
const timed = { status: 'BOOKED', pickupAppt: '2026-11-17T16:00:00.000Z', pickupApptType: 'exact' } // 10:00 CST
const dateOnly = { status: 'BOOKED', pickupAppt: '2026-11-17T06:00:00.000Z', pickupApptType: 'tbd' } // midnight CST

describe('autoTrackingSendAt', () => {
  it('is one hour before a timed appointment', () => {
    expect(autoTrackingSendAt(timed)).toBe('2026-11-17T15:00:00.000Z')
  })
  it('is 08:00 Chicago when there is no appointment time', () => {
    expect(autoTrackingSendAt(dateOnly)).toBe('2026-11-17T14:00:00.000Z')
    // A date stored at Chicago midnight with type exact still has no time.
    expect(autoTrackingSendAt({ pickupAppt: '2026-11-17T06:00:00.000Z', pickupApptType: 'exact' })).toBe('2026-11-17T14:00:00.000Z')
  })
  it('uses the window start for FCFS / range', () => {
    expect(autoTrackingSendAt({ pickupAppt: '2026-11-17T13:00:00.000Z', pickupApptType: 'fcfs' })).toBe('2026-11-17T12:00:00.000Z')
  })
  it('handles daylight time (CDT, UTC-5)', () => {
    expect(autoTrackingSendAt({ pickupAppt: '2026-07-01T05:00:00.000Z', pickupApptType: 'tbd' })).toBe('2026-07-01T13:00:00.000Z')
    // DST starts 2026-03-08: 08:00 CDT that day is 13:00Z.
    expect(autoTrackingSendAt({ pickupAppt: '2026-03-08T06:00:00.000Z', pickupApptType: 'tbd' })).toBe('2026-03-08T13:00:00.000Z')
  })
  it('is null without a pickup date', () => {
    expect(autoTrackingSendAt({ pickupAppt: null })).toBeNull()
  })
})

describe('autoTrackingDecision', () => {
  const at = (now: string, over: Partial<typeof leg> = {}, load: object = timed, hasPhone = true) =>
    autoTrackingDecision({ now, load, leg: { ...leg, ...over }, hasPhone })

  it('waits until an hour before, then sends', () => {
    expect(at('2026-11-17T14:59:00.000Z').kind).toBe('WAIT')
    expect(at('2026-11-17T15:00:00.000Z').kind).toBe('SEND')
    // Missed the exact minute: the next run that day still sends.
    expect(at('2026-11-17T15:40:00.000Z').kind).toBe('SEND')
  })
  it('sends at 8am with no appointment time', () => {
    expect(at('2026-11-17T13:55:00.000Z', {}, dateOnly).kind).toBe('WAIT')
    expect(at('2026-11-17T14:00:00.000Z', {}, dateOnly).kind).toBe('SEND')
  })
  it('waits for a pickup tomorrow and skips a past pickup day', () => {
    expect(at('2026-11-16T20:00:00.000Z').kind).toBe('WAIT')
    expect(at('2026-11-18T15:00:00.000Z')).toMatchObject({ kind: 'SKIP', reason: 'Pickup day has passed' })
  })
  it('never sends twice or over a tracker already reporting', () => {
    expect(at('2026-11-17T15:30:00.000Z', { trackingLinkId: 'tok' })).toMatchObject({ kind: 'SKIP', reason: 'Tracking link already sent' })
    expect(at('2026-11-17T15:30:00.000Z', { trackingStartedAt: '2026-11-16T12:00:00.000Z' }).kind).toBe('SKIP')
    expect(at('2026-11-17T15:30:00.000Z', {}, { ...timed, trackingProvider: 'MOTIVE' })).toMatchObject({ reason: 'Already tracking' })
    expect(at('2026-11-17T15:30:00.000Z', {}, { ...timed, trackingProvider: 'MANUAL' }).kind).toBe('SEND')
  })
  it('never sends after pickup, to an own truck, or without a phone', () => {
    expect(at('2026-11-17T15:30:00.000Z', {}, { ...timed, status: 'PICKED_UP' }).kind).toBe('SKIP')
    expect(at('2026-11-17T15:30:00.000Z', {}, { ...timed, pickupDepartedAt: '2026-11-17T15:10:00.000Z' }).kind).toBe('SKIP')
    expect(at('2026-11-17T15:30:00.000Z', { kind: 'OWN_ASSET' }).kind).toBe('SKIP')
    expect(at('2026-11-17T15:30:00.000Z', {}, timed, false)).toMatchObject({ kind: 'SKIP', reason: 'No driver phone' })
  })
})

describe('labels', () => {
  const base = { now: '2026-11-17T12:00:00.000Z', enabled: true, load: timed, hasPhone: true }
  it('says when it will send', () => {
    expect(trackingLinkStatusLabel({ ...base, leg })).toBe('Tracking link: auto-sends at 9:00 AM')
    expect(trackingLinkStatusLabel({ ...base, enabled: false, leg })).toBeNull()
  })
  it('tells manual from automatic', () => {
    expect(trackingLinkStatusLabel({ ...base, leg: { ...leg, trackingStartedAt: '2026-11-17T16:02:00.000Z' } }))
      .toBe('Tracking link: sent manually 10:02 AM')
    expect(trackingLinkStatusLabel({ ...base, leg: { ...leg, trackingStartedAt: '2026-11-17T15:00:05.000Z', autoTrackingClaimAt: '2026-11-17T15:00:01.000Z' } }))
      .toBe('Tracking link: sent automatically 9:00 AM')
  })
  it('masks phones', () => {
    expect(maskPhone('+13125551267')).toBe('(312) ***-**67')
    expect(maskPhone(null)).toBe('—')
  })
})
