import { describe, it, expect } from 'vitest'

import {
  CHANNEL_DISABLED_REASON,
  DEFAULT_CHECK_CALL_PLAN,
  checkCallSmsBody,
  isChannelEnabled,
  milestoneForStatus,
  nextCheckCallAction,
  normalizeCheckCallPlan,
} from './checkCallPlan'

const NOW = '2026-11-02T18:00:00.000Z'
const plan = { ...DEFAULT_CHECK_CALL_PLAN }

describe('the deferred voice leg', () => {
  it('is a declared channel that is never enabled', () => {
    expect(isChannelEnabled('SMS')).toBe(true)
    expect(isChannelEnabled('EMAIL')).toBe(true)
    expect(isChannelEnabled('VOICE')).toBe(false)
    expect(CHANNEL_DISABLED_REASON.VOICE).toBe('voice is not switched on yet')
  })

  it('is stored on a plan and still never used by a tick', () => {
    const stored = normalizeCheckCallPlan({ ...plan, channels: ['SMS', 'VOICE'] })
    expect(stored?.channels).toEqual(['SMS', 'VOICE'])
    const tick = nextCheckCallAction({ plan: stored!, status: 'IN_TRANSIT', lastCheckCallAt: '2026-11-02T10:00:00Z', now: NOW })
    expect(tick.channels).toEqual(['SMS'])
  })

  it('goes quiet rather than pretending when voice is the only channel', () => {
    const voiceOnly = normalizeCheckCallPlan({ ...plan, channels: ['VOICE'] })!
    const tick = nextCheckCallAction({ plan: voiceOnly, status: 'IN_TRANSIT', now: NOW })
    expect(tick.kind).toBe('NONE')
    expect(tick.reason).toMatch(/no channel that is switched on/)
  })
})

describe('reading a stored plan', () => {
  it('answers null for a record that has nothing stored, so the caller falls through', () => {
    expect(normalizeCheckCallPlan(null)).toBeNull()
    expect(normalizeCheckCallPlan('every 4 hours')).toBeNull()
    expect(normalizeCheckCallPlan([])).toBeNull()
  })

  it('refuses a cadence outside 1..24 h and an escalation outside 5..1440 min', () => {
    const p = normalizeCheckCallPlan({ intervalHours: 400, escalateAfterMinutes: 1 })!
    expect(p.intervalHours).toBe(4)
    expect(p.escalateAfterMinutes).toBe(30)
  })

  it('drops a milestone this build does not know', () => {
    expect(normalizeCheckCallPlan({ milestones: ['AT_PICKUP', 'MOON_LANDING'] })!.milestones).toEqual(['AT_PICKUP'])
  })
})

describe('the ladder', () => {
  it('is quiet before the load moves', () => {
    expect(nextCheckCallAction({ plan, status: 'OPEN', now: NOW }).kind).toBe('NONE')
  })

  it('sends the milestone message once, then stops repeating it', () => {
    const first = nextCheckCallAction({ plan, status: 'LOADING', now: NOW })
    expect(first).toMatchObject({ kind: 'MILESTONE', milestone: 'AT_PICKUP' })
    const second = nextCheckCallAction({ plan, status: 'LOADING', milestonesSent: ['AT_PICKUP'], lastCheckCallAt: NOW, now: NOW })
    expect(second.kind).toBe('NONE')
  })

  it('comes round again every four hours in transit and not before', () => {
    const early = nextCheckCallAction({
      plan, status: 'IN_TRANSIT', milestonesSent: ['IN_TRANSIT'], lastCheckCallAt: '2026-11-02T16:00:00Z', now: NOW,
    })
    expect(early.kind).toBe('NONE')
    expect(early.nextDueAt).toBe('2026-11-02T20:00:00.000Z')

    const due = nextCheckCallAction({
      plan, status: 'IN_TRANSIT', milestonesSent: ['IN_TRANSIT'], lastCheckCallAt: '2026-11-02T13:00:00Z', now: NOW,
    })
    expect(due.kind).toBe('CADENCE')
  })

  it('emails the dispatcher after thirty minutes of silence', () => {
    const tick = nextCheckCallAction({
      plan,
      status: 'IN_TRANSIT',
      milestonesSent: ['IN_TRANSIT'],
      lastCheckCallAt: '2026-11-02T17:29:00Z',
      awaitingSince: '2026-11-02T17:29:00Z',
      now: NOW,
    })
    expect(tick.kind).toBe('ESCALATE_DISPATCHER')
    expect(tick.channels).toEqual(['EMAIL'])
    expect(tick.reason).toMatch(/No reply for 31 minutes/)
    expect(tick.nextDueAt).toBe('2026-11-02T18:30:00.000Z')
  })

  it('raises an exception after a second grace period', () => {
    const tick = nextCheckCallAction({
      plan,
      status: 'IN_TRANSIT',
      milestonesSent: ['IN_TRANSIT'],
      lastCheckCallAt: '2026-11-02T16:55:00Z',
      awaitingSince: '2026-11-02T16:55:00Z',
      escalatedAt: '2026-11-02T17:30:00Z',
      now: NOW,
    })
    expect(tick.kind).toBe('ESCALATE_EXCEPTION')
    expect(tick.channels).toEqual([])
    expect(tick.reason).toMatch(/tracking team notified/)
  })

  it('fires each rung once per silence', () => {
    const base = {
      plan, status: 'IN_TRANSIT', milestonesSent: ['IN_TRANSIT'],
      awaitingSince: '2026-11-02T17:00:00Z', lastCheckCallAt: '2026-11-02T17:00:00Z', now: NOW,
    }
    expect(nextCheckCallAction(base).kind).toBe('ESCALATE_DISPATCHER')
    expect(nextCheckCallAction({ ...base, escalatedAt: '2026-11-02T17:35:00Z' }).kind).not.toBe('ESCALATE_DISPATCHER')

    const forException = { ...base, escalatedAt: '2026-11-02T17:35:00Z' }
    expect(nextCheckCallAction(forException).kind).toBe('ESCALATE_EXCEPTION')
    expect(nextCheckCallAction({ ...forException, checkCallFlaggedAt: '2026-11-02T18:15:00Z' }).kind).not.toBe('ESCALATE_EXCEPTION')
  })

  it('escalates again once the driver has gone quiet on a new question', () => {
    const tick = nextCheckCallAction({
      plan, status: 'IN_TRANSIT', milestonesSent: ['IN_TRANSIT'],
      awaitingSince: '2026-11-02T17:20:00Z',
      escalatedAt: '2026-11-02T13:00:00Z',
      checkCallFlaggedAt: '2026-11-02T13:00:00Z',
      lastCheckCallAt: '2026-11-02T17:20:00Z',
      now: NOW,
    })
    expect(tick.kind).toBe('ESCALATE_DISPATCHER')
  })

  it('maps the statuses a milestone message belongs to', () => {
    expect(milestoneForStatus('DISPATCHED')).toBe('DISPATCHED')
    expect(milestoneForStatus('PICKED_UP')).toBe('DEPARTED_PICKUP')
    expect(milestoneForStatus('OUT_FOR_DELIVERY')).toBe('AT_DELIVERY')
    expect(milestoneForStatus('DELIVERED')).toBe('DELIVERED')
    expect(milestoneForStatus('BOOKED')).toBeNull()
  })
})

describe('what the driver actually reads', () => {
  it('carries the tracking link and asks the question the milestone implies', () => {
    const body = checkCallSmsBody({
      shipmentNumber: 'S000123', kind: 'MILESTONE', milestone: 'AT_PICKUP',
      trackingUrl: 'https://x/l/abc', originCity: 'Chicago', destinationCity: 'Dallas',
    })
    expect(body).toContain('S000123')
    expect(body).toContain('are you loaded?')
    expect(body).toContain('https://x/l/abc')
    expect(body).toContain('Chicago → Dallas')
  })

  it('says it is following up when it is the escalation', () => {
    const body = checkCallSmsBody({ shipmentNumber: 'S1', kind: 'ESCALATE_DISPATCHER', milestone: null, trackingUrl: null })
    expect(body).toContain('Following up on load S1')
    expect(body).not.toContain('http')
  })
})
