import { describe, expect, it } from 'vitest';
import { duplicateIds, normalizeName, planActivation } from './awCustomersActivate.mjs';

const c = (id, name, status, over = {}) => ({ id, name, status, aljexCode: id, ...over });

describe('activating dormant customers', () => {
  it('normalises names like the app does (case, punctuation, legal suffix)', () => {
    expect(normalizeName('ACME, Inc.')).toBe('acme');
    expect(normalizeName('The Acme LLC')).toBe('acme');
  });

  it('activates stored-DORMANT customers and leaves possible duplicates (same name, different account) dormant', () => {
    const customers = [
      c('1', 'Acme Foods Inc', 'DORMANT'),
      c('2', 'ACME FOODS, LLC', 'ACTIVE'),
      c('3', 'Solo Freight', 'DORMANT'),
      c('4', 'Other Co', 'ACTIVE'),
    ];
    const { activate, keptAsDuplicate } = planActivation(customers);
    expect(activate.map((x) => x.id)).toEqual(['3']);
    expect(keptAsDuplicate.map((x) => x.id)).toEqual(['1']);
  });

  it('the same account under one name is not a duplicate; merged-away rows are never touched', () => {
    const customers = [c('1', 'Beta Inc', 'DORMANT', { aljexCode: 'A1' }), c('2', 'Beta Inc', 'DORMANT', { aljexCode: 'A1' }), c('3', 'Gamma', 'DORMANT', { mergedIntoId: '9' })];
    expect(duplicateIds(customers).size).toBe(0);
    expect(planActivation(customers).activate.map((x) => x.id)).toEqual(['1', '2']);
  });
});
