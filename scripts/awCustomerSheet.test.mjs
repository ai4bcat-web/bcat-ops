import { describe, expect, it } from 'vitest';
import { planSheet, normName, looseName } from './lib/customerSheetPlan.mjs';

const customers = [
  { id: 'c1', name: 'Guest Supply, Inc.', billingMethod: 'MANUAL', apEmail: 'old@guest.test' },
  { id: 'c2', name: 'Batory Foods', billingMethod: null },
  { id: 'c3', name: 'Acme', billingMethod: 'FACTOR', billingAddress: { street: '1 Main', city: 'X' } },
  { id: 'c4', name: 'Twin LLC' }, { id: 'c5', name: 'Twin Inc' },
  { id: 'c6', name: 'Merged Co', mergedIntoId: 'c2' },
];
const rows = [
  { name: 'GUEST SUPPLY', street: '300 DAVIDSON AVENUE', city: 'SOMERSET', state: 'NJ', zip: '08873', emails: ['ivanfactoring@bcatcorp.com'] },
  { name: 'BATORY FOODS', street: '10255 W HIGGINS RD', city: 'DES PLAINES', state: 'IL', zip: '60018', emails: ['ap@batory.test', 'ar@batory.test'] },
  { name: 'ACME', street: '9 Other', city: 'Y', emails: [] },
  { name: 'TWIN', emails: ['x@y.test'] },
  { name: 'NOBODY HERE', emails: ['n@h.test'] },
];

describe('planSheet', () => {
  const plan = planSheet(rows, customers);
  it('factoring address -> FACTOR and the invoice e-mail is left alone', () => {
    const e = plan.entries.find((x) => x.customer.id === 'c1');
    expect(e.kind).toBe('FACTOR');
    expect(e.set.billingMethod).toBe('FACTOR');
    expect('apEmail' in e.set).toBe(false);
  });
  it('a real address -> MANUAL with the e-mail(s); the address fills only where empty', () => {
    const e = plan.entries.find((x) => x.customer.id === 'c2');
    expect(e.set).toMatchObject({ billingMethod: 'MANUAL', apEmail: 'ap@batory.test, ar@batory.test' });
    expect(e.set.billingAddress).toMatchObject({ street: '10255 W HIGGINS RD', zip: '60018' });
    expect(plan.entries.find((x) => x.customer.id === 'c3')).toBeUndefined(); // has an address already, blank e-mail: nothing to write
  });
  it('blank e-mail is left for Ryne; ambiguous and unknown names are never guessed', () => {
    expect(plan.blankKept.map((b) => b.customer.id)).toEqual(['c3']);
    expect(plan.ambiguous.map((r) => r.name)).toEqual(['TWIN']);
    expect(plan.unmatched.map((r) => r.name)).toEqual(['NOBODY HERE']);
  });
  it('normalises names', () => {
    expect(normName('Guest  Supply, Inc.')).toBe('GUEST SUPPLY INC');
    expect(looseName('Guest Supply, Inc.')).toBe('GUEST SUPPLY');
  });
});
