import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, applyExtras, applyNoa, applyOne, billingEmailsGate, buildReport } from './awCustomerBillingEmails.mjs';
import { groupCompanies, isNoticeAddress, normKey, normMc, planBillingEmails, prepareRows } from './lib/billingEmailsPlan.mjs';
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
  it('merges name variants and an MC link; several addresses are primary + extras, POD inboxes split out', () => {
    const g = groupCompanies(prepareRows([row({ name: 'Zipline Logistics', mcNumber: '600879', billingEmail: 'p@z.com' }), row({ name: 'ZIPLINE LOGISTICS LLC', billingEmail: 'p@z.com' }), row({ name: 'Foo', billingEmail: 'a@f.com' }), row({ name: 'FOO INC', billingEmail: 'b@f.com' })]).rows);
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.keys.has('ziplinelogistics')).conflict).toBe(false);
    expect(g.find((x) => x.keys.has('foo')).emails).toEqual(['a@f.com', 'b@f.com']);
    const fls = groupCompanies(prepareRows([row({ name: 'FLS', billingEmail: 'ap@fls.com' }), row({ name: 'FLS INC', billingEmail: 'POD@fls.com' }), row({ name: 'FLS LLC', billingEmail: 'logistics-paperwork@fls.com' })]).rows)[0];
    expect([fls.emails, fls.pod]).toEqual([['ap@fls.com'], ['pod@fls.com', 'logistics-paperwork@fls.com']]);
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
    expect(status([cust(), cust({ id: 'c2', name: 'ZIPLINE LOGISTICS INC' })], [row({ name: 'Zipline Logistics', billingEmail: 'p@z.com' })])).toEqual(['AMBIGUOUS']);
    expect(status([cust()], [row({ name: 'Nobody', billingEmail: 'n@n.com' })])).toEqual(['UNMATCHED']);
  });
  it('ignores merged / inactive customers and flags notice addresses and unset billing method', () => {
    expect(status([cust({ active: false })], [row({ name: 'Zipline Logistics', billingEmail: 'p@z.com' })])).toEqual(['UNMATCHED']);
    const p = planBillingEmails([cust({ billingMethod: null })], prep([row({ name: 'Zipline Logistics', billingEmail: 'ap@z.com' })]));
    expect(p.results[0].flags).toEqual(['BILLING_METHOD_UNSET']);
  });
  it('keeps notice-of-assignment addresses out of apEmail', () => {
    for (const a of ['x@noa.triumphpay.com', 'NOA@fitzmark.com', 'kofnoa@otrsolutions.com', 'Factor@shipqueen.com', 'factornotice@modetransportation.com', 'FactoringInvoices_NOA_ONLY@hdships.com', 'NOALOR@Spotinc.com', 'tlfactoring@bluegracegroup.com', 'apfactor@allenlund.com', 'support@payments.tfin.com', 'noa@relaypayments.com']) expect(isNoticeAddress(a.toLowerCase())).toBe(true);
    for (const a of ['ap@z.com', 'accounting@factorylogistics.com']) expect(isNoticeAddress(a)).toBe(false);
    const only = planBillingEmails([cust()], prep([row({ name: 'Zipline Logistics', billingEmail: 'zip@noa.triumphpay.com' })])).results[0];
    expect(only.status).toBe('NOA_ONLY');
    expect(only.company.noa).toEqual(['zip@noa.triumphpay.com']);
    const both = planBillingEmails([cust()], prep([row({ name: 'Zipline Logistics', billingEmail: 'zip@noa.triumphpay.com ap@z.com' })])).results[0];
    expect([both.status, both.email, both.company.noa]).toEqual(['FILL', 'ap@z.com', ['zip@noa.triumphpay.com']]);
  });
  it('puts the first AP address in apEmail and appends the others to apEmailsExtra, never removing or repeating', () => {
    const two = [row({ name: 'Zipline Logistics', billingEmail: 'a@z.com' }), row({ name: 'ZIPLINE LOGISTICS LLC', billingEmail: 'b@z.com' })];
    const fill = planBillingEmails([cust()], prep(two)).results[0];
    expect([fill.status, fill.email, fill.extrasAdded]).toEqual(['FILL', 'a@z.com', ['b@z.com']]);
    const same = planBillingEmails([cust({ apEmail: 'A@z.com', apEmailsExtra: ['keep@z.com', 'b@z.com'] })], prep(two)).results[0];
    expect([same.status, same.extrasAdded]).toEqual(['SAME_EMAIL', []]);
    const add = planBillingEmails([cust({ apEmail: 'a@z.com', apEmailsExtra: ['keep@z.com'] })], prep([...two, row({ name: 'Zipline Logistics Inc', billingEmail: 'c@z.com' })])).results[0];
    expect([add.status, add.extrasAdded, add.extrasBefore]).toEqual(['SAME_EMAIL', ['b@z.com', 'c@z.com'], ['keep@z.com']]);
    const differs = planBillingEmails([cust({ apEmail: 'other@z.com' })], prep(two)).results[0];
    expect([differs.status, differs.extrasAdded]).toEqual(['DIFFERS', undefined]);
    expect(planBillingEmails([cust()], prep([row({ name: 'Zipline Logistics', billingEmail: 'pod@z.com' })])).results[0].status).toBe('POD_ONLY');
  });
  it('plans noaEmail writes for blank, single-address, unambiguous matches only (any billing method)', () => {
    const noaRow = (name, e) => row({ name, billingEmail: e });
    const one = planBillingEmails([cust({ billingMethod: 'FACTOR' })], prep([noaRow('Zipline Logistics', 'zip@noa.triumphpay.com')]));
    expect(one.noaWrites.map((w) => [w.customer.id, w.noa])).toEqual([['c1', 'zip@noa.triumphpay.com']]);
    const same = planBillingEmails([cust({ noaEmail: 'ZIP@noa.triumphpay.com' })], prep([noaRow('Zipline Logistics', 'zip@noa.triumphpay.com')]));
    expect(same.noaWrites).toEqual([]);
    expect(same.noaOther.map((r) => r.why)).toEqual(['NOA_SAME']);
    const differs = planBillingEmails([cust({ noaEmail: 'old@noa.triumphpay.com' })], prep([noaRow('Zipline Logistics', 'zip@noa.triumphpay.com')]));
    expect(differs.noaWrites).toEqual([]);
    expect(differs.noaOther.map((r) => r.why)).toEqual(['NOA_DIFFERS']);
    const many = planBillingEmails([cust()], prep([noaRow('Zipline Logistics', 'a@noa.triumphpay.com b@noa.triumphpay.com')]));
    expect(many.noaWrites).toEqual([]);
    expect(many.noaOther.map((r) => r.why)).toEqual(['MULTIPLE_NOA']);
    const amb = planBillingEmails([cust(), cust({ id: 'c2', name: 'ZIPLINE LOGISTICS INC' })], prep([noaRow('Zipline Logistics', 'zip@noa.triumphpay.com')]));
    expect(amb.noaWrites).toEqual([]);
    const both = planBillingEmails([cust()], prep([noaRow('Zipline Logistics', 'zip@noa.triumphpay.com ap@z.com')]));
    expect([both.results[0].status, both.noaWrites.length]).toEqual(['FILL', 1]);
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
  it('writes noaEmail only, conditional on blank, plus one audit row', async () => {
    const calls = [];
    const doc = { send: async (c) => { calls.push(c.input); return {}; } };
    const r = await applyNoa({ doc, suffix: DEV_SUFFIX, customer: { id: 'c1' }, email: 'zip@noa.triumphpay.com' }).catch((e) => e);
    if (r instanceof Error) throw r;
    expect(r.written).toBe(1);
    expect(calls[0].UpdateExpression).toBe('SET noaEmail = :v');
    expect(calls[0].ConditionExpression).toContain('attribute_not_exists(noaEmail)');
    expect(calls[0].ConditionExpression).not.toContain('apEmail');
    expect(calls[1].Item.action).toBe(AUDIT_ACTION);
    expect(JSON.parse(calls[1].Item.changes).next).toEqual({ noaEmail: 'zip@noa.triumphpay.com' });
  });
  it('appends extras conditionally on the list it read, keeping existing entries', async () => {
    const calls = [];
    const doc = { send: async (c) => { calls.push(c.input); return {}; } };
    const r = await applyExtras({ doc, suffix: DEV_SUFFIX, customer: { id: 'c1' }, before: ['keep@z.com'], add: ['b@z.com', 'KEEP@z.com'.toLowerCase()] });
    expect(r.written).toBe(1);
    expect(calls[0].UpdateExpression).toBe('SET apEmailsExtra = :v');
    expect(calls[0].ExpressionAttributeValues[':v']).toEqual(['keep@z.com', 'b@z.com']);
    expect(calls[0].ConditionExpression).toContain('apEmailsExtra = :prev');
    const fresh = [];
    await applyExtras({ doc: { send: async (c) => { fresh.push(c.input); return {}; } }, suffix: DEV_SUFFIX, customer: { id: 'c1' }, before: null, add: ['b@z.com'] });
    expect(fresh[0].ConditionExpression).toContain('attribute_not_exists(apEmailsExtra)');
    const noop = await applyExtras({ doc: { send: async () => { throw new Error('no write expected'); } }, suffix: DEV_SUFFIX, customer: { id: 'c1' }, before: ['b@z.com'], add: ['b@z.com'] });
    expect(noop.written).toBe(0);
  });
  it('is registered for backup and gated', async () => {
    expect(PROD_WRITE_SETS.awCustomerBillingEmails.models).toEqual(['Customer', 'AuditLog']);
    expect(resolveScripts('awCustomerBillingEmails')).toEqual(['awCustomerBillingEmails']);
    expect(typeof billingEmailsGate).toBe('function');
  });
});
