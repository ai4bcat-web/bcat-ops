import { describe, expect, it } from 'vitest';
import { planAll } from './lib/customerBillingPlan.mjs';

const c = (id, name, extra = {}) => ({ id, name, active: true, ...extra });
const row = (name, eBilling) => ({ name, eBilling });

describe('customer billing plan', () => {
  it('factor address -> FACTOR and never an e-mail', () => {
    const { toApply } = planAll([c('1', 'ACME INC', { paymentTermsDays: 30 })], [row('Acme, Inc.', 'ivanfactoring@bcatcorp.com')]);
    expect(toApply[0].writes).toEqual([{ field: 'billingMethod', from: null, to: 'FACTOR', reason: 'FACTOR_FROM_EBILLING' }]);
  });
  it('a customer that was MANUAL but has the factor address becomes FACTOR', () => {
    const { toApply } = planAll([c('1', 'ACME', { billingMethod: 'MANUAL', paymentTermsDays: 30 })], [row('ACME', 'invoicefactoring@bcatcorp.com')]);
    expect(toApply[0].writes[0]).toMatchObject({ field: 'billingMethod', from: 'MANUAL', to: 'FACTOR' });
  });
  it('a real address sets apEmail (and MANUAL while unset); a different existing apEmail is corrected', () => {
    const { toApply } = planAll([c('1', 'BETA', { paymentTermsDays: 30 }), c('2', 'GAMMA', { billingMethod: 'MANUAL', apEmail: 'old@x.com', paymentTermsDays: 30 })],
      [row('BETA', 'ap@beta.com'), row('GAMMA', 'ap@gamma.com')]);
    expect(toApply[0].writes.map((w) => `${w.field}=${w.to}`)).toEqual(['apEmail=ap@beta.com', 'billingMethod=MANUAL']);
    expect(toApply[1].writes).toEqual([{ field: 'apEmail', from: 'old@x.com', to: 'ap@gamma.com', reason: 'AP_EMAIL_CORRECTED' }]);
  });
  it('invoices@bcatcorp.com writes nothing and is noted; conflicts write nothing', () => {
    const { plans } = planAll([c('1', 'D', { paymentTermsDays: 30 }), c('2', 'E', { paymentTermsDays: 30 })], [row('D', 'invoices@bcatcorp.com'), row('E', 'ivanfactoring@bcatcorp.com'), row('E', 'ap@e.com')]);
    expect(plans[0].writes).toEqual([]);
    expect(plans[0].notes[0]).toMatch(/^INTERNAL_ADDRESS_ONLY/);
    expect(plans[1].writes).toEqual([]);
    expect(plans[1].notes).toContain('CONFLICT_FACTOR_AND_REAL_ADDRESS');
  });
  it('terms: empty -> 30, Danisco -> 120, explicit 15 kept', () => {
    const { plans } = planAll([c('1', 'X'), c('2', 'DANISCO US INC.', { paymentTermsDays: 30 }), c('3', 'Y', { paymentTermsDays: 15 }), c('4', 'DANISCO USA INC.', { paymentTermsDays: 120 })], []);
    expect(plans[0].writes).toEqual([{ field: 'paymentTermsDays', from: null, to: 30, reason: 'DEFAULT_NET_30' }]);
    expect(plans[1].writes[0]).toMatchObject({ to: 120, reason: 'DANISCO_120' });
    expect(plans[2].writes).toEqual([]);
    expect(plans[2].notes).toContain('EXPLICIT_TERMS_KEPT:15');
    expect(plans[3].writes).toEqual([]);
  });
  it('ignores merged and inactive customers', () => {
    expect(planAll([c('1', 'A', { mergedIntoId: 'z' }), c('2', 'B', { active: false })], []).live).toHaveLength(0);
  });
});
