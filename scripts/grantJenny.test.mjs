import { describe, expect, it } from 'vitest'
import { GRANT_GROUPS, planGrant, usersWithEmail } from './grantJenny.mjs'

const user = (username, email) => ({ Username: username, Attributes: [{ Name: 'email', Value: email }] })

describe('grantJenny plan', () => {
  it('finds the user case-insensitively and plans both groups', () => {
    const found = usersWithEmail([user('a', 'other@x.test'), user('u-1', 'jenny@BCATCORP.com')], 'Jenny@bcatcorp.com')
    expect(planGrant({ found, currentGroups: ['role-BILLING'], profile: { extraPages: [] } })).toMatchObject({
      username: 'u-1',
      addGroups: GRANT_GROUPS,
      addExtraPages: ['billingRelease', 'aljexSignoff'],
    })
  })

  it('fails loudly instead of inventing the user when she is absent', () => {
    const plan = planGrant({ found: usersWithEmail([user('a', 'other@x.test')], 'Jenny@bcatcorp.com'), currentGroups: [], profile: null })
    expect(plan.error).toMatch(/no staff Cognito user/)
    expect(plan.addGroups).toBeUndefined()
  })

  it('refuses an ambiguous match and adds only what is missing', () => {
    expect(planGrant({ found: [user('a', 'j@x'), user('b', 'j@x')], currentGroups: [], profile: null }).error).toMatch(/refusing to guess/)
    expect(planGrant({ found: [user('a', 'j@x')], currentGroups: ['page-billingRelease'], profile: { extraPages: ['billingRelease'] } }))
      .toMatchObject({ addGroups: ['page-aljexSignoff'], addExtraPages: ['aljexSignoff'] })
  })
})
