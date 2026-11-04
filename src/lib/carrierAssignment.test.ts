import { describe, expect, it } from 'vitest'
import { advanceTarget, deriveAssignmentStatus, driverInfoGaps, ladderPatch, parseAssignmentTimes, stampAssignmentTime } from './carrierAssignment'

const FOUR = { driverName: 'D', driverPhone: '1', truckNumber: 'T', trailerNumber: 'R' }

describe('deriveAssignmentStatus', () => {
  it('waits on setup until the directory carrier is ACTIVE, whatever else is true', () => {
    for (const carrierStatus of ['PENDING', 'REVIEW', 'INACTIVE', null]) {
      expect(deriveAssignmentStatus({ carrierStatus, rateConStatus: 'SIGNED', ...FOUR })).toBe('ASSIGNED_SETUP_PENDING')
    }
  })

  it('climbs setup complete -> rate con sent -> signed -> driver info', () => {
    expect(deriveAssignmentStatus({ carrierStatus: 'ACTIVE', rateConStatus: 'NOT_SENT' })).toBe('ASSIGNED_SETUP_COMPLETE')
    expect(deriveAssignmentStatus({ carrierStatus: 'ACTIVE', rateConStatus: 'SENT' })).toBe('RATE_CON_SENT')
    expect(deriveAssignmentStatus({ carrierStatus: 'ACTIVE', rateConStatus: 'OPENED' })).toBe('RATE_CON_SENT')
    expect(deriveAssignmentStatus({ carrierStatus: 'ACTIVE', rateConStatus: 'SIGNED' })).toBe('RATE_CON_SIGNED')
    expect(deriveAssignmentStatus({ carrierStatus: 'ACTIVE', rateConStatus: 'SIGNED', ...FOUR })).toBe('DRIVER_INFO_ENTERED')
  })

  it('driver info needs all four fields', () => {
    expect(driverInfoGaps({ ...FOUR, trailerNumber: '  ' })).toEqual(['trailer number'])
    expect(driverInfoGaps({})).toHaveLength(4)
    expect(deriveAssignmentStatus({ carrierStatus: 'ACTIVE', rateConStatus: 'SENT', ...FOUR, driverPhone: '' })).toBe('RATE_CON_SENT')
  })
})

describe('advanceTarget never walks back', () => {
  it('returns the higher rung only', () => {
    expect(advanceTarget(null, { carrierStatus: 'PENDING', rateConStatus: 'NOT_SENT' })).toBe('ASSIGNED_SETUP_PENDING')
    expect(advanceTarget('ASSIGNED_SETUP_PENDING', { carrierStatus: 'ACTIVE', rateConStatus: 'NOT_SENT' })).toBe('ASSIGNED_SETUP_COMPLETE')
    expect(advanceTarget('RATE_CON_SIGNED', { carrierStatus: 'INACTIVE', rateConStatus: 'SIGNED' })).toBeNull()
    expect(advanceTarget('RATE_CON_SENT', { carrierStatus: 'ACTIVE', rateConStatus: 'VOIDED' })).toBeNull()
  })
})

describe('assignment timestamps', () => {
  it('keeps the first arrival and round-trips as a JSON string', () => {
    const first = ladderPatch({}, 'ASSIGNED_SETUP_PENDING', '2026-11-04T10:00:00.000Z')
    const second = ladderPatch(first, 'ASSIGNED_SETUP_COMPLETE', '2026-11-04T11:00:00.000Z')
    expect(parseAssignmentTimes(second.assignmentTimes)).toEqual({
      ASSIGNED_SETUP_PENDING: '2026-11-04T10:00:00.000Z', ASSIGNED_SETUP_COMPLETE: '2026-11-04T11:00:00.000Z',
    })
    expect(stampAssignmentTime(second.assignmentTimes, 'ASSIGNED_SETUP_PENDING', 'later').ASSIGNED_SETUP_PENDING).toBe('2026-11-04T10:00:00.000Z')
    expect(parseAssignmentTimes('not json')).toEqual({})
    expect(parseAssignmentTimes('{"BOGUS":"x"}')).toEqual({})
  })
})
