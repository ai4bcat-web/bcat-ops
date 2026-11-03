import { describe, it, expect } from 'vitest'
import {
  openSignupRefusals,
  refusalReasonText,
  roleRows,
  awaitingVerification,
  verifiedDriverCount,
  type SignupAuditEntry,
} from './registrations'

const refused = (email: string, at: string, reason = 'NO_DRIVER_RECORD'): SignupAuditEntry => ({
  id: `r-${email}-${at}`,
  entityType: 'DRIVER_SIGNUP',
  entityId: email,
  action: 'refused',
  changes: JSON.stringify({ reason, at }),
  createdAt: at,
})
const dismissed = (email: string, at: string): SignupAuditEntry => ({
  id: `d-${email}-${at}`,
  entityType: 'DRIVER_SIGNUP',
  entityId: email,
  action: 'driver_signup_dismissed',
  changes: JSON.stringify({ at }),
  createdAt: at,
})

describe('openSignupRefusals', () => {
  it('keeps the latest attempt per e-mail, newest first', () => {
    const open = openSignupRefusals([
      refused('a@x.com', '2026-03-01T00:00:00Z'),
      refused('A@x.com', '2026-03-03T00:00:00Z', 'DRIVER_INACTIVE'),
      refused('b@x.com', '2026-03-02T00:00:00Z'),
    ])
    expect(open.map((r) => [r.email, r.at, r.reason])).toEqual([
      ['a@x.com', '2026-03-03T00:00:00Z', 'DRIVER_INACTIVE'],
      ['b@x.com', '2026-03-02T00:00:00Z', 'NO_DRIVER_RECORD'],
    ])
  })

  it('hides a dismissed e-mail until it is refused again afterwards', () => {
    const base = [refused('a@x.com', '2026-03-01T00:00:00Z'), dismissed('a@x.com', '2026-03-02T00:00:00Z')]
    expect(openSignupRefusals(base)).toEqual([])
    expect(openSignupRefusals([...base, refused('a@x.com', '2026-03-05T00:00:00Z')])).toHaveLength(1)
  })

  it('ignores other audit entity types and applies the limit', () => {
    const other: SignupAuditEntry = { ...refused('z@x.com', '2026-03-09T00:00:00Z'), entityType: 'DRIVER' }
    const many = Array.from({ length: 5 }, (_, i) => refused(`u${i}@x.com`, `2026-03-0${i + 1}T00:00:00Z`))
    const open = openSignupRefusals([other, ...many], { limit: 3 })
    expect(open.map((r) => r.email)).toEqual(['u4@x.com', 'u3@x.com', 'u2@x.com'])
  })

  it('survives a malformed changes payload by falling back to createdAt', () => {
    const open = openSignupRefusals([{ ...refused('a@x.com', '2026-03-01T00:00:00Z'), changes: '{not json' }])
    expect(open).toEqual([{ email: 'a@x.com', at: '2026-03-01T00:00:00Z', reason: null }])
  })
})

describe('refusalReasonText', () => {
  it('falls back to the roster wording for unknown codes', () => {
    expect(refusalReasonText('SOMETHING_NEW')).toBe('not on the roster')
    expect(refusalReasonText('DRIVER_INACTIVE')).toBe('driver record is inactive')
  })
})

describe('verifiedDriverCount', () => {
  it('counts a driver once, only when the login is confirmed, verified and enabled', () => {
    const pool = [
      { email: 'a@x.com', status: 'CONFIRMED', enabled: true, emailVerified: true },
      { email: 'b@x.com', status: 'CONFIRMED', enabled: true, emailVerified: false },
      { email: 'c@x.com', status: 'UNCONFIRMED', enabled: true, emailVerified: true },
      { email: 'd@x.com', status: 'CONFIRMED', enabled: false, emailVerified: true },
    ]
    expect(verifiedDriverCount(['A@x.com', 'a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', null, 'nobody@x.com'], pool)).toBe(1)
  })
})

describe('roleRows', () => {
  it('splits each role by status and shows ADMIN as every page', () => {
    const rows = roleRows([
      { role: 'ADMIN', status: 'ACTIVE' },
      { role: 'MANAGER', status: 'ACTIVE' },
      { role: 'MANAGER', status: 'PENDING' },
      { role: 'MANAGER', status: 'INACTIVE' },
    ])
    const admin = rows.find((r) => r.role === 'ADMIN')
    const manager = rows.find((r) => r.role === 'MANAGER')
    expect(admin).toMatchObject({ total: 1, active: 1, pages: null })
    expect(manager).toMatchObject({ total: 3, active: 1, pending: 1, inactive: 1 })
    expect(manager?.pages).toBeGreaterThan(0)
  })
})

describe('awaitingVerification', () => {
  it('lists unconfirmed logins that match an active driver, newest first', () => {
    const pool = [
      { email: 'a@x.com', status: 'UNCONFIRMED', enabled: true, emailVerified: false, createdAt: '2026-03-01T00:00:00Z' },
      { email: 'b@x.com', status: 'UNCONFIRMED', enabled: true, emailVerified: false, createdAt: '2026-03-05T00:00:00Z' },
      { email: 'ghost@x.com', status: 'UNCONFIRMED', enabled: true, emailVerified: false },
      { email: 'c@x.com', status: 'CONFIRMED', enabled: true, emailVerified: true },
      { email: 'gone@x.com', status: 'UNCONFIRMED', enabled: true, emailVerified: false },
    ]
    const drivers = [
      { id: 'd1', name: 'Ann', email: 'A@x.com', active: true },
      { id: 'd2', name: 'Bo', email: 'b@x.com', active: true },
      { id: 'd3', name: 'Cy', email: 'c@x.com', active: true },
      { id: 'd4', name: 'Gone', email: 'gone@x.com', active: false },
    ]
    expect(awaitingVerification(pool, drivers).map((a) => a.driverId)).toEqual(['d2', 'd1'])
  })
})
