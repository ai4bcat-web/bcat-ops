import { describe, it, expect } from 'vitest'
import {
  buildPaperworkLoad,
  describeTimes,
  driverIsOnPaperworkLoad,
  referenceOf,
  summarize,
  worstLegibility,
  DETENTION_FREE_HOURS,
  type PaperworkLoadLike,
} from './paperwork'

const DRIVER = 'drv-1'

function load(over: Partial<PaperworkLoadLike> = {}): PaperworkLoadLike {
  return {
    id: 'load-1',
    aljexId: '14538',
    customer: 'Wayfinder Logistics',
    miles: 185,
    pickupAppt: '2026-10-05T13:00:00Z',
    deliveryAppt: '2026-10-06T15:00:00Z',
    deliveryDriverId: DRIVER,
    originCity: 'Chicago',
    originState: 'IL',
    destinationCity: 'Indianapolis',
    destinationState: 'IN',
    trailerNumber: 'TRL-42',
    commodity: 'Paper goods',
    weight: 41000,
    pieces: 22,
    notes: 'Dock 7',
    status: 'DELIVERED',
    ...over,
  }
}

describe('what the driver is shown', () => {
  it('carries every detail of the load', () => {
    const p = buildPaperworkLoad(load(), [], [])
    expect(p.reference).toBe('14538')
    expect(p.customer).toBe('Wayfinder Logistics')
    expect(p.origin).toBe('Chicago, IL')
    expect(p.destination).toBe('Indianapolis, IN')
    expect(p.miles).toBe(185)
    expect(p.trailerNumber).toBe('TRL-42')
    expect(p.commodity).toBe('Paper goods')
    expect(p.weight).toBe(41000)
    expect(p.pieces).toBe(22)
    expect(p.notes).toBe('Dock 7')
    expect(p.deliveryAppt).toBe('2026-10-06T15:00:00Z')
  })

  it('carries NO rate, and nothing a rate could be computed from', () => {
    /*
     * The point of the whole module. Ivan's drivers are not settled a percentage, and what
     * a load pays is not theirs to see — so the number must be absent from the payload,
     * not merely unrendered. A UI that forgets to hide a field is a bug; a payload that
     * never had it cannot leak.
     */
    const p = buildPaperworkLoad(
      load({ rate: 2400 } as Partial<PaperworkLoadLike>),
      [],
      [],
    )
    const serialized = JSON.stringify(p)
    expect(serialized).not.toContain('2400')
    expect(serialized).not.toMatch(/"rate"/)
    expect(serialized).not.toMatch(/amount|gross|deduction|checkAmount|payPercent/i)
  })
})

describe('POD status on the load list', () => {
  it('says a POD is missing when nothing has been sent', () => {
    const p = buildPaperworkLoad(load(), [], [])
    expect(p.pod.present).toBe(false)
    expect(p.pod.pages).toBe(0)
    expect(p.pod.legibility).toBe('UNKNOWN')
  })

  it('counts pages and reports a clean POD as OK', () => {
    const p = buildPaperworkLoad(load(), [
      { kind: 'POD', legibility: 'OK' },
      { kind: 'POD', legibility: 'OK' },
    ], [])
    expect(p.pod.present).toBe(true)
    expect(p.pod.pages).toBe(2)
    expect(p.pod.legibility).toBe('OK')
    expect(p.pod.notes).toBeNull()
  })

  it('flags the whole POD on its worst page, and passes the advice through', () => {
    // Three good photos do not rescue the one nobody can read.
    const p = buildPaperworkLoad(load(), [
      { kind: 'POD', legibility: 'OK' },
      { kind: 'POD', legibility: 'UNREADABLE', legibilityNotes: 'the photo is blurry — hold still and tap to focus' },
      { kind: 'POD', legibility: 'OK' },
    ], [])
    expect(p.pod.legibility).toBe('UNREADABLE')
    expect(p.pod.notes).toMatch(/blurry/)
  })

  it('ignores rate confirmations when judging the POD', () => {
    const p = buildPaperworkLoad(load(), [{ kind: 'RATECON', legibility: 'UNREADABLE' }], [])
    expect(p.pod.present).toBe(false)
    expect(p.pod.legibility).toBe('UNKNOWN')
  })

  it('worstLegibility ranks unreadable above low above unknown above ok', () => {
    expect(worstLegibility(['OK', 'LOW', 'UNREADABLE'])).toBe('UNREADABLE')
    expect(worstLegibility(['OK', 'LOW'])).toBe('LOW')
    expect(worstLegibility(['OK', 'UNKNOWN'])).toBe('UNKNOWN')
    expect(worstLegibility(['OK', 'OK'])).toBe('OK')
    expect(worstLegibility([])).toBe('UNKNOWN')
  })
})

describe('detention times the driver enters', () => {
  it('is empty until the driver fills it in', () => {
    const t = describeTimes(undefined)
    expect(t).toEqual({ timeIn: null, timeOut: null, notes: null, hours: null, billable: false })
  })

  it('computes the gap and calls it billable past the free hours', () => {
    const t = describeTimes({ loadId: 'l', driverId: DRIVER, leg: 'DELIVERY', timeIn: '2026-10-06T08:00', timeOut: '2026-10-06T11:30' })
    expect(t.hours).toBe(3.5)
    expect(t.billable).toBe(true)
  })

  it('does not call a short wait billable', () => {
    const t = describeTimes({ loadId: 'l', driverId: DRIVER, leg: 'DELIVERY', timeIn: '2026-10-06T08:00', timeOut: '2026-10-06T09:30' })
    expect(t.hours).toBe(1.5)
    expect(t.billable).toBe(false)
    expect(DETENTION_FREE_HOURS).toBe(2)
  })

  it('handles a wait that crosses midnight rather than reporting negative hours', () => {
    // A driver sitting at a dock from 22:00 to 01:00 waited three hours, not minus 21.
    const t = describeTimes({ loadId: 'l', driverId: DRIVER, leg: 'DELIVERY', timeIn: '2026-10-06T22:00', timeOut: '2026-10-06T01:00' })
    expect(t.hours).toBe(3)
    expect(t.billable).toBe(true)
  })

  it('keeps pickup and delivery waits apart', () => {
    const p = buildPaperworkLoad(load(), [], [
      { loadId: 'load-1', driverId: DRIVER, leg: 'PICKUP', timeIn: '2026-10-05T06:00', timeOut: '2026-10-05T09:15' },
      { loadId: 'load-1', driverId: DRIVER, leg: 'DELIVERY', timeIn: '2026-10-06T14:00', timeOut: '2026-10-06T14:30' },
    ])
    expect(p.pickupTimes.hours).toBe(3.25)
    expect(p.pickupTimes.billable).toBe(true)
    expect(p.deliveryTimes.hours).toBe(0.5)
    expect(p.deliveryTimes.billable).toBe(false)
  })

  it('keeps a recorded wait even when it is under the threshold', () => {
    // The driver's account of the clock is the record. Discarding the short ones would
    // throw away the evidence for the load somebody later disputes.
    const t = describeTimes({ loadId: 'l', driverId: DRIVER, leg: 'PICKUP', timeIn: '2026-10-05T10:00', timeOut: '2026-10-05T10:20', notes: 'waved straight in' })
    expect(t.timeIn).toBe('2026-10-05T10:00')
    expect(t.notes).toBe('waved straight in')
  })
})

describe('whose loads these are', () => {
  it('finds the driver on the legacy delivery field', () => {
    expect(driverIsOnPaperworkLoad(load(), DRIVER)).toBe(true)
    expect(driverIsOnPaperworkLoad(load(), 'someone-else')).toBe(false)
  })

  it('finds the driver on a stop, which is how Ivan loads are dispatched', () => {
    const multi = load({
      deliveryDriverId: null,
      pickupDriverId: null,
      stops: [
        { id: 's1', type: 'pickup', appt: '2026-10-05T13:00:00Z', driverId: 'other', sequence: 0 },
        { id: 's2', type: 'delivery', appt: '2026-10-06T15:00:00Z', driverId: DRIVER, sequence: 1 },
      ],
    })
    expect(driverIsOnPaperworkLoad(multi, DRIVER)).toBe(true)
  })

  it('falls back to the TMS id, then the row id, for the reference', () => {
    expect(referenceOf(load({ aljexId: null, tmsId: 'TMS-9' }))).toBe('TMS-9')
    expect(referenceOf(load({ aljexId: null, tmsId: null }))).toBe('load-1')
  })
})

describe('the week summary', () => {
  it('counts loads, missing PODs and illegible PODs', () => {
    const loads = [
      buildPaperworkLoad(load({ id: 'a' }), [{ kind: 'POD', legibility: 'OK' }], []),
      buildPaperworkLoad(load({ id: 'b' }), [], []),
      buildPaperworkLoad(load({ id: 'c' }), [{ kind: 'POD', legibility: 'UNREADABLE' }], []),
      buildPaperworkLoad(load({ id: 'd' }), [{ kind: 'POD', legibility: 'LOW' }], []),
    ]
    expect(summarize(loads)).toEqual({ loadCount: 4, podsMissing: 1, podsIllegible: 2, eldRequired: 4 })
  })

  it('does not count a missing POD as illegible as well', () => {
    const loads = [buildPaperworkLoad(load(), [], [])]
    expect(summarize(loads)).toEqual({ loadCount: 1, podsMissing: 1, podsIllegible: 0, eldRequired: 1 })
  })
})

describe('the ELD flag on a load', () => {
  it('requires logs on a run that leaves the 150 air-mile radius', () => {
    // The fixture runs Chicago -> Indianapolis, about 200 air miles out.
    const l = buildPaperworkLoad(load(), [], [])
    expect(l.eld.required).toBe(true)
    expect(l.eld.status).toBe('REQUIRED')
    expect(l.eld.label).toMatch(/ELD logs required/)
    expect(l.eld.label).toMatch(/Pleasant Prairie, WI/)
  })

  it('does not require logs on a local run', () => {
    const l = buildPaperworkLoad(
      load({ originCity: 'Kenosha', originState: 'WI', destinationCity: 'Waukegan', destinationState: 'IL', stops: [] }),
      [], [],
    )
    expect(l.eld.required).toBe(false)
    expect(l.eld.status).toBe('NOT_REQUIRED')
    expect(l.eld.label).toMatch(/No ELD logs required/)
  })

  it('ignores road miles, which would give the wrong answer', () => {
    /*
     * 400 routed miles but both ends well inside the circle. The rule is air miles, so a
     * long road figure must not pull a local run into logs-required.
     */
    const l = buildPaperworkLoad(
      load({ miles: 400, originCity: 'Milwaukee', originState: 'WI', destinationCity: 'Chicago', destinationState: 'IL', stops: [] }),
      [], [],
    )
    expect(l.miles).toBe(400)
    expect(l.eld.required).toBe(false)
  })

  it('asks a human rather than clearing a stop it cannot place', () => {
    const l = buildPaperworkLoad(
      load({ originCity: 'CTSI Warehouse', originState: null, destinationCity: 'Kenosha', destinationState: 'WI', stops: [] }),
      [], [],
    )
    expect(l.eld.status).toBe('UNKNOWN')
    expect(l.eld.required).toBe(false)
    expect(l.eld.label).toMatch(/Check whether ELD logs are required/)
  })
})
