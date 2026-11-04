import { beforeEach, describe, expect, it } from 'vitest'
import { CrmFakeDb } from '../_shared/crmFakeDb'
import { addSystemActivity } from '../_shared/crmStore'
import { authorize, dispatch, type AppSyncIdentity } from './actions'

const T = {
  customer: 'Customer', quote: 'Quote', shipment: 'Shipment', user: 'User', audit: 'Audit',
  contact: 'Contact', domain: 'Domain', activity: 'Activity', account: 'Account',
}

function id(username: string, groups: string[], email = `${username}@bcatcorp.com`): AppSyncIdentity {
  return { username, sub: username, claims: { email, 'cognito:groups': groups } }
}
const rep1 = id('rep1', ['role-CUSTOMER_REP', 'page-customers'])
const rep2 = id('rep2', ['role-CUSTOMER_REP', 'page-customers'])
const manager = id('m1', ['role-MANAGER', 'page-customers'])

let db: CrmFakeDb
const call = (identity: AppSyncIdentity, action: string, input: unknown = {}) => dispatch(action, input, identity, db)

beforeEach(() => {
  process.env.CUSTOMER_TABLE_NAME = T.customer
  process.env.QUOTE_TABLE_NAME = T.quote
  process.env.SHIPMENT_TABLE_NAME = T.shipment
  process.env.USER_PROFILE_TABLE_NAME = T.user
  process.env.AUDIT_LOG_TABLE_NAME = T.audit
  process.env.CRM_CONTACT_TABLE_NAME = T.contact
  process.env.CRM_DOMAIN_TABLE_NAME = T.domain
  process.env.CRM_ACTIVITY_TABLE_NAME = T.activity
  process.env.CRM_ACCOUNT_TABLE_NAME = T.account
  db = new CrmFakeDb()
  db.seed(T.customer, { id: 'c-mine', name: 'Mine Co', status: 'ACTIVE', accountOwnerIds: ['rep1'] })
  db.seed(T.customer, { id: 'c-theirs', name: 'Theirs Co', status: 'NEW', accountOwnerIds: ['rep2'] })
  db.seed(T.customer, { id: 'c-free', name: 'Unowned Co', status: 'ACTIVE' })
  db.seed(T.user, { id: 'rep1', name: 'Rep One', email: 'rep1@bcatcorp.com' })
  db.seed(T.user, { id: 'rep2', name: 'Rep Two', email: 'rep2@bcatcorp.com' })
})

describe('authorization', () => {
  it('refuses a caller with no page group and an unknown action', async () => {
    await expect(call(id('x', ['role-DRIVER']), 'CRM_LIST_ACCOUNTS')).rejects.toThrow(/Forbidden/)
    await expect(call(rep1, 'CRM_NOPE')).rejects.toThrow(/Unknown action/)
  })
})

describe('visibility enforcement', () => {
  it('reps see their own and unowned accounts; managers see all', async () => {
    const ids = async (who: AppSyncIdentity, input = {}) =>
      ((await call(who, 'CRM_LIST_ACCOUNTS', input)) as { rows: { customerId: string }[] }).rows.map((r) => r.customerId).sort()
    expect(await ids(rep1)).toEqual(['c-free', 'c-mine'])
    expect(await ids(rep1, { scope: 'all' })).toEqual(['c-free', 'c-mine'])
    expect(await ids(manager)).toEqual(['c-free', 'c-mine', 'c-theirs'])
    expect(await ids(manager, { scope: 'mine' })).toEqual([])
  })

  it('returns an empty invisible view, and refuses every write, on another rep\'s account', async () => {
    expect(await call(rep1, 'CRM_GET_ACCOUNT', { customerId: 'c-theirs' })).toMatchObject({ visible: false, timeline: [], contacts: [] })
    for (const [action, input] of [
      ['CRM_ADD_ACTIVITY', { customerId: 'c-theirs', kind: 'NOTE', summary: 'x' }],
      ['CRM_ADD_TASK', { customerId: 'c-theirs', summary: 'x', dueAt: '2026-12-01' }],
      ['CRM_SET_NEXT_STEP', { customerId: 'c-theirs', nextStep: 'x' }],
      ['CRM_UPSERT_CONTACT', { customerId: 'c-theirs', email: 'a@x.test' }],
      ['CRM_CLAIM_DOMAIN', { customerId: 'c-theirs', domain: 'x.test' }],
    ] as const) {
      await expect(call(rep1, action, input)).rejects.toThrow(/not found/)
    }
    expect(db.rows(T.activity)).toHaveLength(0)
  })

  it('shows e-mail subjects only to the owning rep and managers', async () => {
    await addSystemActivity(db, { customerId: 'c-free', ownerId: 'rep2', kind: 'EMAIL_IN', at: '2026-11-03T10:00:00.000Z', subject: 'Private subject', refs: {} })
    const emailOf = async (who: AppSyncIdentity) =>
      ((await call(who, 'CRM_GET_ACCOUNT', { customerId: 'c-free' })) as { timeline: { kind: string; subject?: string | null; restricted?: boolean }[] }).timeline.find((e) => e.kind === 'EMAIL_IN')
    expect(await emailOf(rep1)).toMatchObject({ subject: null, restricted: true })
    expect(await emailOf(rep2)).toMatchObject({ subject: 'Private subject' })
    expect(await emailOf(manager)).toMatchObject({ subject: 'Private subject' })
  })
})

describe('activity, tasks, next step', () => {
  it('a back-dated note does not move last touch back', async () => {
    await call(rep1, 'CRM_ADD_ACTIVITY', { customerId: 'c-mine', kind: 'CALL', summary: 'spoke', at: '2026-11-03T10:00:00Z' })
    await call(rep1, 'CRM_ADD_ACTIVITY', { customerId: 'c-mine', kind: 'NOTE', summary: 'old', at: '2026-09-01T10:00:00Z' })
    const view = (await call(rep1, 'CRM_GET_ACCOUNT', { customerId: 'c-mine' })) as {
      account: { lastTouchAt: string; lastTouchKind: string }
      timeline: { kind: string }[]
    }
    expect(view.account).toMatchObject({ lastTouchAt: '2026-11-03T10:00:00.000Z', lastTouchKind: 'CALL' })
    expect(view.timeline.map((e) => e.kind)).toEqual(['CALL', 'NOTE'])
  })

  it('rejects a system kind and an empty summary', async () => {
    await expect(call(rep1, 'CRM_ADD_ACTIVITY', { customerId: 'c-mine', kind: 'EMAIL_IN', summary: 'x' })).rejects.toThrow(/kind/)
    await expect(call(rep1, 'CRM_ADD_ACTIVITY', { customerId: 'c-mine', kind: 'NOTE', summary: '  ' })).rejects.toThrow(/summary/)
  })

  it('tracks open tasks through add and complete, and complete is idempotent and restricted', async () => {
    const { activity } = (await call(rep1, 'CRM_ADD_TASK', { customerId: 'c-mine', summary: 'Send rates', dueAt: '2026-11-05' })) as { activity: { id: string; assigneeId: string } }
    expect(activity.assigneeId).toBe('rep1')
    expect(db.get(T.account, 'c-mine')?.openTaskCount).toBe(1)
    await expect(call(rep2, 'CRM_COMPLETE_TASK', { id: activity.id })).rejects.toThrow(/not found/)
    await call(rep1, 'CRM_COMPLETE_TASK', { id: activity.id })
    await call(rep1, 'CRM_COMPLETE_TASK', { id: activity.id })
    expect(db.get(T.account, 'c-mine')?.openTaskCount).toBe(0)
    const view = (await call(rep1, 'CRM_GET_ACCOUNT', { customerId: 'c-mine' })) as { openTasks: unknown[] }
    expect(view.openTasks).toHaveLength(0)
  })

  it('sets and clears the next step', async () => {
    const set = (await call(rep1, 'CRM_SET_NEXT_STEP', { customerId: 'c-mine', nextStep: 'Call Jane', nextStepDueAt: '2026-11-10' })) as { account: Record<string, unknown> }
    expect(set.account).toMatchObject({ nextStep: 'Call Jane', nextStepDueAt: '2026-11-10T00:00:00.000Z', nextStepBy: 'rep1' })
    const cleared = (await call(rep1, 'CRM_SET_NEXT_STEP', { customerId: 'c-mine', nextStep: '' })) as { account: Record<string, unknown> }
    expect(cleared.account.nextStep).toBeUndefined()
    expect(cleared.account.nextStepDueAt).toBeUndefined()
  })
})

describe('follow-ups', () => {
  it('selects due-within-7-days items, overdue first, and keeps reps to their own work', async () => {
    const day = 86_400_000
    const iso = (offset: number) => new Date(Date.now() + offset * day).toISOString()
    db.seed(T.account, { id: 'c-mine', nextStep: 'Soon', nextStepDueAt: iso(3), nextStepBy: 'rep1' })
    db.seed(T.account, { id: 'c-free', nextStep: 'Late', nextStepDueAt: iso(-2), nextStepBy: 'rep1' })
    db.seed(T.account, { id: 'c-theirs', nextStep: 'Not mine', nextStepDueAt: iso(1), nextStepBy: 'rep2' })
    db.seed(T.account, { id: 'c-later', nextStep: 'Far', nextStepDueAt: iso(30) })
    await call(rep1, 'CRM_ADD_TASK', { customerId: 'c-mine', summary: 'Mine task', dueAt: iso(2), assigneeId: 'rep1' })
    await call(rep2, 'CRM_ADD_TASK', { customerId: 'c-theirs', summary: 'Rep2 task', dueAt: iso(2) })

    const mine = ((await call(rep1, 'CRM_LIST_FOLLOWUPS', { scope: 'mine' })) as { rows: { customerId: string; overdue: boolean; openTasks: unknown[] }[] }).rows
    expect(mine.map((r) => r.customerId)).toEqual(['c-free', 'c-mine'])
    expect(mine[0].overdue).toBe(true)
    expect(mine[1].openTasks).toHaveLength(1)

    const all = ((await call(manager, 'CRM_LIST_FOLLOWUPS', { scope: 'all' })) as { rows: { customerId: string }[] }).rows
    expect(all.map((r) => r.customerId).sort()).toEqual(['c-free', 'c-mine', 'c-theirs'])
  })
})

describe('contacts and domains', () => {
  it('upserts a contact once per address and merges Customer.contacts into the account view', async () => {
    db.seed(T.customer, { id: 'c-json', name: 'Json Co', status: 'ACTIVE', contacts: JSON.stringify([{ name: 'Old', email: 'Old@x.test' }, { name: 'Dup', email: 'dup@x.test' }]) })
    await call(rep1, 'CRM_UPSERT_CONTACT', { customerId: 'c-json', email: 'Dup@x.test', name: 'Dup', title: 'Buyer' })
    await call(rep1, 'CRM_UPSERT_CONTACT', { customerId: 'c-json', email: 'dup@x.test', phone: '555' })
    expect(db.rows(T.contact)).toHaveLength(1)
    const view = (await call(rep1, 'CRM_GET_ACCOUNT', { customerId: 'c-json' })) as { contacts: { id: string; origin: string; title?: string; phone?: string }[] }
    expect(view.contacts.map((c) => [c.id, c.origin]).sort()).toEqual([['dup@x.test', 'BOTH'], ['old@x.test', 'CUSTOMER_JSON']])
    expect(view.contacts.find((c) => c.id === 'dup@x.test')).toMatchObject({ title: 'Buyer', phone: '555' })
  })

  it('claims a domain once; a second customer is refused, only a manager may force, and every force is audited', async () => {
    await call(rep1, 'CRM_CLAIM_DOMAIN', { customerId: 'c-mine', domain: 'mail.zz-acme.test' })
    expect(db.get(T.domain, 'zz-acme.test')?.customerId).toBe('c-mine')
    await expect(call(rep2, 'CRM_CLAIM_DOMAIN', { customerId: 'c-free', domain: 'zz-acme.test' })).rejects.toThrow(/already claimed/)
    await expect(call(rep2, 'CRM_CLAIM_DOMAIN', { customerId: 'c-free', domain: 'zz-acme.test', force: true })).rejects.toThrow(/manager/)
    await call(manager, 'CRM_CLAIM_DOMAIN', { customerId: 'c-free', domain: 'zz-acme.test', force: true })
    expect(db.get(T.domain, 'zz-acme.test')?.customerId).toBe('c-free')
    expect(db.rows(T.audit).map((r) => r.action)).toContain('FORCE_CLAIM_DOMAIN')
  })

  it('refuses free-mail, shared-service and own domains; only managers release', async () => {
    for (const domain of ['gmail.com', 'coupa.com', 'bcatcorp.com']) {
      await expect(call(rep1, 'CRM_CLAIM_DOMAIN', { customerId: 'c-mine', domain })).rejects.toThrow(/cannot be claimed/)
    }
    await call(rep1, 'CRM_CLAIM_DOMAIN', { customerId: 'c-mine', domain: 'zz-acme.test' })
    await expect(call(rep1, 'CRM_CLAIM_DOMAIN', { customerId: 'c-mine', domain: 'zz-acme.test', release: true })).rejects.toThrow(/manager/)
    expect(await call(manager, 'CRM_CLAIM_DOMAIN', { customerId: 'c-mine', domain: 'zz-acme.test', release: true })).toEqual({ removed: true })
    expect(db.get(T.domain, 'zz-acme.test')).toBeUndefined()
  })
})

describe('CRM_ASSIGN_OWNER', () => {
  it('is manager-only, requires a real user, and makes the new owner primary', async () => {
    await expect(call(rep1, 'CRM_ASSIGN_OWNER', { customerId: 'c-mine', ownerId: 'rep2' })).rejects.toThrow(/manager/)
    await expect(call(manager, 'CRM_ASSIGN_OWNER', { customerId: 'c-mine', ownerId: 'ghost' })).rejects.toThrow(/User not found/)
    await call(manager, 'CRM_ASSIGN_OWNER', { customerId: 'c-mine', ownerId: 'rep2' })
    expect(db.get(T.customer, 'c-mine')?.accountOwnerIds).toEqual(['rep2', 'rep1'])
    expect(db.rows(T.audit).map((r) => r.action)).toContain('ASSIGN_OWNER')
  })
})

describe('CRM_BACKFILL', () => {
  it('is ADMIN-only, dry-run by default, and idempotent when applied', async () => {
    db.seed(T.customer, { id: 'c-bf', name: 'BF', status: 'ACTIVE', website: 'https://zz-bf.test', contacts: JSON.stringify([{ email: 'a@zz-bf.test' }]) })
    const admin = id('adm', ['ADMIN'])
    await expect(call(manager, 'CRM_BACKFILL')).rejects.toThrow(/ADMIN/)
    const dry = (await call(admin, 'CRM_BACKFILL')) as { dryRun: boolean; stats: { accountsToCreate: number } }
    expect(dry.dryRun).toBe(true)
    expect(dry.stats.accountsToCreate).toBe(4)
    expect(db.rows(T.account)).toHaveLength(0)
    await call(admin, 'CRM_BACKFILL', { apply: true })
    expect(db.rows(T.account)).toHaveLength(4)
    expect(db.get(T.domain, 'zz-bf.test')).toMatchObject({ customerId: 'c-bf', conflict: false })
    const again = (await call(admin, 'CRM_BACKFILL', { apply: true })) as { created: { accounts: number; contacts: number; domains: number } }
    expect(again.created).toEqual({ accounts: 0, contacts: 0, domains: 0 })
  })
})

describe('authorize caller resolution', () => {
  const token = (groups: string[]) => ({ username: 'abc-1', sub: 'abc-1', claims: { 'cognito:groups': groups } })

  it('an access-token caller with no UserProfile row falls back to the user pool e-mail', async () => {
    const owner = await authorize(token([]), db, async () => 'ryne@bcatcorp.com')
    expect(owner).toMatchObject({ email: 'ryne@bcatcorp.com', isAdmin: true })
  })

  it('refuses when neither the profile nor the pool resolves an e-mail', async () => {
    await expect(authorize(token(['ADMIN']), db, async () => '')).rejects.toThrow(/could not resolve caller email/)
  })
})
