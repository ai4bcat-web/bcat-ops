import { describe, expect, it } from 'vitest';
import { EXPECTED, applyOne, buildReport, facPaidGate, planCustomerPaid } from './awFactoringCustomerPaid.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { DEV_SUFFIX } from './lib/prodGate.mjs';

const item = (pro, o = {}) => ({ id: pro, status: 'PENDING_WITH_OTR', otrStatus: '4', ...o });
const invoice = (pro, o = {}) => ({ id: pro, number: pro, status: 'PAID', paidCents: 1, balanceCents: 0, ...o });
const payment = (e, o = {}) => ({ id: `p-${e.pro}`, kind: 'PAYMENT', receivedAt: `${e.paidOn}T12:00:00.000Z`, amountCents: e.amountCents, reference: e.reference, applications: JSON.stringify([{ invoiceId: e.pro, amountCents: e.amountCents }]), ...o });
const good = () => ({ items: EXPECTED.map((e) => item(e.pro)), invoices: EXPECTED.map((e) => invoice(e.pro, { paidCents: e.amountCents })), payments: EXPECTED.map((e) => payment(e)) });

describe('planCustomerPaid', () => {
  it('is READY for the three rows when the payments are as Ryne was shown', () => {
    const plan = planCustomerPaid(good());
    expect(plan.map((r) => r.status)).toEqual(['READY', 'READY', 'READY']);
    expect(plan.map((r) => r.paidOn)).toEqual(['2026-10-30', '2026-10-28', '2026-10-13']);
  });
  it('refuses a row that is not Pending with OTR / not Dead', () => {
    const g = good(); g.items[0] = item('14749', { status: 'FACTORED' }); g.items[1] = item('14700', { otrStatus: '1' });
    const plan = planCustomerPaid(g);
    expect(plan[0].status).toBe('REFUSED'); expect(plan[0].why.join()).toMatch(/PENDING_WITH_OTR/);
    expect(plan[1].status).toBe('REFUSED'); expect(plan[1].why.join()).toMatch(/Dead/);
  });
  it('refuses when the payment date, amount or reference differs, or the invoice is not fully paid', () => {
    const g = good(); g.payments[0] = payment(EXPECTED[0], { receivedAt: '2026-10-31T12:00:00.000Z' });
    g.payments[1] = payment(EXPECTED[1], { amountCents: 1 }); g.invoices[2] = invoice('14538', { balanceCents: 500 });
    const plan = planCustomerPaid(g);
    expect(plan.map((r) => r.status)).toEqual(['REFUSED', 'REFUSED', 'REFUSED']);
  });
  it('refuses a missing row, and leaves a row that already has a date alone', () => {
    const g = good(); g.items = g.items.slice(1); g.items[0] = item('14700', { customerPaidOn: '2026-10-28' });
    const plan = planCustomerPaid(g);
    expect(plan[0].status).toBe('REFUSED');
    expect(plan[1].status).toBe('ALREADY_SET');
    expect(plan[2].status).toBe('READY');
  });
  it('counts a payment that is not applied to the invoice as no payment', () => {
    const g = good(); g.payments[0] = payment(EXPECTED[0], { applications: '[]' });
    expect(planCustomerPaid(g)[0].why.join()).toMatch(/found 0/);
  });
});

describe('applyOne', () => {
  const row = () => { const [r] = planCustomerPaid(good()); return r; };
  it('writes the two fields only while the row is Pending with OTR and still empty, with an audit row', async () => {
    const calls = [];
    const doc = { send: async (c) => { calls.push({ name: c.constructor.name, input: c.input }); return {}; } };
    expect(await applyOne({ doc, suffix: DEV_SUFFIX, row: row() })).toEqual({ written: 1, lost: 0 });
    const upd = calls.find((c) => c.name === 'UpdateCommand').input;
    expect(upd.TableName).toBe(`FactoringItem-${DEV_SUFFIX}`);
    expect(upd.UpdateExpression).toContain('customerPaidOn = :d');
    expect(upd.UpdateExpression).not.toMatch(/status|otr/i);
    expect(upd.ConditionExpression).toContain('#st = :pending');
    expect(calls.some((c) => c.name === 'PutCommand' && c.input.TableName === `AuditLog-${DEV_SUFFIX}`)).toBe(true);
  });
  it('counts a row that changed meanwhile as lost, not an error', async () => {
    const doc = { send: async () => { const e = new Error('x'); e.name = 'ConditionalCheckFailedException'; throw e; } };
    expect(await applyOne({ doc, suffix: DEV_SUFFIX, row: row() })).toEqual({ written: 0, lost: 1 });
  });
  it('is registered for backup and gated', () => {
    expect(PROD_WRITE_SETS.awFactoringCustomerPaid.models).toEqual(['FactoringItem', 'AuditLog']);
    expect(resolveScripts('awFactoringCustomerPaid')).toEqual(['awFactoringCustomerPaid']);
    expect(typeof facPaidGate).toBe('function');
  });
});

describe('buildReport', () => {
  it('states each row', () => {
    const text = buildReport({ plan: planCustomerPaid(good()), today: '2026-11-12' });
    expect(text).toContain('14749: READY');
    expect(text).toContain('customerPaidOn 2026-10-30');
  });
});
