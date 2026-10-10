import { describe, it, expect } from 'vitest'
import { smsSegments, messageCost, weekKeyOf, costReport, estimateMonthly, TWILIO_RATES } from './dispatchCosts'
import type { DispatchMessage } from './dispatch'

describe('segments', () => {
  it('counts GSM-7 and UCS-2 segments', () => {
    expect(smsSegments('Running 20 late')).toBe(1)
    expect(smsSegments('a'.repeat(160))).toBe(1)
    expect(smsSegments('a'.repeat(161))).toBe(2)
    expect(smsSegments('a'.repeat(306))).toBe(2)
    expect(smsSegments('a'.repeat(307))).toBe(3)
    expect(smsSegments('👍 on my way')).toBe(1)
    expect(smsSegments('👍'.repeat(71))).toBe(2)
    expect(smsSegments('')).toBe(1)
  })
})

describe('messageCost', () => {
  const r = TWILIO_RATES
  it('prices texts, pictures, calls and voicemails; notes and status are free', () => {
    expect(messageCost({ kind: 'SMS', direction: 'OUT', body: 'hi' })).toBeCloseTo(r.smsOutPerSegment + r.carrierSms, 6)
    expect(messageCost({ kind: 'SMS', direction: 'IN', body: 'a'.repeat(200) })).toBeCloseTo(2 * (r.smsInPerSegment + r.carrierSms), 6)
    expect(messageCost({ kind: 'MMS', direction: 'OUT', media: [{ key: 'a', contentType: 'image/jpeg' }, { key: 'b', contentType: 'image/jpeg' }] })).toBeCloseTo(2 * (r.mmsOut + r.carrierMms), 6)
    expect(messageCost({ kind: 'SMS', direction: 'OUT', body: 'x', status: 'failed' })).toBe(0)
    expect(messageCost({ kind: 'CALL', direction: 'IN', status: 'answered', callDurationSec: 90 })).toBeCloseTo(2 * (r.voiceInPerMin + r.voiceOutPerMin), 6)
    expect(messageCost({ kind: 'CALL', direction: 'IN', status: 'missed' })).toBe(0)
    expect(messageCost({ kind: 'VOICEMAIL', direction: 'IN', callDurationSec: 30 })).toBeCloseTo(r.voiceInPerMin + r.transcribePerMin, 6)
    expect(messageCost({ kind: 'NOTE', direction: 'OUT', body: 'x' })).toBe(0)
    expect(messageCost({ kind: 'STATUS', direction: 'IN', body: 'x' })).toBe(0)
  })
})

describe('report', () => {
  it('keys weeks from Sunday in Chicago', () => {
    expect(weekKeyOf('2026-10-10T17:00:00Z')).toBe('2026-10-04')   // Saturday → that Sunday
    expect(weekKeyOf('2026-10-11T04:30:00Z')).toBe('2026-10-04')   // Saturday 23:30 Chicago (CDT)
    expect(weekKeyOf('2026-10-11T05:30:00Z')).toBe('2026-10-11')   // Sunday 00:30 Chicago
  })
  it('rolls messages up per driver per week with totals', () => {
    const now = new Date('2026-10-10T17:00:00Z')
    const m = (id: string, conv: string, at: string, over: Partial<DispatchMessage> = {}): DispatchMessage => ({ id, conversationId: conv, phone: '+1', direction: 'OUT', kind: 'SMS', body: 'hi', at, ...over })
    const rep = costReport(
      [{ id: 'c1', phone: '+18475550100', driverName: 'Jason Smith' }, { id: 'c2', phone: '+17735550199' }],
      [m('1', 'c1', '2026-10-09T12:00:00Z'), m('2', 'c1', '2026-10-01T12:00:00Z', { direction: 'IN' }), m('3', 'c2', '2026-10-09T12:00:00Z', { kind: 'NOTE' }), m('4', 'c1', '2025-01-01T12:00:00Z')],
      now, 4,
    )
    expect(rep.weeks).toEqual(['2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04'])
    expect(rep.drivers[0].name).toBe('Jason Smith')
    expect(rep.drivers[0].messages).toBe(2)
    expect(rep.drivers[0].weeks['2026-10-04'].messages).toBe(1)
    expect(rep.drivers[0].weeks['2026-09-27'].messages).toBe(1)
    expect(rep.drivers[1].name).toBe('+17735550199')
    expect(rep.drivers[1].total).toBe(0)
    expect(rep.grandTotal).toBeCloseTo(2 * (TWILIO_RATES.smsOutPerSegment + TWILIO_RATES.carrierSms), 6)
  })
  it('estimates a monthly figure', () => {
    const e = estimateMonthly(10, 75)
    expect(e.messaging).toBeGreaterThan(30)
    expect(e.messaging).toBeLessThan(60)
    expect(e.total).toBeCloseTo(e.messaging + 1.15, 6)
  })
})
