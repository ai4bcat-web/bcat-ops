import { describe, it, expect } from 'vitest'
import { isOwnerOperatorGroup } from './ownerOperatorTrips'

describe('isOwnerOperatorGroup', () => {
  it('counts Amazon drivers as owner operators', () => {
    // They run under a lease, not as employees — classificationForFleet in fileHub.ts
    // already treats the AMAZON fleet this way. They must appear on the owner-operator
    // page WITHOUT a pay-group change, which would hide their Amazon history.
    expect(isOwnerOperatorGroup('AMAZON')).toBe(true)
    expect(isOwnerOperatorGroup('OWNER_OPERATOR')).toBe(true)
  })

  it('treats a missing group as Amazon, matching the staff Amazon page default', () => {
    expect(isOwnerOperatorGroup(null)).toBe(true)
    expect(isOwnerOperatorGroup(undefined)).toBe(true)
  })

  it('excludes company fleets that settle on their own pages', () => {
    expect(isOwnerOperatorGroup('BOX_TRUCK')).toBe(false)
    expect(isOwnerOperatorGroup('LOCAL')).toBe(false)
  })
})
