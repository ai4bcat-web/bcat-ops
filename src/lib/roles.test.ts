import { describe, it, expect } from 'vitest'
import {
  CLAIMS,
  CLAIM_LABELS,
  ENFORCED_CLAIMS,
  PAGE_GROUP_RE,
  ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  displayName,
  groupsForProfile,
  isEnforcedClaim,
  lockoutCheck,
  reconcileGroups,
  rolePagesFor,
} from './roles'
import { pageOptions } from './navItems'
import type { RoleKey, UserProfileRecord } from '../types/tms'

const OWNER = 'ryne@bcatcorp.com'

let seq = 0
const profile = (over: Partial<UserProfileRecord>): UserProfileRecord => {
  seq += 1
  return {
    id: `user-${seq}`,
    email: `user${seq}@bcatcorp.com`,
    role: 'CUSTOMER_REP',
    status: 'ACTIVE',
    createdBy: OWNER,
    updatedBy: OWNER,
    version: 1,
    ...over,
  }
}

describe('groupsForProfile', () => {
  it('gives an admin the ADMIN group and no page groups', () => {
    expect(groupsForProfile({ role: 'ADMIN' })).toEqual(['ADMIN', 'role-ADMIN'])
  })

  it('gives a manager every TMS board', () => {
    expect(groupsForProfile({ role: 'MANAGER' })).toEqual([
      'page-audit', 'page-carrierPay', 'page-carriers', 'page-commissions',
      'page-customers', 'page-invoicing', 'page-loads', 'page-locations',
      'page-quotes', 'page-reports', 'role-MANAGER',
    ])
  })

  it('keeps a customer rep off the carrier side and a carrier rep off the customer side', () => {
    expect(groupsForProfile({ role: 'CUSTOMER_REP' })).toEqual([
      'page-commissions', 'page-customers', 'page-invoicing', 'page-loads',
      'page-locations', 'page-quotes', 'page-reports', 'role-CUSTOMER_REP',
    ])
    expect(groupsForProfile({ role: 'CARRIER_REP' })).toEqual([
      'page-carrierPay', 'page-carriers', 'page-commissions', 'page-loads',
      'page-locations', 'page-quotes', 'page-reports', 'role-CARRIER_REP',
    ])
  })

  it('gives AR/AP the money boards and compliance the profiles', () => {
    expect(groupsForProfile({ role: 'AR_AP' })).toEqual([
      'page-carrierPay', 'page-factoring', 'page-invoicing', 'page-reports',
      'page-vendorAp', 'role-AR_AP',
    ])
    expect(groupsForProfile({ role: 'COMPLIANCE' })).toEqual([
      'page-carriers', 'page-customers', 'page-locations', 'role-COMPLIANCE',
    ])
  })

  it('emits nothing at all for NONE — not even a role group', () => {
    expect(groupsForProfile({ role: 'NONE' })).toEqual([])
    expect(groupsForProfile({ role: null })).toEqual([])
  })

  it('folds extra pages and claims in beside the role pages', () => {
    expect(
      groupsForProfile({
        role: 'COMPLIANCE',
        extraPages: ['dispatch', 'trucks'],
        claims: ['CARRIER_STATUS_EDIT', 'CARRIER_INSURANCE_EDIT'],
      }),
    ).toEqual([
      'claim-CARRIER_INSURANCE_EDIT', 'claim-CARRIER_STATUS_EDIT',
      'page-carriers', 'page-customers', 'page-dispatch', 'page-locations',
      'page-trucks', 'role-COMPLIANCE',
    ])
  })

  it('ignores an unknown role or claim, and a page key no group could be named for', () => {
    expect(
      groupsForProfile({
        role: 'SUPERUSER' as RoleKey,
        extraPages: ['loads', 'not a page!'],
        claims: ['AR_POSTING', 'FLY_THE_PLANE'],
      }),
    ).toEqual(['claim-AR_POSTING', 'page-loads'])
  })

  it('does not repeat a page the role already grants', () => {
    const groups = groupsForProfile({ role: 'CUSTOMER_REP', extraPages: ['loads', 'loads'] })
    expect(groups.filter((g) => g === 'page-loads')).toHaveLength(1)
  })

  it('emits only groups the Lambda would accept', () => {
    for (const role of ROLES) {
      for (const page of rolePagesFor(role)) expect(PAGE_GROUP_RE.test(`page-${page}`)).toBe(true)
    }
  })
})

describe('reconcileGroups', () => {
  it('adds what is missing and removes an off-role page that is no longer wanted', () => {
    const result = reconcileGroups(
      ['page-loads', 'page-trucks', 'role-CUSTOMER_REP'],
      ['page-loads', 'page-carriers', 'role-CARRIER_REP'],
    )
    expect(result.add).toEqual(['page-carriers', 'role-CARRIER_REP'])
    expect(result.remove).toEqual(['page-trucks', 'role-CUSTOMER_REP'])
  })

  it('never removes DISPATCHER or any group it does not manage', () => {
    const result = reconcileGroups(['DISPATCHER', 'SOME_OTHER_TEAM', 'page-loads'], ['page-loads'])
    expect(result.remove).toEqual([])
    expect(result.add).toEqual([])
  })

  it('leaves a kept group alone even though it is unwanted and managed', () => {
    const result = reconcileGroups(['ADMIN', 'page-fuel', 'page-trucks'], ['page-loads'], ['ADMIN', 'page-fuel'])
    expect(result.remove).toEqual(['page-trucks'])
    expect(result.add).toEqual(['page-loads'])
  })

  it('takes the ADMIN group away when it is not kept and not desired', () => {
    expect(reconcileGroups(['ADMIN'], []).remove).toEqual(['ADMIN'])
  })

  it('returns sorted, deduped lists whatever order it is given', () => {
    const result = reconcileGroups(
      ['page-trucks', 'page-fuel'],
      ['role-MANAGER', 'page-loads', 'page-loads'],
    )
    expect(result.add).toEqual(['page-loads', 'role-MANAGER'])
    expect(result.remove).toEqual(['page-fuel', 'page-trucks'])
  })
})

describe('lockoutCheck', () => {
  const owner = profile({ id: OWNER, email: OWNER, role: 'ADMIN' })
  const admin = profile({ id: 'dennis@bcatcorp.com', email: 'Dennis@bcatcorp.com', role: 'ADMIN' })
  const rep = profile({ id: 'rep@bcatcorp.com', email: 'rep@bcatcorp.com', role: 'CUSTOMER_REP' })

  it('refuses to demote, disable or delete the owner', () => {
    const base = { actorEmail: admin.email, actorIsOwner: false, targetId: owner.id, targetEmail: 'RYNE@BCATCORP.COM' }
    expect(lockoutCheck([owner, admin], { ...base, action: 'setRole', nextRole: 'MANAGER' }))
      .toBe("The owner's role cannot be changed.")
    expect(lockoutCheck([owner, admin], { ...base, action: 'disable' }))
      .toBe('The owner account cannot be disabled.')
    expect(lockoutCheck([owner, admin], { ...base, action: 'delete' }))
      .toBe('The owner account cannot be deleted.')
  })

  it('lets the owner stay an admin', () => {
    expect(lockoutCheck([owner, admin], {
      actorEmail: admin.email, actorIsOwner: false, targetId: owner.id, targetEmail: owner.email,
      action: 'setAdmin', nextRole: 'ADMIN',
    })).toBeNull()
  })

  it('refuses self-demotion and self-disable', () => {
    const base = { actorEmail: 'DENNIS@bcatcorp.com', actorIsOwner: false, targetId: admin.id, targetEmail: admin.email }
    expect(lockoutCheck([owner, admin], { ...base, action: 'setRole', nextRole: 'MANAGER' }))
      .toBe('You cannot change your own role.')
    expect(lockoutCheck([owner, admin], { ...base, action: 'disable' }))
      .toBe('You cannot disable your own account.')
  })

  it('refuses to take the last enabled admin away', () => {
    const inactiveAdmin = profile({ id: 'old@bcatcorp.com', email: 'old@bcatcorp.com', role: 'ADMIN', status: 'INACTIVE' })
    const only = [admin, inactiveAdmin, rep]
    const base = { actorEmail: OWNER, actorIsOwner: true, targetId: admin.id, targetEmail: admin.email }
    const refusal = `${admin.email} is the last admin — promote somebody else first.`
    expect(lockoutCheck(only, { ...base, action: 'setRole', nextRole: 'MANAGER' })).toBe(refusal)
    expect(lockoutCheck(only, { ...base, action: 'disable' })).toBe(refusal)
    expect(lockoutCheck(only, { ...base, action: 'delete' })).toBe(refusal)
  })

  it('allows a normal demotion once a second admin exists', () => {
    const second = profile({ id: 'two@bcatcorp.com', email: 'two@bcatcorp.com', role: 'ADMIN' })
    expect(lockoutCheck([admin, second, rep], {
      actorEmail: OWNER, actorIsOwner: true, targetId: admin.id, targetEmail: admin.email,
      action: 'setRole', nextRole: 'MANAGER',
    })).toBeNull()
  })

  it('allows disabling and deleting somebody who is not an admin', () => {
    const base = { actorEmail: admin.email, actorIsOwner: false, targetId: rep.id, targetEmail: rep.email }
    expect(lockoutCheck([admin, rep], { ...base, action: 'disable' })).toBeNull()
    expect(lockoutCheck([admin, rep], { ...base, action: 'delete' })).toBeNull()
    expect(lockoutCheck([admin, rep], { ...base, action: 'setRole', nextRole: 'NONE' })).toBeNull()
  })

  it('treats nextEnabled false as a disable', () => {
    expect(lockoutCheck([owner], {
      actorEmail: OWNER, actorIsOwner: true, targetId: owner.id, targetEmail: owner.email,
      action: 'setRole', nextRole: 'ADMIN', nextEnabled: false,
    })).toBe('The owner account cannot be disabled.')
  })
})

describe('displayName', () => {
  it('title-cases the e-mail local part, exactly as the Users page always has', () => {
    expect(displayName('first.last@x.com')).toBe('First Last')
    expect(displayName({ email: 'first_last-jr@x.com' })).toBe('First Last Jr')
    expect(displayName({ username: 'ryne', email: null })).toBe('Ryne')
  })

  it('prefers a name somebody typed', () => {
    expect(displayName({ email: 'first.last@x.com', name: 'Rynaldo' })).toBe('Rynaldo')
    expect(displayName({ email: 'first.last@x.com', name: '   ' })).toBe('First Last')
  })

  it('prints an em dash rather than an empty name', () => {
    expect(displayName('')).toBe('—')
    expect(displayName({ email: null, name: null, username: null })).toBe('—')
  })
})

describe('tables', () => {
  it('offers every grantable page exactly once', () => {
    const keys = pageOptions().map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('loads')
  })

  it('keeps an extra page grant even for a page key this file has never heard of', () => {
    // A new `RequirePage` key becomes grantable the moment the nav lists it; the
    // Lambda has always minted the group on demand, and so does this table.
    const groups = groupsForProfile({ role: 'NONE', claims: [], extraPages: ['brandNewPage'] })
    expect(groups).toEqual(['page-brandNewPage'])
  })

  it('labels and describes every role, and every claim', () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy()
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy()
    }
    for (const claim of CLAIMS) expect(CLAIM_LABELS[claim]).toBeTruthy()
    expect(ROLE_LABELS.AR_AP).toBe('AR/AP')
  })

  it('enforces only the five claims a Lambda refuses on', () => {
    expect(ENFORCED_CLAIMS.every((c) => CLAIMS.includes(c))).toBe(true)
    expect(isEnforcedClaim('AP_APPROVAL')).toBe(true)
    expect(isEnforcedClaim('AR_CHARGES')).toBe(false)
    expect(isEnforcedClaim('NOT_A_CLAIM')).toBe(false)
  })
})
