import { describe, expect, it } from 'vitest'
import { canCreateDirectoryRecords, FLEET_PROFILE_PATHS, FLEET_PROFILES_ONLY_EMAILS, isFleetProfilesOnly } from './profileAccess'

describe('who is limited to Assets and Drivers on the Profiles page', () => {
  it('limits Jason, whatever the case of the address or the page grants he holds', () => {
    expect(isFleetProfilesOnly('jason@bcatcorp.com', ['page-tms', 'page-customers'])).toBe(true)
    expect(isFleetProfilesOnly(' Jason@BCATcorp.com ', [])).toBe(true)
    expect(isFleetProfilesOnly('jason@bcatcorp.com')).toBe(true)
  })

  it('never limits the owner or an ADMIN, even if listed, and nobody else', () => {
    expect(isFleetProfilesOnly('jason@bcatcorp.com', ['ADMIN'])).toBe(false)
    expect(isFleetProfilesOnly('ryne@bcatcorp.com', [])).toBe(false)
    expect(isFleetProfilesOnly('ruben@bcatcorp.com', ['page-tms'])).toBe(false)
    expect(isFleetProfilesOnly(null, [])).toBe(false)
    expect(isFleetProfilesOnly('', [])).toBe(false)
  })

  it('lists exactly the fleet tabs', () => {
    expect([...FLEET_PROFILE_PATHS]).toEqual(['/profiles/drivers', '/profiles/assets'])
    expect([...FLEET_PROFILES_ONLY_EMAILS]).toEqual(['jason@bcatcorp.com'])
  })
})

describe('who may add a customer, location or carrier', () => {
  it('is closed to Jason, open to the owner, an ADMIN and everyone else', () => {
    expect(canCreateDirectoryRecords('jason@bcatcorp.com', ['page-tms', 'page-loads'])).toBe(false)
    expect(canCreateDirectoryRecords('jason@bcatcorp.com', ['ADMIN'])).toBe(true)
    expect(canCreateDirectoryRecords('ryne@bcatcorp.com', [])).toBe(true)
    expect(canCreateDirectoryRecords('ruben@bcatcorp.com', ['page-tms'])).toBe(true)
    expect(canCreateDirectoryRecords(undefined, undefined)).toBe(true)
  })
})
