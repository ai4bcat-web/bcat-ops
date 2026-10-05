import { describe, it, expect } from 'vitest'
import { buildIvanDriverApp, ivanDrivers, podStateOf } from './ivanDriverApp'
import type { Driver, Load } from '@/types'

function driver(over: Partial<Driver> = {}): Driver {
  return {
    id: 'd1', name: 'Ivan Driver', active: true, type: 'company',
    fleetGroup: 'LOCAL', driverType: 'COMPANY',
    ...over,
  } as Driver
}

function load(over: Partial<Load> = {}): Load {
  return {
    id: 'l1', aljexId: '14538', customer: 'Wayfinder',
    deliveryAppt: '2026-10-07T15:00:00Z', deliveryDriverId: 'd1',
    originCity: 'Chicago, IL', destinationCity: 'Indianapolis, IN',
    ...over,
  } as Load
}

const WEEK = '2026-10-04' // the Sunday of 2026-10-07

describe('who the page is about', () => {
  it('lists Ivan’s own active drivers', () => {
    const list = ivanDrivers([
      driver({ id: 'a', name: 'Anna' }),
      driver({ id: 'b', name: 'Bob', fleetGroup: 'AMAZON' }),       // owner operator
      driver({ id: 'c', name: 'Cal', driverType: 'OWNER_OPERATOR' }), // owner operator
      driver({ id: 'd', name: 'Dot', active: false }),               // gone
      driver({ id: 'e', name: 'BROKER COVERED', type: 'broker' }),   // not a person
    ])
    expect(list.map((d) => d.id)).toEqual(['a'])
  })

  it('flags a driver whose fleet is unset, because the app keeps their settlement', () => {
    /*
     * The dispatch board calls an unclassified driver Ivan's; driverProgramOf does not,
     * because several live owner operators carry no fleet fields and must not lose their
     * pay page. The two readings differ for exactly these people, so the page says so
     * instead of leaving somebody to wonder why the invite led to a settlement.
     */
    const rows = buildIvanDriverApp({
      drivers: [driver({ id: 'u', fleetGroup: undefined, driverType: undefined })],
      loads: [], submissions: [], weekStart: WEEK,
    })
    expect(rows[0].unclassified).toBe(true)

    const classified = buildIvanDriverApp({
      drivers: [driver({ id: 'k', fleetGroup: 'LOCAL' })],
      loads: [], submissions: [], weekStart: WEEK,
    })
    expect(classified[0].unclassified).toBe(false)
  })
})

describe('POD state per load', () => {
  it('is missing when nothing was sent', () => {
    expect(podStateOf(load(), [])).toEqual({ state: 'MISSING', pages: 0, notes: null, uploadedAt: null })
  })

  it('matches a submission by load id', () => {
    const r = podStateOf(load(), [{ loadId: 'l1', referenceNumber: null, docs: [{ kind: 'POD', legibility: 'OK' }] }])
    expect(r.state).toBe('OK')
    expect(r.pages).toBe(1)
  })

  it('matches a submission by PRO when it was never linked to the load', () => {
    const r = podStateOf(load(), [{ loadId: null, referenceNumber: 'PRO 14538', docs: [{ kind: 'POD', legibility: 'OK' }] }])
    expect(r.state).toBe('OK')
  })

  it('reports not legible on the worst page, with the reason', () => {
    const r = podStateOf(load(), [{
      loadId: 'l1', referenceNumber: null,
      docs: [
        { kind: 'POD', legibility: 'OK' },
        { kind: 'POD', legibility: 'LOW', legibilityNotes: 'get closer so the whole page fills the frame' },
      ],
    }])
    expect(r.state).toBe('ILLEGIBLE')
    expect(r.pages).toBe(2)
    expect(r.notes).toMatch(/get closer/)
  })

  it('does not let a rate confirmation stand in for a POD', () => {
    const r = podStateOf(load(), [{ loadId: 'l1', referenceNumber: null, docs: [{ kind: 'RATECON', legibility: 'OK' }] }])
    expect(r.state).toBe('MISSING')
  })
})

describe('the week view', () => {
  it('groups a driver’s loads for the selected week only', () => {
    const rows = buildIvanDriverApp({
      drivers: [driver()],
      loads: [
        load({ id: 'in', deliveryAppt: '2026-10-07T15:00:00Z' }),
        load({ id: 'before', deliveryAppt: '2026-09-30T15:00:00Z' }),
        load({ id: 'after', deliveryAppt: '2026-10-13T15:00:00Z' }),
      ],
      submissions: [], weekStart: WEEK,
    })
    expect(rows[0].loads.map((l) => l.load.id)).toEqual(['in'])
  })

  it('finds a load assigned through a stop, not just the legacy field', () => {
    const rows = buildIvanDriverApp({
      drivers: [driver()],
      loads: [load({
        deliveryDriverId: undefined,
        stops: [
          { id: 's1', type: 'delivery', appt: '2026-10-07T15:00:00Z', driverId: 'd1', sequence: 0 },
        ],
      } as Partial<Load>)],
      submissions: [], weekStart: WEEK,
    })
    expect(rows[0].loads).toHaveLength(1)
  })

  it('counts missing and illegible PODs per driver', () => {
    const rows = buildIvanDriverApp({
      drivers: [driver()],
      loads: [
        load({ id: 'a', aljexId: '1001' }),
        load({ id: 'b', aljexId: '1002' }),
        load({ id: 'c', aljexId: '1003' }),
      ],
      submissions: [
        { loadId: 'b', referenceNumber: null, docs: [{ kind: 'POD', legibility: 'OK' }] },
        { loadId: 'c', referenceNumber: null, docs: [{ kind: 'POD', legibility: 'UNREADABLE' }] },
      ],
      weekStart: WEEK,
    })
    expect(rows[0].podsMissing).toBe(1)
    expect(rows[0].podsIllegible).toBe(1)
  })

  it('derives no money of its own', () => {
    /*
     * The staff row embeds the Load so the table can draw the customer, lane and
     * appointment, and a Load carries its rate — staff see rates in a dozen other places,
     * so that is fine here. What must not happen is this page deriving or showing money:
     * no pay percentage, no gross, no check. The DRIVER's payload is the one with no rate
     * in it at all, and amplify/functions/driver-app-api/paperwork.test.ts pins that.
     */
    const rows = buildIvanDriverApp({
      drivers: [driver()],
      loads: [load({ rate: 2400 } as Partial<Load>)],
      submissions: [], weekStart: WEEK,
    })
    const row = rows[0].loads[0]
    expect(Object.keys(row)).toEqual(['load', 'reference', 'podState', 'podPages', 'podNotes', 'podUploadedAt'])
    const { load: _embedded, ...derived } = row
    expect(JSON.stringify(derived)).not.toMatch(/rate|amount|gross|check|pay/i)
  })
})

describe('when the POD arrived', () => {
  it('reports the earliest page, so a re-send does not make a load look late', () => {
    const rows = buildIvanDriverApp({
      drivers: [driver()],
      loads: [load()],
      submissions: [{
        loadId: 'l1', referenceNumber: null,
        docs: [
          { kind: 'POD', uploadedAt: '2026-10-09T18:30:00Z' }, // re-sent later
          { kind: 'POD', uploadedAt: '2026-10-07T16:05:00Z' }, // the one that counts
        ],
      }],
      weekStart: WEEK,
    })
    expect(rows[0].loads[0].podUploadedAt).toBe('2026-10-07T16:05:00Z')
  })

  it('is null when no POD is on file', () => {
    const rows = buildIvanDriverApp({ drivers: [driver()], loads: [load()], submissions: [], weekStart: WEEK })
    expect(rows[0].loads[0].podUploadedAt).toBeNull()
  })

  it('ignores a rate confirmation’s timestamp', () => {
    const rows = buildIvanDriverApp({
      drivers: [driver()],
      loads: [load()],
      submissions: [{ loadId: 'l1', referenceNumber: null, docs: [{ kind: 'RATECON', uploadedAt: '2026-10-06T10:00:00Z' }] }],
      weekStart: WEEK,
    })
    expect(rows[0].loads[0].podUploadedAt).toBeNull()
    expect(rows[0].loads[0].podState).toBe('MISSING')
  })
})
