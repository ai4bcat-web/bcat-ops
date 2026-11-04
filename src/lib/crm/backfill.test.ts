import { describe, expect, it } from 'vitest'
import { planCrmBackfill, type BackfillCustomer } from './backfill'

const none = { accountIds: [], contactIds: [], domainIds: [] }
const cust = (id: string, extra: Partial<BackfillCustomer> = {}): BackfillCustomer => ({ id, ...extra })

describe('planCrmBackfill', () => {
  const customers = [
    cust('c1', {
      accountOwnerIds: ['rep1'],
      contacts: [{ name: 'Jane', email: 'Jane@zz-acme.test' }, { name: 'G', email: 'g@gmail.com' }],
      billingEmail: 'ap@zz-acme.test, ap@zz-acme.test',
      website: 'https://www.zz-acme.test',
    }),
    cust('c2', { contacts: [{ email: 'a@zz-3pl.test' }], website: 'zz-3pl.test' }),
    cust('c3', { contacts: [{ email: 'b@zz-3pl.test' }, { email: 'jane@zz-acme.test' }] }),
    cust('c4', { contacts: [{ email: 'x@coupa.com' }, { email: 'me@bcatcorp.com' }] }),
  ]

  it('creates an account per customer, contacts for unshared addresses, and conflict-marked shared domains', () => {
    const plan = planCrmBackfill(customers, none)
    expect(plan.accounts).toEqual(['c1', 'c2', 'c3', 'c4'])
    const ids = plan.contacts.map((c) => c.id).sort()
    expect(ids).not.toContain('jane@zz-acme.test') // on two customers: ambiguous, not assigned
    expect(ids).toContain('g@gmail.com')
    expect(plan.contacts.find((c) => c.id === 'ap@zz-acme.test')).toMatchObject({ customerId: 'c1', ownerId: 'rep1', source: 'BACKFILL' })
    const shared = plan.domains.find((d) => d.id === 'zz-acme.test')
    expect(shared).toMatchObject({ conflict: true, customerId: null })
    expect(shared?.conflictCustomerIds.sort()).toEqual(['c1', 'c3'])
    expect(plan.domains.find((d) => d.id === 'zz-3pl.test')).toMatchObject({ conflict: true })
    expect(plan.domains.map((d) => d.id)).not.toEqual(expect.arrayContaining(['gmail.com', 'coupa.com', 'bcatcorp.com']))
  })

  it('never re-plans rows that already exist, so a manual claim survives and a re-run is a no-op', () => {
    const first = planCrmBackfill(customers, none)
    const again = planCrmBackfill(customers, {
      accountIds: first.accounts,
      contactIds: first.contacts.map((c) => c.id),
      domainIds: first.domains.map((d) => d.id),
    })
    expect(again.accounts).toEqual([])
    expect(again.contacts).toEqual([])
    expect(again.domains).toEqual([])
    const manual = planCrmBackfill(customers, { ...none, domainIds: ['zz-acme.test'] })
    expect(manual.domains.find((d) => d.id === 'zz-acme.test')).toBeUndefined()
  })

  it('claims a single-customer domain for that customer', () => {
    const plan = planCrmBackfill([cust('c9', { website: 'https://zz-solo.test/x' })], none)
    expect(plan.domains).toEqual([{ id: 'zz-solo.test', customerId: 'c9', source: 'WEBSITE', conflict: false, conflictCustomerIds: [] }])
  })
})
