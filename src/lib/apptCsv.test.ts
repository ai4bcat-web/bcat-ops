import { describe, it, expect } from 'vitest'
import { apptRowsToCsv, apptCsvFilename, APPT_CSV_HEADER } from './apptCsv'
import { apptQueue, groupByPickupDate } from './apptQueue'
import { fromDateInput, fromDateTimeInput } from './date'
import type { Load, Stop } from '@/types'

const stop = (over: Partial<Stop> = {}): Stop => ({
  id: 's1', type: 'pickup', appt: fromDateInput('2026-08-19'),
  apptType: 'tbd', driverId: null, sequence: 0, ...over,
})

const load = (over: Partial<Load> = {}): Load => ({
  id: 'l1', aljexId: '12345', tmsId: 'T1', pickupNumber: 'PU-1',
  pickupAppt: fromDateInput('2026-08-19'), deliveryAppt: fromDateInput('2026-08-20'),
  readyToInvoice: false, createdBy: '', updatedBy: '', createdAt: '', updatedAt: '',
  ...over,
} as Load)

const name = (id: string | null) => (id === 'd1' ? 'Zak Pace' : '—')

describe('apptRowsToCsv', () => {
  it('writes a header plus one line per row', () => {
    const rows = apptQueue([load({ stops: [stop()] })])
    const lines = apptRowsToCsv(rows, name).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(APPT_CSV_HEADER.map((h) => `"${h}"`).join(','))
  })

  it('carries the detail needed to make the call', () => {
    const rows = apptQueue([load({
      customer: 'Acme Freight',
      stops: [stop({ name: 'Dock 4', city: 'Joliet, IL', driverId: 'd1' })],
    })])
    const csv = apptRowsToCsv(rows, name)
    expect(csv).toContain('"12345"')
    expect(csv).toContain('"PU-1"')
    expect(csv).toContain('"Acme Freight"')
    expect(csv).toContain('"Dock 4, Joliet, IL"')
    expect(csv).toContain('"Zak Pace"')
    expect(csv).toContain('"NEED"')
  })

  it('keeps a comma inside a field from shifting the columns', () => {
    // "Joliet, IL" is one cell. If it leaked, every column after it would slide left and
    // the phone-call sheet would show the wrong driver against the wrong load.
    const rows = apptQueue([load({ customer: 'Smith, Jones & Co', stops: [stop({ city: 'Joliet, IL' })] })])
    const cells = apptRowsToCsv(rows, name).split('\n')[1].match(/"(?:[^"]|"")*"/g)!
    expect(cells).toHaveLength(APPT_CSV_HEADER.length)
    expect(cells[4]).toBe('"Smith, Jones & Co"')
  })

  it('doubles an embedded quote per RFC 4180', () => {
    const rows = apptQueue([load({ customer: 'The "Big" Co', stops: [stop()] })])
    expect(apptRowsToCsv(rows, name)).toContain('"The ""Big"" Co"')
  })

  it('survives a newline inside a field without breaking the row count', () => {
    const rows = apptQueue([load({ customer: 'Line1\nLine2', stops: [stop()] })])
    const csv = apptRowsToCsv(rows, name)
    // The newline stays inside the quoted cell — a CSV reader rejoins it.
    expect(csv).toContain('"Line1\nLine2"')
    expect(csv.match(/"Line1\nLine2"/g)).toHaveLength(1)
  })

  it('reports the scheduled pickup and delivery times, using the on-screen labels', () => {
    // The time columns read exactly as the calendar renders them: a real time, NEED for a
    // stop flagged tbd, Pending for an exact appointment with no time chosen yet.
    const rows = apptQueue([load({ stops: [
      stop({ id: 'p', type: 'pickup', apptType: 'tbd' }),
      stop({ id: 'd', type: 'delivery', apptType: 'exact', sequence: 1,
             appt: fromDateTimeInput('2026-08-20T14:30') }),
    ] })])
    const line = apptRowsToCsv(rows, name).split('\n')[1]
    expect(line).toContain('"14:30"')   // delivery has a booked time
    expect(line).toContain('"NEED"')    // pickup is flagged NEED

    const pending = apptQueue([load({ id: 'l2', stops: [
      stop({ id: 'p2', type: 'pickup', apptType: 'exact' }),   // date only, no time
    ] })])
    expect(apptRowsToCsv(pending, name).split('\n')[1]).toContain('"Pending"')
  })

  it('exports only the rows it was given, in that order', () => {
    const rows = apptQueue([
      load({ id: 'a', aljexId: 'AAA', stops: [stop()] }),
      load({ id: 'b', aljexId: 'BBB', stops: [stop()] }),
    ])
    const csv = apptRowsToCsv([rows[1], rows[0]], name)
    expect(csv.indexOf('BBB')).toBeLessThan(csv.indexOf('AAA'))
  })
})

describe('groupByPickupDate', () => {
  const mk = (id: string, puDate: string) => load({
    id, aljexId: id, pickupAppt: fromDateInput(puDate),
    stops: [
      { id: `${id}p`, type: 'pickup', appt: fromDateInput(puDate), apptType: 'tbd', driverId: null, sequence: 0 },
      { id: `${id}d`, type: 'delivery', appt: fromDateInput(puDate), apptType: 'exact', driverId: null, sequence: 1 },
    ],
  })

  it('groups rows by the load pickup date, chronologically', () => {
    const rows = apptQueue([mk('c', '2026-08-21'), mk('a', '2026-08-19'), mk('b', '2026-08-20')])
    expect(groupByPickupDate(rows).map((s) => s.key)).toEqual(['2026-08-19', '2026-08-20', '2026-08-21'])
  })

  it('puts a delivery stop under its LOAD pickup date, not its own date', () => {
    // A delivery is chased in the context of the pickup that feeds it.
    const l = load({ id: 'x', stops: [
      { id: 'xp', type: 'pickup', appt: fromDateTimeInput('2026-08-19T08:00'), apptType: 'exact', driverId: null, sequence: 0 },
      { id: 'xd', type: 'delivery', appt: fromDateInput('2026-08-25'), apptType: 'tbd', driverId: null, sequence: 1 },
    ] })
    const sections = groupByPickupDate(apptQueue([l]))
    expect(sections).toHaveLength(1)
    expect(sections[0].key).toBe('2026-08-19')
    expect(sections[0].rows[0].stopType).toBe('delivery')
  })

  it('sinks rows with no pickup date to the end', () => {
    const none = load({ id: 'n', pickupAppt: '', stops: [
      { id: 'np', type: 'pickup', appt: '', apptType: 'tbd', driverId: null, sequence: 0 },
    ] })
    const keys = groupByPickupDate(apptQueue([mk('a', '2026-08-19'), none])).map((s) => s.key)
    expect(keys).toEqual(['2026-08-19', ''])
  })

  it('loses no rows', () => {
    const rows = apptQueue([mk('a', '2026-08-19'), mk('b', '2026-08-20')])
    const total = groupByPickupDate(rows).reduce((n, s) => n + s.rows.length, 0)
    expect(total).toBe(rows.length)
  })
})

describe('apptCsvFilename', () => {
  it('names the file after the section date', () => {
    expect(apptCsvFilename('2026-08-19')).toBe('appts-2026-08-19.csv')
  })

  it('gives the undated section a real name rather than appts-.csv', () => {
    expect(apptCsvFilename('')).toBe('appts-no-pickup-date.csv')
  })
})
