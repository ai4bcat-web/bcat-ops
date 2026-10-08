import { describe, it, expect } from 'vitest'
import {
  buildPaperworkLoad,
  stopDetention,
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

describe('the detention flag the driver sets at a stop', () => {
  // Two stops, each with its own id, as every load built from stops carries them.
  const twoStops = () => load({
    stops: [
      { id: 'st-pu', type: 'pickup', sequence: 0, name: 'Batory Oakley', city: 'Chicago, IL', appt: '2026-10-05T17:00:00.000Z', apptType: 'exact', driverId: DRIVER },
      { id: 'st-de', type: 'delivery', sequence: 1, name: 'Eagle Foods', city: 'Waukegan, IL', appt: '2026-10-06T05:00:00.000Z', apptType: 'tbd', driverId: DRIVER },
    ],
  })

  it('is off until the driver flags it', () => {
    expect(stopDetention([], 'st-pu')).toBe(false)
    const p = buildPaperworkLoad(twoStops(), [], [])
    expect(p.stops.map((s) => s.detention)).toEqual([false, false])
  })

  it('keeps pickup and delivery flags apart — keyed on the stop, not the load', () => {
    const p = buildPaperworkLoad(twoStops(), [], [
      { loadId: 'load-1', driverId: DRIVER, leg: 'PICKUP', stopId: 'st-pu', detention: true },
      { loadId: 'load-1', driverId: DRIVER, leg: 'DELIVERY', stopId: 'st-de', detention: false },
    ])
    expect(p.stops.find((s) => s.id === 'st-pu')?.detention).toBe(true)
    expect(p.stops.find((s) => s.id === 'st-de')?.detention).toBe(false)
  })

  it('a cleared flag reads as no detention', () => {
    expect(stopDetention([{ loadId: 'l', driverId: DRIVER, leg: 'PICKUP', stopId: 's', detention: false }], 's')).toBe(false)
  })

  it('states the rule the driver is asked to apply', () => {
    expect(DETENTION_FREE_HOURS).toBe(2)
  })

  it('carries the PO (the TMS ID / PO field) and the pickup number for the driver', () => {
    const p = buildPaperworkLoad(load({ tmsId: '212775896', pickupNumber: '1750128' }), [], [])
    expect(p.poNumber).toBe('212775896')
    expect(p.pickupNumber).toBe('1750128')
  })

  it("marks which stops are the viewing driver's, and passes their events and ETA through", () => {
    const l = load({
      stops: [
        { id: 'st-pu', type: 'pickup', sequence: 0, name: 'A', city: 'Chicago, IL', appt: '2026-10-05T17:00:00.000Z', driverId: DRIVER, arrivedAt: '2026-10-05T16:50:00.000Z', departedAt: '2026-10-05T17:30:00.000Z' },
        { id: 'st-de', type: 'delivery', sequence: 1, name: 'B', city: 'Waukegan, IL', appt: '2026-10-05T20:00:00.000Z', driverId: 'drv-other', etaAt: '2026-10-05T20:00:00.000Z', etaBasis: 'appt' },
      ],
    })
    const p = buildPaperworkLoad(l, [], [], DRIVER)
    expect(p.stops[0]).toMatchObject({ yours: true, arrivedAt: '2026-10-05T16:50:00.000Z', departedAt: '2026-10-05T17:30:00.000Z' })
    expect(p.stops[1]).toMatchObject({ yours: false, etaAt: '2026-10-05T20:00:00.000Z', etaBasis: 'appt' })
    // Nobody looking: nothing is anybody's.
    expect(buildPaperworkLoad(l, [], []).stops.every((s) => !s.yours)).toBe(true)
  })

  it("a stop with no driver on it is the viewer's when they are the only driver on the load", () => {
    const p = buildPaperworkLoad(twoStops(), [], [], DRIVER)
    expect(p.stops.map((s) => s.yours)).toEqual([true, true])
  })

  it('puts each stop on its Chicago calendar day, with the appointment type the app prints', () => {
    const p = buildPaperworkLoad(twoStops(), [], [])
    // 17:00Z on 5 Oct is noon Chicago; 05:00Z on 6 Oct is midnight Chicago — still the 6th.
    expect(p.stops[0]).toMatchObject({ id: 'st-pu', date: '2026-10-05', apptType: 'exact', sequence: 0 })
    expect(p.stops[1]).toMatchObject({ id: 'st-de', date: '2026-10-06', apptType: 'tbd', sequence: 1 })
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
    expect(summarize(loads)).toEqual({
      loadCount: 4, podsMissing: 1, podsIllegible: 2, eldRequired: 4,
      overnightCount: 0, overnightCents: 0,
    })
  })

  it('does not count a missing POD as illegible as well', () => {
    const loads = [buildPaperworkLoad(load(), [], [])]
    expect(summarize(loads)).toEqual({
      loadCount: 1, podsMissing: 1, podsIllegible: 0, eldRequired: 1,
      overnightCount: 0, overnightCents: 0,
    })
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

describe('over-the-road runs and their rate', () => {
  it('marks a run to Iowa and shows what it earned', () => {
    const l = buildPaperworkLoad(
      load({ destinationCity: 'Newton', destinationState: 'IA', rate: 150_000, stops: [] }),
      [], [],
    )
    expect(l.overnight).toBe(true)
    expect(l.rateCents).toBe(150_000)
  })

  it('marks a run FROM Iowa too', () => {
    const l = buildPaperworkLoad(
      load({ originCity: 'Urbandale', originState: 'IA', destinationCity: 'Chicago',
             destinationState: 'IL', rate: 90_000, stops: [] }),
      [], [],
    )
    expect(l.overnight).toBe(true)
    expect(l.rateCents).toBe(90_000)
  })

  it('shows NO rate on a local run, even though the load has one', () => {
    /*
     * The rule this payload exists to keep: an Ivan driver is not settled a percentage, so
     * no money may reach them — OTR runs are the single, deliberate exception. The rate is
     * read only inside the over-the-road branch, so a local load has no path by which its
     * rate can leak.
     */
    const l = buildPaperworkLoad(
      load({ originCity: 'Chicago', originState: 'IL', destinationCity: 'Waukegan',
             destinationState: 'IL', rate: 50_000, stops: [] }),
      [], [],
    )
    expect(l.overnight).toBe(false)
    expect(l.rateCents).toBeNull()
  })

  it('shows no rate on an OTR run that has none recorded', () => {
    const l = buildPaperworkLoad(
      load({ destinationCity: 'Newton', destinationState: 'IA', rate: null, stops: [] }),
      [], [],
    )
    expect(l.overnight).toBe(true)
    expect(l.rateCents).toBeNull()
  })

  it('does not call a long non-Iowa run over-the-road', () => {
    // Holmen WI needs ELD logs at 197 air miles but is not an Iowa run; the two rules are
    // separate questions and must not be collapsed into one.
    const l = buildPaperworkLoad(
      load({ originCity: 'Pleasant Prairie', originState: 'WI', destinationCity: 'Holmen',
             destinationState: 'WI', rate: 80_000, stops: [] }),
      [], [],
    )
    expect(l.eld.required).toBe(true)
    expect(l.overnight).toBe(false)
    expect(l.rateCents).toBeNull()
  })

  it('totals the week’s OTR runs', () => {
    const loads = [
      buildPaperworkLoad(load({ id: 'a', destinationCity: 'Newton', destinationState: 'IA', rate: 150_000, stops: [] }), [], []),
      buildPaperworkLoad(load({ id: 'b', originCity: 'Urbandale', originState: 'IA', destinationCity: 'Chicago', destinationState: 'IL', rate: 90_000, stops: [] }), [], []),
      buildPaperworkLoad(load({ id: 'c', originCity: 'Chicago', originState: 'IL', destinationCity: 'Waukegan', destinationState: 'IL', rate: 50_000, stops: [] }), [], []),
    ]
    const w = summarize(loads)
    expect(w.overnightCount).toBe(2)
    // The local load's rate is not in the total, because it is not in the payload at all.
    expect(w.overnightCents).toBe(240_000)
  })
})
