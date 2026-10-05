/**
 * Whose duty log a driver is shown. The cases here are the two the live data actually
 * contains, both of which a looser matcher would get wrong.
 */
import { describe, it, expect } from 'vitest'
import { matchMotiveDriver, type MotiveUser } from './motiveDriverMatch'

const USERS: MotiveUser[] = [
  { id: 3580563, first_name: 'Chuck', last_name: 'Best', status: 'active', role: 'driver' },
  { id: 4330269, first_name: 'Jason', last_name: 'Smith', status: 'deactivated', role: 'driver' },
  { id: 15723220, first_name: 'Jason', last_name: 'Smith', status: 'active', role: 'driver' },
  { id: 15244710, first_name: 'Lee', last_name: 'Lara', status: 'active', role: 'driver' },
  { id: 14372650, first_name: 'Chad', last_name: 'Salerno', status: 'active', role: 'driver' },
  { id: 99, first_name: 'Some', last_name: 'Admin', status: 'active', role: 'admin' },
]

describe('matchMotiveDriver', () => {
  it('uses the explicit link when one is set', () => {
    const m = matchMotiveDriver({ id: 'd1', name: 'Charles Best', motiveDriverId: 3580563 }, USERS)
    expect(m.state).toBe('LINKED')
    expect(m.motiveUserId).toBe(3580563)
  })

  it('accepts the link as a string, which is how it comes back from DynamoDB', () => {
    expect(matchMotiveDriver({ id: 'd1', name: 'x', motiveDriverId: '15244710' }, USERS).motiveUserId)
      .toBe(15244710)
  })

  it('reports a link to an account Motive no longer shows', () => {
    const m = matchMotiveDriver({ id: 'd1', name: 'Gone', motiveDriverId: 123456 }, USERS)
    expect(m.state).toBe('STALE')
    expect(m.motiveUserId).toBeNull()
  })

  it('will not match Charles Best to Chuck Best', () => {
    // The real pairing in the live data, and exactly the join a fuzzy matcher would make.
    const m = matchMotiveDriver({ id: 'd1', name: 'Charles Best' }, USERS)
    expect(m.state).toBe('UNLINKED')
    expect(m.motiveUserId).toBeNull()
    expect(m.reason).toMatch(/No active Motive driver has this exact name/)
  })

  it('refuses to pick between two active drivers of the same name', () => {
    const dupes = [...USERS, { id: 777, first_name: 'Lee', last_name: 'Lara', status: 'active', role: 'driver' }]
    const m = matchMotiveDriver({ id: 'd1', name: 'Lee Lara' }, dupes)
    expect(m.state).toBe('UNLINKED')
    expect(m.reason).toMatch(/2 active Motive drivers/)
  })

  it('ignores a deactivated namesake when exactly one active account remains', () => {
    // Jason Smith has one of each; the live account is the only candidate.
    const m = matchMotiveDriver({ id: 'd1', name: 'Jason Smith' }, USERS)
    expect(m.state).toBe('SUGGESTED')
    expect(m.suggestion?.id).toBe(15723220)
  })

  it('only ever suggests — a name match never becomes a usable id', () => {
    const m = matchMotiveDriver({ id: 'd1', name: 'Chad Salerno' }, USERS)
    expect(m.state).toBe('SUGGESTED')
    expect(m.motiveUserId).toBeNull()
  })

  it('does not match a non-driver account', () => {
    expect(matchMotiveDriver({ id: 'd1', name: 'Some Admin' }, USERS).state).toBe('UNLINKED')
  })

  it('says so when the driver has no name at all', () => {
    const m = matchMotiveDriver({ id: 'd1', name: '  ' }, USERS)
    expect(m.state).toBe('UNLINKED')
    expect(m.reason).toMatch(/no name/)
  })

  it('is case- and spacing-insensitive on the name', () => {
    expect(matchMotiveDriver({ id: 'd1', name: '  lee   lara ' }, USERS).suggestion?.id).toBe(15244710)
  })
})
