import { describe, expect, it } from 'vitest'
import { deliveryPhase, deliveryPhaseText, type PhaseInput, type PhaseStop } from './deliveryPhase'

const NOW = Date.parse('2026-11-05T15:00:00.000Z')
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString()
const pu = (over: Partial<PhaseStop> = {}): PhaseStop => ({ type: 'pickup', appt: iso(-180), apptType: 'exact', ...over })
const de = (over: Partial<PhaseStop> = {}): PhaseStop => ({ type: 'delivery', appt: iso(600), apptType: 'exact', ...over })
const run = (over: Partial<PhaseInput> = {}) => deliveryPhase({ covered: true, stops: [pu(), de()], nowMs: NOW, ...over })

describe('deliveryPhase: parked states', () => {
  it('create is Draft with every checkpoint grey and the truck parked left', () => {
    const r = run({ create: true, covered: false, stops: [] })
    expect(r).toMatchObject({ phase: 'DRAFT', caption: 'Draft', tone: 'grey', reachedCount: 0, truckAt: 0, summary: 'Draft' })
  })
  it('not covered and covered-but-not-dispatched both read "Not dispatched"', () => {
    expect(run({ covered: false, status: 'OPEN' })).toMatchObject({ phase: 'NOT_COVERED', caption: 'Not dispatched', tone: 'grey', reachedCount: 0 })
    expect(run({ status: 'BOOKED' })).toMatchObject({ phase: 'NOT_DISPATCHED', caption: 'Not dispatched', tone: 'grey' })
  })
  it('voided is red and nothing else', () => {
    expect(run({ voided: true, status: 'DELIVERED', deliveredAt: iso(-5) })).toMatchObject({ phase: 'VOIDED', tone: 'red', reachedCount: 0 })
  })
})

describe('deliveryPhase: stop events first', () => {
  it('on site at the pickup: the first checkpoint is reached', () => {
    const r = run({ stops: [pu({ appt: iso(-10), arrivedAt: iso(-20) }), de()] })
    expect(r).toMatchObject({ phase: 'AT_PICKUP', reachedCount: 1, truckAt: 0, tone: 'green', summary: 'On site (pickup)' })
    expect(r.checkpoints[0]).toMatchObject({ reached: true, at: iso(-20) })
  })
  it('just left the pickup is Departed; a newer fix or 15 minutes on the road is In transit', () => {
    const left = pu({ arrivedAt: iso(-90), departedAt: iso(-5) })
    expect(run({ stops: [left, de()] })).toMatchObject({ phase: 'DEPARTED', reachedCount: 2 })
    expect(run({ stops: [left, de()], lastFix: { at: iso(-2), place: 'Joliet, IL' } })).toMatchObject({ phase: 'IN_TRANSIT', reachedCount: 3, truckAt: 2 })
    expect(run({ stops: [pu({ arrivedAt: iso(-120), departedAt: iso(-60) }), de()] }).phase).toBe('IN_TRANSIT')
  })
  it('on site at the delivery, then delivered', () => {
    const base = pu({ arrivedAt: iso(-300), departedAt: iso(-240) })
    expect(run({ stops: [base, de({ arrivedAt: iso(-10) })] })).toMatchObject({ phase: 'AT_DELIVERY', reachedCount: 4, truckAt: 3 })
    const done = run({ stops: [base, de({ arrivedAt: iso(-60), departedAt: iso(-10) })] })
    expect(done).toMatchObject({ phase: 'DELIVERED', reachedCount: 5, truckAt: 4, tone: 'green' })
  })
  it('stop events beat the status', () => {
    expect(run({ status: 'IN_TRANSIT', stops: [pu({ arrivedAt: iso(-20) }), de()] }).phase).toBe('AT_PICKUP')
  })
})

describe('deliveryPhase: status fallback and delivered', () => {
  it('a load with no stop stamps follows the shipment status', () => {
    const phases = (status: PhaseInput['status']) => run({ status }).phase
    expect(phases('DISPATCHED')).toBe('EN_ROUTE_PICKUP')
    expect(phases('LOADING')).toBe('AT_PICKUP')
    expect(phases('IN_TRANSIT')).toBe('IN_TRANSIT')
    expect(phases('UNLOADING')).toBe('AT_DELIVERY')
  })
  it('delivered status or deliveredAt wins over everything, with the delivered stamp on the last checkpoint', () => {
    const r = run({ status: 'DELIVERED', deliveredAt: iso(-30), stops: [pu(), de()] })
    expect(r).toMatchObject({ phase: 'DELIVERED', reachedCount: 5 })
    expect(r.checkpoints[4]).toMatchObject({ reached: true, at: iso(-30) })
    expect(run({ deliveredAt: iso(-30) }).phase).toBe('DELIVERED')
  })
})

describe('deliveryPhase: multi-stop', () => {
  const stops = [
    pu({ arrivedAt: iso(-400), departedAt: iso(-380) }),
    pu({ arrivedAt: iso(-300), departedAt: iso(-280) }),
    de({ arrivedAt: iso(-10) }),
    de(),
  ]
  it('the current stop is the first one the truck has not left, with a "Stop n of m" caption and summary', () => {
    const r = run({ stops })
    expect(r).toMatchObject({ phase: 'AT_DELIVERY', stopIndex: 2, stopCount: 4, caption: 'Stop 3 of 4', summary: 'On site (delivery), stop 3 of 4' })
    expect(deliveryPhaseText(r)).toBe('On site (delivery) · Stop 3/4')
  })
  it('after the first pickup departs, the truck is heading to stop 2', () => {
    const r = run({ stops: [pu({ arrivedAt: iso(-100), departedAt: iso(-60) }), pu(), de(), de()] })
    expect(r).toMatchObject({ phase: 'IN_TRANSIT', stopIndex: 1, caption: 'Stop 2 of 4', summary: 'In transit, stop 2 of 4' })
  })
  it('delivered shows no stop caption', () => {
    expect(run({ status: 'DELIVERED', stops }).caption).toBe('')
  })
})

describe('deliveryPhase: late and exception', () => {
  it('amber with the reason when the truck is not on site past the pickup appointment', () => {
    const r = run({ stops: [pu({ appt: iso(-120) }), de()], status: 'DISPATCHED' })
    expect(r).toMatchObject({ phase: 'EN_ROUTE_PICKUP', tone: 'amber', late: true })
    expect(r.reason).toMatch(/Past the pickup appointment/)
  })
  it('arrived after the window (beyond the grace) is late; inside the grace is not', () => {
    expect(run({ stops: [pu({ appt: iso(-60), arrivedAt: iso(-30) }), de()] }).late).toBe(true)
    expect(run({ stops: [pu({ appt: iso(-60), arrivedAt: iso(-50) }), de()] }).late).toBe(false)
  })
  it('an ETA past the delivery window is amber; a range appointment uses its end; FCFS has no window', () => {
    const left = pu({ arrivedAt: iso(-200), departedAt: iso(-100) })
    expect(run({ stops: [left, de({ appt: iso(60), etaAt: iso(200) })] })).toMatchObject({ tone: 'amber', reason: 'ETA is after the delivery appointment' })
    expect(run({ stops: [left, de({ appt: iso(60), apptEnd: iso(300), apptType: 'range', etaAt: iso(200) })] }).late).toBe(false)
    expect(run({ stops: [left, de({ appt: iso(-500), apptType: 'fcfs' })] }).late).toBe(false)
  })
  it('tracking\'s own ETA lateness and an open incident turn the truck amber; the incident wins the reason', () => {
    const left = pu({ arrivedAt: iso(-200), departedAt: iso(-100) })
    expect(run({ stops: [left, de()], etaLateMinutes: 45 }).reason).toBe('ETA is 45 min past the appointment')
    expect(run({ stops: [left, de()], openIncidents: 2, etaLateMinutes: 45 })).toMatchObject({ tone: 'amber', reason: 'Open exception (2)' })
  })
  it('a delivered load is never late', () => {
    expect(run({ status: 'DELIVERED', stops: [pu({ appt: iso(-900) }), de({ appt: iso(-800) })] }).tone).toBe('green')
  })
})

describe('deliveryPhaseText', () => {
  it('is compact for the board', () => {
    expect(deliveryPhaseText(run({ status: 'IN_TRANSIT' }))).toBe('In transit') // status alone cannot name the stop
    expect(deliveryPhaseText(run({ stops: [pu({ arrivedAt: iso(-100), departedAt: iso(-60) }), de(), de()] }))).toBe('In transit · Stop 2/3')
    expect(deliveryPhaseText(run({ stops: [pu({ arrivedAt: iso(-100), departedAt: iso(-60) }), de()] }))).toBe('In transit')
    expect(deliveryPhaseText(run({ covered: false }))).toBe('Not dispatched')
    expect(deliveryPhaseText(run({ create: true }))).toBe('Draft')
  })
})

describe('deliveryPhase: legs-aware with several carriers (Step AT)', () => {
  const left = { arrivedAt: iso(-300), departedAt: iso(-240) }
  const stops = [pu({ id: 's1', ...left }), pu({ id: 's2' }), de({ id: 's3' })]

  it('one carrier, with or without legs, is exactly the whole-route answer', () => {
    const plain = run({ stops })
    expect(run({ stops, carriers: [{ name: 'Swift', legStopIds: ['s1'] }] })).toEqual(plain)
    expect(run({ stops, carriers: [] })).toEqual(plain)
  })

  it('a stop no carrier covers cannot hold the shipment back', () => {
    const whole = run({ stops })
    expect(whole).toMatchObject({ stopIndex: 1, stopCount: 3 })
    const split = run({ stops, carriers: [{ name: 'A', legStopIds: ['s1'] }, { name: 'B', legStopIds: ['s3'] }] })
    expect(split).toMatchObject({ stopIndex: 1, stopCount: 2, phase: 'IN_TRANSIT' })
  })

  it('lists each carrier\'s own progress; the shipment waits on the furthest-behind carrier', () => {
    const r = run({
      stops: [pu({ id: 's1', ...left }), de({ id: 's2' })],
      carriers: [{ name: 'A', legStopIds: ['s1'] }, { name: 'B', legStopIds: ['s2'] }],
    })
    expect(r.carrierPhases).toEqual([{ name: 'A', phase: 'DONE' }, { name: 'B', phase: 'NOT_STARTED' }])
    expect(r.phase).not.toBe('DELIVERED')
  })

  it('carriers with no legs both cover the whole route', () => {
    const r = run({ stops, carriers: [{ name: 'A' }, { name: 'B', legStopIds: [] }] })
    expect(r).toMatchObject({ stopIndex: 1, stopCount: 3 })
    expect(r.carrierPhases?.map((c) => c.phase)).toEqual(['IN_TRANSIT', 'IN_TRANSIT'])
  })
})
