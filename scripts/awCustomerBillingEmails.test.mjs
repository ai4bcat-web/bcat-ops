import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, applyOne, billingEmailsGate, buildReport } from './awCustomerBillingEmails.mjs';
import { groupCompanies, normKey, normMc, planBillingEmails, prepareRows } from './lib/billingEmailsPlan.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { DEV_SUFFIX } from './lib/prodGate.mjs';

const row = (o) => ({ name: 'X', mcNumber: '', billingEmail: '', ...o });
const cust = (o = {}) => ({ id: 'c1', name: 'Zipline Logistics', billingMethod: 'MANUAL', ...o });

describe('normalizers', () => {
  it('drops case, punctuation, parenthetical notes and trailing company-type words', () => {
    expect(normKey('ZIPLINE LOGISTICS LLC')).toBe('ziplinelogistics');
    expect(normKey('ALLY LOGISTICS LLC (Grand Rapids, MI)')).toBe('allylogistics');
    expect(normKey('"ICAT LOGISTICS, INC"')).toBe('icatlogistics');
    expect(normKey('CO')).toBe('co');
    expect(normMc('MC 0012345')).toBe('12345');
  });
});

describe('prepareRows', () => {
  it('drops blank, test, settlements and bcatcorp rows and lowercases addresses', () => {
    const r = prepareRows([row({ name: 'A', billingEmail: 'AP@A.com' }), row({ name: 'B' }), row({ name: 'Jenny Test Custy - Ivan Cartage', billingEmail: 'j@x.com' }), row({ name: 'CARRIER SETTLEMENTS', billingEmail: 's@x.com' }), row({ name: 'C', billingEmail: 'ivanfactoring@bcatcorp.com' })]);
    expect(r.rows.map((x) => [x.name, x.emails])).toEqual([['A', ['ap@a.com']]]);
    expect(r.blankRows).toBe(1);
    expect(r.skipped).toHaveLength(2);
    expect(r.bcatInternal).toEqual(['C']);
  });
});

describe('groupCompanies', () => {
  it('merges name variants and an MC link; flags conflicting addresses', () => {
    const g = groupCompanies(prepareRows([row({ name: 'Zipline Logistics', mcNumber: '600879', billingEmail: 'p@z.com' }), row({ name: 'ZIPLINE LOGISTICS LLC', billingEmail: 'p@z.com' }), row({ name: 'Foo', billingEmail: 'a@f.com' }), row({ name: 'FOO INC', billingEmail: 'b@f.com' })]).rows);
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.keys.has('ziplinelogistics')).conflict).toBe(false);
    expect(g.find((x) => x.keys.has('foo')).conflict).toBe(true);
  });
});

describe('planBillingEmails', () => {
  const prep = (rows) => prepareRows(rows);
  const status = (customers, rows) => planBillingEmails(customers, prep(rows)).results.map((r) => r.status);
  it('fills a blank, matched by exact normalized name', () => {
    expect(status([cust()], [row({ name: 'ZIPLINE LOGISTICS LLC', billingEmail: 'p@z.com' })])).toEqual(['FILL']);
  });
  it('matches by MC number before name', () => {
    const p = planBillingEmails([cust({ name: 'Other Name', mcNumber: '600879' })], prep([row({ name: 'Zipline', mcNumber: '600879', billingEmail: 'p@z.com' })]));
    expect(p.results[0].status).toBe('FILL');
  });
  it('never overwrites; reports same vs differs', () => {
    expect(status([cust({ apEmail: 'P@Z.com' })], [row({ name: 'Zipline Logistics', billingEmail: 'p@z.com' })])).toEqual(['SAME_EMAIL']);
    expect(status([cust({ apEmail: 'old@z.com' })], [row({ name: 'Zipline Logistics', billingEmail: 'p@z.com' })])).toEqual(['DIFFERS']);
  });
  it('lists FACTOR customers, conflicts, ambiguous and unmatched without writing', () => {
    expect(status([cust({ billingMethod: 'FACTOR' })], [row({ name: 'Zipline Logistics', billingEmail: 'p@z.com' })])).toEqual(['FACTOR_CUSTOMER']);
    expect(status([cust()], [row({ name: 'Zipline Logistics', billingEmail: 'a@z.com' }), row({ name: 'ZIPLINE LOGISTICS LLC', billingEmail: 'b@z.com' })])).toEqual(['CONFLICT']);
    expect(status([cust(), cust({ id: 'c2', name: 'ZIPLINE LOGISTICS INC' })], [row({ name: 'Zipline Logistics', billingEmail: 'p@z.com' })])).toEqual(['AMBIGUOUS']);
    expect(status([cust()], [row({ name: 'Nobody', billingEmail: 'n@n.com' })])).toEqual(['UNMATCHED']);
  });
  it('ignores merged / inactive customers and flags notice addresses and unset billing method', () => {
    expect(status([cust({ active: false })], [row({ name: 'Zipline Logistics', billingEmail: 'p@z.com' })])).toEqual(['UNMATCHED']);
    const p = planBillingEmails([cust({ billingMethod: null })], prep([row({ name: 'Zipline Logistics', billingEmail: 'zip@noa.triumphpay.com' })]));
    expect(p.results[0].flags).toEqual(['NOTICE_ADDRESS', 'BILLING_METHOD_UNSET']);
  });
  it('report counts', () => {
    const rows = [row({ name: 'Zipline Logistics', billingEmail: 'p@z.com' })];
    const prepared = prep(rows);
    expect(buildReport({ prepared, plan: planBillingEmails([cust()], prepared), rowCount: 1, today: '2026-11-12' })).toContain('WOULD FILL apEmail (blank today): 1');
  });
});

describe('applyOne', () => {
  it('writes apEmail only, conditional on blank + not FACTOR, plus one audit row', async () => {
    const calls = [];
    const doc = { send: async (c) => { calls.push(c.input); return {}; } };
    const r = await applyOne({ doc, suffix: DEV_SUFFIX, customer: { id: 'c1' }, email: 'p@z.com' }).catch((e) => e);
    if (r instanceof Error) throw r;
    expect(r.written).toBe(1);
    expect(calls[0].UpdateExpression).toBe('SET apEmail = :v');
    expect(calls[0].ConditionExpression).toContain('billingMethod <> :factor');
    expect(calls[1].Item.action).toBe(AUDIT_ACTION);
  });
  it('is registered for backup and gated', async () => {
    expect(PROD_WRITE_SETS.awCustomerBillingEmails.models).toEqual(['Customer', 'AuditLog']);
    expect(resolveScripts('awCustomerBillingEmails')).toEqual(['awCustomerBillingEmails']);
    expect(typeof billingEmailsGate).toBe('function');
  });
});
