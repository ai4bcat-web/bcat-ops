import { beforeEach, describe, expect, it } from 'vitest'
import { CrmFakeDb } from './crmFakeDb'
import { addSystemActivity, claimDomain, lookupSender, purgeEmailSubjects, touch, upsertContact } from './crmStore'

const T = { contact: 'Contact', domain: 'Domain', activity: 'Activity', account: 'Account' }
let db: CrmFakeDb

beforeEach(() => {
  process.env.CRM_CONTACT_TABLE_NAME = T.contact
  process.env.CRM_DOMAIN_TABLE_NAME = T.domain
  process.env.CRM_ACTIVITY_TABLE_NAME = T.activity
  process.env.CRM_ACCOUNT_TABLE_NAME = T.account
  db = new CrmFakeDb()
})

describe('touch', () => {
  it('uses max(at): a back-dated entry does not move last touch backwards', async () => {
    expect(await touch(db, { customerId: 'c1', kind: 'CALL', at: '2026-11-03T10:00:00.000Z', by: 'u1' })).toBe(true)
    expect(await touch(db, { customerId: 'c1', kind: 'NOTE', at: '2026-10-01T10:00:00.000Z', by: 'u2' })).toBe(false)
    expect(db.get(T.account, 'c1')).toMatchObject({ lastTouchAt: '2026-11-03T10:00:00.000Z', lastTouchKind: 'CALL', lastTouchBy: 'u1' })
    expect(await touch(db, { customerId: 'c1', kind: 'TEXT', at: '2026-11-04T10:00:00.000Z', by: 'u2' })).toBe(true)
    expect(db.get(T.account, 'c1')?.lastTouchKind).toBe('TEXT')
  })
})

describe('upsertContact', () => {
  it('is idempotent by address, normalises it, and keeps one row', async () => {
    await upsertContact(db, { email: 'Jane <JANE@zz-acme.test>', customerId: 'c1', name: 'Jane', ownerId: 'u1', source: 'SPOT_REQUEST' })
    const again = await upsertContact(db, { email: 'jane@zz-acme.test', customerId: 'c2', ownerId: 'u2', source: 'MANUAL' })
    expect(db.rows(T.contact)).toHaveLength(1)
    expect(again).toMatchObject({ id: 'jane@zz-acme.test', customerId: 'c2', name: 'Jane', source: 'SPOT_REQUEST' })
  })

  it('refuses an invalid address', async () => {
    await expect(upsertContact(db, { email: 'nope', ownerId: 'u1', source: 'MANUAL' })).rejects.toThrow(/valid e-mail/)
  })
})

describe('addSystemActivity', () => {
  it('writes the row, touches the account, and keeps the subject only on e-mail kinds', async () => {
    await addSystemActivity(db, { customerId: 'c1', contactEmail: 'A@x.test', ownerId: 'u1', kind: 'EMAIL_IN', at: '2026-11-03T10:00:00.000Z', subject: 'S'.repeat(300), refs: { spotRequestId: 'sr:u1:m1' } })
    await addSystemActivity(db, { customerId: 'c1', ownerId: 'u1', kind: 'QUOTE_DRAFTED', at: '2026-11-03T11:00:00.000Z', subject: 'ignored', refs: { quoteId: 'q1' } })
    const rows = db.rows(T.activity)
    const mail = rows.find((r) => r.kind === 'EMAIL_IN')
    expect(mail).toMatchObject({ direction: 'IN', contactEmail: 'a@x.test' })
    expect((mail?.subject as string).length).toBe(120)
    expect(JSON.parse(mail?.refs as string)).toEqual({ spotRequestId: 'sr:u1:m1' })
    expect(rows.find((r) => r.kind === 'QUOTE_DRAFTED')?.subject).toBeUndefined()
    expect(db.get(T.account, 'c1')).toMatchObject({ lastTouchKind: 'QUOTE_DRAFTED' })
  })

  it('stores an activity with no customer and touches nothing', async () => {
    await addSystemActivity(db, { ownerId: 'u1', kind: 'EMAIL_IN', at: '2026-11-03T10:00:00.000Z', refs: {} })
    expect(db.rows(T.activity)).toHaveLength(1)
    expect(db.rows(T.account)).toHaveLength(0)
  })
})

describe('lookupSender', () => {
  it('finds an exact contact, then a domain claim, then nothing', async () => {
    await upsertContact(db, { email: 'jane@zz-acme.test', customerId: 'c1', ownerId: 'u1', source: 'MANUAL' })
    await claimDomain(db, { domain: 'zz-acme.test', customerId: 'c2', by: 'u1', source: 'MANUAL' })
    expect((await lookupSender(db, 'jane@zz-acme.test')).how).toBe('EMAIL')
    expect(await lookupSender(db, 'bob@mail.zz-acme.test')).toMatchObject({ how: 'DOMAIN', customerId: 'c2' })
    expect((await lookupSender(db, 'bob@elsewhere.test')).how).toBe('NONE')
  })
})

describe('claimDomain', () => {
  it('refuses to steal a held domain unless forced, and is idempotent for the holder', async () => {
    expect(await claimDomain(db, { domain: 'zz-acme.test', customerId: 'c1', by: 'u1', source: 'MANUAL' })).toMatchObject({ ok: true })
    expect(await claimDomain(db, { domain: 'zz-acme.test', customerId: 'c1', by: 'u1', source: 'MANUAL' })).toMatchObject({ ok: true, forced: false })
    expect(await claimDomain(db, { domain: 'zz-acme.test', customerId: 'c2', by: 'u2', source: 'MANUAL' })).toEqual({ ok: false, heldBy: 'c1' })
    expect(db.get(T.domain, 'zz-acme.test')?.customerId).toBe('c1')
    expect(await claimDomain(db, { domain: 'zz-acme.test', customerId: 'c2', by: 'm1', source: 'MANUAL', force: true })).toMatchObject({ ok: true, forced: true })
    expect(db.get(T.domain, 'zz-acme.test')?.customerId).toBe('c2')
  })

  it('treats a conflicted domain as held', async () => {
    db.seed(T.domain, { id: 'x.test', conflict: true, conflictCustomerIds: ['a', 'b'] })
    expect(await claimDomain(db, { domain: 'x.test', customerId: 'c', by: 'u', source: 'MANUAL' })).toMatchObject({ ok: false })
  })
})

describe('purgeEmailSubjects', () => {
  it('blanks only that rep\'s e-mail subjects', async () => {
    await addSystemActivity(db, { customerId: 'c1', ownerId: 'u1', kind: 'EMAIL_IN', at: '2026-11-03T10:00:00.000Z', subject: 'mine', refs: {} })
    await addSystemActivity(db, { customerId: 'c1', ownerId: 'u2', kind: 'EMAIL_IN', at: '2026-11-03T10:00:00.000Z', subject: 'theirs', refs: {} })
    expect(await purgeEmailSubjects(db, 'u1')).toBe(1)
    const subjects = db.rows(T.activity).map((r) => [r.ownerId, r.subject])
    expect(subjects).toContainEqual(['u1', undefined])
    expect(subjects).toContainEqual(['u2', 'theirs'])
  })
})
