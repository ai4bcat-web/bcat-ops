/**
 * Shaping a Motive day. The fixture is a real log pulled from the live org (Jason Smith,
 * 2026-10-01), so the field names and units are the ones the API actually sends.
 */
import { describe, it, expect } from 'vitest'
import { toHosDay, hoursLabel, decimalHours, type MotiveLog } from './motiveHos'

const LIVE: MotiveLog = {
  date: '2026-10-01',
  on_duty_duration: 7367,
  driving_duration: 23759,
  off_duty_duration: 55274,
  sleeper_duration: 0,
  total_miles: 338,
  vehicle_numbers: [89510],
  events: [
    { event: { type: 'off_duty', start_time: '2026-10-01T05:00:00Z', end_time: '2026-10-01T11:55:05Z', location: null } },
    { event: { type: 'on_duty', start_time: '2026-10-01T11:55:05Z', end_time: '2026-10-01T12:00:00Z', location: 'Newton, IA' } },
    { event: { type: 'driving', start_time: '2026-10-01T12:00:00Z', end_time: '2026-10-01T12:50:01Z', location: 'Newton, IA' } },
    { event: { type: 'on_duty', start_time: '2026-10-01T12:50:01Z', end_time: '2026-10-01T14:28:22Z', location: 'West Des Moines, IA' } },
  ],
}

describe('toHosDay', () => {
  const d = toHosDay(LIVE)

  it('keeps Motive durations in seconds', () => {
    expect(d.drivingSeconds).toBe(23759)
    expect(d.onDutySeconds).toBe(7367)
  })

  it('counts driving AND on-duty as worked', () => {
    // Motive reports driving separately from on-duty-not-driving; the day's work is both.
    expect(d.workedSeconds).toBe(23759 + 7367)
  })

  it('finds the first working moment and the last', () => {
    expect(d.firstOnDutyAt).toBe('2026-10-01T11:55:05Z')
    expect(d.lastOffDutyAt).toBe('2026-10-01T14:28:22Z')
  })

  it('does not treat off duty as the start of the day', () => {
    // The day opens with an off_duty block; the time card starts when work does.
    expect(d.firstOnDutyAt).not.toBe('2026-10-01T05:00:00Z')
  })

  it('keeps the vehicle numbers as strings', () => {
    expect(d.vehicleNumbers).toEqual(['89510'])
  })

  it('keeps every segment in order, including off duty', () => {
    expect(d.segments).toHaveLength(4)
    expect(d.segments[0].type).toBe('off_duty')
    expect(d.segments[3].location).toBe('West Des Moines, IA')
  })

  it('keeps a running segment with a null end rather than dropping it', () => {
    // "On duty since 06:12 and still going" is what someone looking at today needs.
    const live = toHosDay({
      ...LIVE,
      events: [{ event: { type: 'on_duty', start_time: '2026-10-05T11:00:00Z', end_time: null } }],
    })
    expect(live.segments).toHaveLength(1)
    expect(live.segments[0].endAt).toBeNull()
    expect(live.firstOnDutyAt).toBe('2026-10-05T11:00:00Z')
    expect(live.lastOffDutyAt).toBeNull()
  })

  it('survives a day with nothing in it', () => {
    const empty = toHosDay({ date: '2026-10-02' })
    expect(empty.workedSeconds).toBe(0)
    expect(empty.segments).toEqual([])
    expect(empty.firstOnDutyAt).toBeNull()
    expect(empty.totalMiles).toBeNull()
  })

  it('ignores a negative or non-numeric duration', () => {
    const odd = toHosDay({ date: 'x', driving_duration: -5, on_duty_duration: 'nope' as unknown as number })
    expect(odd.workedSeconds).toBe(0)
  })
})

describe('formatting', () => {
  it('reads a duration the way a driver would', () => {
    expect(hoursLabel(23759)).toBe('6h 35m')
    expect(hoursLabel(0)).toBe('0h 0m')
    expect(hoursLabel(3600)).toBe('1h 0m')
  })

  it('gives payroll a decimal', () => {
    expect(decimalHours(3600)).toBe(1)
    expect(decimalHours(23759 + 7367)).toBe(8.65)
    expect(decimalHours(0)).toBe(0)
  })
})
