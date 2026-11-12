import { describe, expect, it } from 'vitest'
import { canReleaseToBilling, holdsPerUserGrant } from './navItems'

describe('canReleaseToBilling', () => {
  it('lets admins, the owner and grant holders release; page access alone does not', () => {
    expect(canReleaseToBilling(['ADMIN'], 'a@bcatcorp.com')).toBe(true)
    expect(canReleaseToBilling([], 'ryne@bcatcorp.com')).toBe(true)
    expect(canReleaseToBilling(['page-billingRelease'], 'j@bcatcorp.com')).toBe(true)
    expect(canReleaseToBilling(['page-invoicing', 'page-tms'], 'b@bcatcorp.com')).toBe(false)
    expect(canReleaseToBilling(null, null)).toBe(false)
  })

  it('leaves the Aljex sign-off grant group-only', () => {
    expect(holdsPerUserGrant(['ADMIN'], 'aljexSignoff')).toBe(false)
  })
})
