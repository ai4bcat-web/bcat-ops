import { describe, it, expect } from 'vitest'
import {
  isAdminEmail,
  isOwnerEmail,
  canDeleteFactoringItem,
  ADMIN_EMAILS,
  FACTORING_DELETE_EMAILS,
  OWNER_EMAIL,
} from './admin'

describe('isAdminEmail', () => {
  it('recognises the legacy feature admins', () => {
    for (const email of ADMIN_EMAILS) expect(isAdminEmail(email)).toBe(true)
  })

  it('ignores case and surrounding whitespace', () => {
    expect(isAdminEmail('  Ryne@BCATCorp.com ')).toBe(true)
  })

  it('refuses everyone else and a missing address', () => {
    expect(isAdminEmail('ruben@bcatcorp.com')).toBe(false)
    expect(isAdminEmail(null)).toBe(false)
    expect(isAdminEmail(undefined)).toBe(false)
    expect(isAdminEmail('')).toBe(false)
  })
})

describe('isOwnerEmail', () => {
  it('is exactly one person', () => {
    expect(isOwnerEmail(OWNER_EMAIL)).toBe(true)
    expect(isOwnerEmail('dennis@bcatcorp.com')).toBe(false)
    expect(isOwnerEmail(null)).toBe(false)
  })
})

describe('canDeleteFactoringItem', () => {
  it('allows the two people who run factoring', () => {
    expect(canDeleteFactoringItem('ryne@bcatcorp.com')).toBe(true)
    expect(canDeleteFactoringItem('jenny@bcatcorp.com')).toBe(true)
    expect([...FACTORING_DELETE_EMAILS].sort()).toEqual(['jenny@bcatcorp.com', 'ryne@bcatcorp.com'])
  })

  it('ignores case and surrounding whitespace', () => {
    expect(canDeleteFactoringItem('  Jenny@BCATCorp.com ')).toBe(true)
  })

  it('is narrower than the legacy admin list', () => {
    // Dennis is an admin for other features but does not run factoring, and deleting a row
    // drops the record that a PRO was ever sent for factoring.
    expect(isAdminEmail('dennis@bcatcorp.com')).toBe(true)
    expect(canDeleteFactoringItem('dennis@bcatcorp.com')).toBe(false)
  })

  it('refuses everyone else, including a missing address', () => {
    expect(canDeleteFactoringItem('ruben@bcatcorp.com')).toBe(false)
    expect(canDeleteFactoringItem(null)).toBe(false)
    expect(canDeleteFactoringItem(undefined)).toBe(false)
    expect(canDeleteFactoringItem('')).toBe(false)
  })
})
