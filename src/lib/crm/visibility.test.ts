import { describe, expect, it } from 'vitest'
import { promotionFor } from './promote'
import { ownerOf } from './owner'
import { canSeeAccount, canSeeEmailDetail, canSeeSpotRequest, viewerFromGroups } from './visibility'

const rep = viewerFromGroups({ id: 'rep1', email: 'rep1@bcatcorp.com', groups: ['role-CUSTOMER_REP', 'page-customers'] })
const manager = viewerFromGroups({ id: 'm1', email: 'm@bcatcorp.com', groups: ['role-MANAGER'] })
const admin = viewerFromGroups({ id: 'a1', email: 'a@bcatcorp.com', groups: ['ADMIN'] })
const owner = viewerFromGroups({ id: 'o1', email: 'ryne@bcatcorp.com', groups: [] })

describe('visibility matrix (AB-plan §8.3)', () => {
  const mine = { accountOwnerIds: ['rep1'] }
  const theirs = { accountOwnerIds: ['rep2'] }
  const viaDefault = { defaultSalesRepId: 'rep1' }
  const unowned = {}

  it.each([
    ['rep', rep, [true, false, true, true]],
    ['manager', manager, [true, true, true, true]],
    ['admin', admin, [true, true, true, true]],
    ['owner', owner, [true, true, true, true]],
  ])('accounts: %s', (_n, viewer, [m, t, d, u]) => {
    expect([canSeeAccount(viewer, mine), canSeeAccount(viewer, theirs), canSeeAccount(viewer, viaDefault), canSeeAccount(viewer, unowned)]).toEqual([m, t, d, u])
  })

  it('spot requests and e-mail detail: owning rep, manager, ADMIN only', () => {
    expect(canSeeSpotRequest(rep, { userId: 'rep1' })).toBe(true)
    expect(canSeeSpotRequest(rep, { userId: 'rep2' })).toBe(false)
    expect(canSeeSpotRequest(manager, { userId: 'rep2' })).toBe(true)
    expect(canSeeEmailDetail(rep, { ownerId: 'rep2' })).toBe(false)
    expect(canSeeEmailDetail(admin, { ownerId: 'rep2' })).toBe(true)
  })
})

describe('ownerOf', () => {
  it('prefers the primary of accountOwnerIds over the default rep', () => {
    expect(ownerOf({ accountOwnerIds: ['p', 'q'], defaultSalesRepId: 'd' })).toBe('p')
    expect(ownerOf({ accountOwnerIds: [], defaultSalesRepId: 'd' })).toBe('d')
    expect(ownerOf({})).toBeNull()
  })
})

describe('promotionFor (AB-plan §5.5)', () => {
  it.each([
    ['NEW', 'PROMOTE'], ['CONTACTED', 'PROMOTE'], ['QUALIFIED', 'PROMOTE'], ['QUOTED', 'PROMOTE'], ['NURTURING', 'PROMOTE'],
    ['ACTIVE', 'ALREADY_ACTIVE'], [null, 'ALREADY_ACTIVE'], [undefined, 'ALREADY_ACTIVE'],
    ['PENDING', 'REFUSE'], ['BLOCKED', 'REFUSE'], ['CLOSED', 'REFUSE'], ['DORMANT', 'REFUSE'],
  ])('%s -> %s', (status, expected) => {
    expect(promotionFor(status)).toBe(expected)
  })
})
