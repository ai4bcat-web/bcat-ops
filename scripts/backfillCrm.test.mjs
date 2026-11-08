import { describe, it, expect } from 'vitest';
import { DEV_TABLE_SUFFIX, PRODUCTION_SUFFIX_FRAGMENT, applyPlan, planCrmBackfill, resolveTarget, registrableDomain } from './backfillCrm.mjs';
import { planCrmBackfill as planTs } from '../src/lib/crm/backfill';
import { registrableDomain as registrableTs } from '../src/lib/crm/domains';

const customers = [
  { id: 'c1', accountOwnerIds: ['rep1'], contacts: [{ name: 'Jane', email: 'Jane@zz-acme.test' }, { email: 'g@gmail.com' }], billingEmail: 'ap@zz-acme.test; Bob <bob@zz-acme.test>', website: 'https://www.zz-acme.test' },
  { id: 'c2', defaultSalesRepId: 'rep2', contacts: [{ email: 'a@zz-3pl.test' }], website: 'zz-3pl.test' },
  { id: 'c3', contacts: [{ email: 'b@zz-3pl.test' }, { email: 'jane@zz-acme.test' }] },
  { id: 'c4', contacts: [{ email: 'x@coupa.com' }, { email: 'me@bcatcorp.com' }, { email: 'edi@ediserv.com' }] },
  { id: 'c5', website: 'https://shop.zz-solo.co.uk/x' },
];
const none = { accountIds: [], contactIds: [], domainIds: [] };

describe('backfillCrm mirror', () => {
  it('plans exactly what the TypeScript planner plans', () => {
    expect(planCrmBackfill(customers, none)).toEqual(planTs(customers, none));
    const partial = { accountIds: ['c1'], contactIds: ['ap@zz-acme.test'], domainIds: ['zz-3pl.test'] };
    expect(planCrmBackfill(customers, partial)).toEqual(planTs(customers, partial));
  });

  it.each(['a@mail.zz-acme.test', 'https://www.acme.co.uk/x', 'x.com', 'bad', 'u@shop.acme.com.au'])('registrableDomain(%s) matches', (input) => {
    expect(registrableDomain(input)).toBe(registrableTs(input));
  });
});

describe('backfillCrm safety', () => {
  it('refuses the production suffix and defaults to dev', () => {
    expect(() => resolveTarget(`x-${PRODUCTION_SUFFIX_FRAGMENT}-NONE`)).toThrow(/production/);
    expect(resolveTarget(undefined)).toEqual({ suffix: DEV_TABLE_SUFFIX, environment: 'dev' });
  });

  it('apply never overwrites an existing row and a re-apply creates nothing', async () => {
    const store = new Map();
    const doc = {
      async send(cmd) {
        const { TableName, Item } = cmd.input;
        if (store.has(`${TableName}|${Item.id}`) && cmd.input.ConditionExpression) {
          throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
        }
        store.set(`${TableName}|${Item.id}`, Item);
        return {};
      },
    };
    const manual = { id: 'zz-acme.test', customerId: 'MANUAL' };
    store.set('CrmDomain-s|zz-acme.test', manual);
    const plan = planCrmBackfill(customers, { accountIds: [], contactIds: [], domainIds: ['zz-acme.test'] });
    const first = await applyPlan({ doc, plan, suffix: 's' });
    expect(first.accounts).toBe(5);
    expect(store.get('CrmDomain-s|zz-acme.test')).toBe(manual);
    expect(store.get('CrmDomain-s|zz-3pl.test')).toMatchObject({ conflict: true, conflictCustomerIds: ['c2', 'c3'] });
    expect(store.get('CrmDomain-s|zz-3pl.test').customerId).toBeUndefined();
    const second = await applyPlan({ doc, plan, suffix: 's' });
    expect(second).toEqual({ accounts: 0, contacts: 0, domains: 0 });
  });
});
