import { describe, expect, it } from 'vitest'
import { BILLING_RELEASE_PAGE, holdsPerUserGrant, pageOptions } from './navItems'

describe('per-user grants', () => {
  it('leaves the Aljex sign-off grant group-only', () => {
    expect(holdsPerUserGrant(['ADMIN'], 'aljexSignoff')).toBe(false)
    expect(holdsPerUserGrant(['page-aljexSignoff'], 'aljexSignoff')).toBe(true)
  })

  it('no longer offers the old billing-release grant: Load review and Invoicing replace it', () => {
    expect(pageOptions().map((p) => p.key)).not.toContain(BILLING_RELEASE_PAGE)
    expect(holdsPerUserGrant(['page-billingRelease'], BILLING_RELEASE_PAGE)).toBe(false)
  })
})
