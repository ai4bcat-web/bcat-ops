import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, applyOne, customerEmailGate } from './awCustomerEmail.mjs';
import { apAfter, indexByAccount, matchCustomers, parseAddresses, planCustomerEmail } from './lib/customerEmailPlan.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';

describe('parseAddresses', () => {
  it('splits on comma, semicolon, whitespace and newline; trims, lowercases, de-duplicates', () => {
    expect(parseAddresses(' AP@X.com, b@x.com;\nap@x.com  c@x.com ').valid).toEqual(['ap@x.com', 'b@x.com', 'c@x.com']);
  });
  it('rejects malformed addresses (two glued together, no domain dot, no @) and lists them apart', () => {
    const r = parseAddresses('good@x.com bad@x.comother@y.com nodot@host plain');
    expect(r.valid).toEqual(['good@x.com']);
    expect(r.malformed).toEqual(['bad@x.comother@y.com', 'nodot@host', 'plain']);
  });
});

const cust = (o = {}) => ({ id: 'c1', aljexCode: '100100', billingMethod: 'MANUAL', ...o });
const row = (o = {}) => ({ account: '100100', eBilling: 'ap@x.com', contactEmail: '', contact2Email: '', ...o });

describe('planCustomerEmail', () => {
  it('sets apEmail from the first external address and the rest as the copy list', () => {
    const p = planCustomerEmail(row({ eBilling: 'ap@x.com; Billing@x.com, ap@x.com' }), cust());
    expect(p.writes).toEqual([{ field: 'apEmail', value: 'ap@x.com' }, { field: 'invoiceCopyEmails', value: ['billing@x.com'] }]);
    expect(p.extras).toEqual(['billing@x.com']);
  });
  it('never overwrites: set apEmail / contactEmail are skipped and reported', () => {
    const p = planCustomerEmail(row({ contactEmail: 'c@x.com' }), cust({ apEmail: 'old@x.com', contactEmail: 'oldc@x.com' }));
    expect(p.writes).toEqual([]);
    expect(p.skipped).toEqual(['AP_ALREADY_SET', 'CONTACT_ALREADY_SET']);
  });
  it('extras fill an empty copy list only when the existing apEmail is the Aljex primary', () => {
    const same = planCustomerEmail(row({ eBilling: 'ap@x.com b@x.com' }), cust({ apEmail: 'AP@x.com' }));
    expect(same.writes).toEqual([{ field: 'invoiceCopyEmails', value: ['b@x.com'] }]);
    const other = planCustomerEmail(row({ eBilling: 'ap@x.com b@x.com' }), cust({ apEmail: 'else@x.com' }));
    expect(other.writes).toEqual([]);
    const filled = planCustomerEmail(row({ eBilling: 'ap@x.com b@x.com' }), cust({ invoiceCopyEmails: ['k@x.com'] }));
    expect(filled.writes).toEqual([{ field: 'apEmail', value: 'ap@x.com' }]);
  });
  it('never writes BCAT-internal addresses, nor apEmail for a FACTOR customer', () => {
    const internal = planCustomerEmail(row({ eBilling: 'ivanfactoring@bcatcorp.com' }), cust());
    expect(internal.writes).toEqual([]);
    expect(internal.internal).toEqual(['ivanfactoring@bcatcorp.com']);
    expect(planCustomerEmail(row(), cust({ billingMethod: 'FACTOR' })).writes).toEqual([]);
  });
  it('contactEmail takes the first valid Contact email; contact 2 is only counted; malformed are reported not written', () => {
    const p = planCustomerEmail(row({ eBilling: '', contactEmail: 'bad@@x oka@x.com', contact2Email: 'c2@x.com' }), cust());
    expect(p.writes).toEqual([{ field: 'contactEmail', value: 'oka@x.com' }]);
    expect(p.malformed).toEqual(['bad@@x']);
    expect(p.contact2).toBe(1);
  });
});

describe('matching', () => {
  it('matches by aljexCode, skips merged-away rows, refuses an ambiguous code, lists export rows with no customer', () => {
    const { byAccount } = indexByAccount([row({ account: '1' }), row({ account: '2' }), row({ account: '3' }), row({ account: '4' })]);
    const m = matchCustomers([
      { id: 'a', aljexCode: '1' }, { id: 'b', aljexCode: '2' }, { id: 'b2', aljexCode: '2' },
      { id: 'm', aljexCode: '3', mergedIntoId: 'a' },
    ], byAccount);
    expect(m.matched.map((x) => x.customer.id)).toEqual(['a']);
    expect(m.ambiguous).toEqual(['2']);
    expect(m.unmatchedRows.map((r) => r.account)).toEqual(['3', '4']);
  });
  it('apAfter reflects the planned write or the existing value', () => {
    expect(apAfter(cust(), planCustomerEmail(row(), cust()))).toBe('ap@x.com');
    expect(apAfter(cust({ apEmail: ' Old@X.com ' }), planCustomerEmail(row(), cust({ apEmail: 'o' })))).toBe('old@x.com');
    expect(apAfter(cust(), null)).toBeNull();
  });
});

describe('applyOne', () => {
  const entry = { customer: { id: 'c1', aljexCode: '100100' }, writes: [{ field: 'apEmail', value: 'ap@x.com' }, { field: 'invoiceCopyEmails', value: ['b@x.com'] }] };
  const fakeDoc = (fail = []) => {
    const sent = [];
    return { sent, send: async (cmd) => {
      sent.push(cmd);
      if (cmd.constructor.name === 'UpdateCommand' && fail.includes(cmd.input.ExpressionAttributeNames['#f'])) { const e = new Error('c'); e.name = 'ConditionalCheckFailedException'; throw e; }
    } };
  };
  it('conditional-on-empty updates per field and one audit row with previous values', async () => {
    const doc = fakeDoc();
    expect(await applyOne({ doc, suffix: 'dev-x', entry })).toEqual({ written: 2, lost: 0 });
    const updates = doc.sent.filter((c) => c.constructor.name === 'UpdateCommand');
    expect(updates[0].input.ConditionExpression).toMatch(/attribute_not_exists\(#f\).*#f = :blank/);
    expect(updates[1].input.ConditionExpression).toMatch(/size\(#f\) = :zero/);
    const audits = doc.sent.filter((c) => c.constructor.name === 'PutCommand');
    expect(audits).toHaveLength(1);
    expect(audits[0].input.Item.action).toBe(AUDIT_ACTION);
    expect(JSON.parse(audits[0].input.Item.changes).previous).toEqual({ apEmail: null, invoiceCopyEmails: null });
  });
  it('a field filled meanwhile is skipped; all lost means no audit row', async () => {
    const doc = fakeDoc(['apEmail', 'invoiceCopyEmails']);
    expect(await applyOne({ doc, suffix: 'dev-x', entry })).toEqual({ written: 0, lost: 2 });
    expect(doc.sent.filter((c) => c.constructor.name === 'PutCommand')).toHaveLength(0);
  });
  it('refuses a non e-mail field and the production suffix without the gate', async () => {
    await expect(applyOne({ doc: fakeDoc(), suffix: 'dev-x', entry: { ...entry, writes: [{ field: 'name', value: 'x' }] } })).rejects.toThrow(/refusing to write/);
    await expect(applyOne({ doc: fakeDoc(), suffix: PROD_SUFFIX, entry })).rejects.toThrow();
  });
});

describe('gate', () => {
  it('is registered for backups of exactly Customer + AuditLog', () => {
    expect([...PROD_WRITE_SETS.awCustomerEmail.models].sort()).toEqual(['AuditLog', 'Customer']);
    expect(resolveScripts('awCustomerEmail')).toEqual(['awCustomerEmail']);
  });
  it('an apply refuses without BCAT_ALLOW_PROD, with a stale backup, or without the typed AW_PROD_CONFIRM', async () => {
    const now = new Date('2026-11-09T12:00:00');
    const values = { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `111:${PROD_SUFFIX}` };
    const fresh = { send: async () => ({ BackupSummaries: ['Customer', 'AuditLog'].map((t) => ({ TableName: `${t}-${PROD_SUFFIX}`, BackupName: `prodpre-awCustomerEmail-${t}`, BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date('2026-11-09T11:00:00') })) }) };
    const base = { now, dynamo: fresh, accountId: async () => '111', out: () => {} };
    await expect(customerEmailGate(values, { ...base, env: {} })).rejects.toThrow(/closed/);
    await expect(customerEmailGate(values, { ...base, env: { [ALLOW_ENV]: '2026-11-09' } })).rejects.toThrow(/AW_PROD_CONFIRM must equal 2026-11-09-customeremail/);
    await expect(customerEmailGate(values, { ...base, dynamo: { send: async () => ({ BackupSummaries: [] }) }, env: { [ALLOW_ENV]: '2026-11-09', AW_PROD_CONFIRM: '2026-11-09-customeremail' } })).rejects.toThrow(/closed/);
    await expect(customerEmailGate(values, { ...base, env: { [ALLOW_ENV]: '2026-11-09', AW_PROD_CONFIRM: '2026-11-09-customeremail' } })).resolves.toMatchObject({ apply: true });
  });
});
