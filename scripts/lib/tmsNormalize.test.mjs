import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  normalizeCustomerName,
  normalizeLocationName,
  normalizeCity,
  stopMatchKey,
  pickCanonicalName,
  buildAliases,
} from './tmsNormalize.mjs';

describe('tmsNormalize', () => {
  it('normalises text to lower case with no punctuation', () => {
    expect(normalizeText('  A-B & C.D LLC  ')).toBe('a b and c d llc');
  });

  it('drops legal suffixes from customer names', () => {
    expect(normalizeCustomerName('BCAT Logistics, LLC')).toBe('bcat logistics');
    expect(normalizeCustomerName('Batory Foods Inc.')).toBe('batory foods');
    expect(normalizeCustomerName("Brother's Truck Repair Co.")).toBe('brothers truck repair');
  });

  it('preserves facility words in location names', () => {
    expect(normalizeLocationName('Port of Chicago')).toBe('port of chicago');
    expect(normalizeLocationName("Batory's Oakley Chicago")).toBe('batorys oakley chicago');
  });

  it('normalises cities consistently', () => {
    expect(normalizeCity('Chicago, IL')).toBe('chicago, il');
    expect(normalizeCity('  DALLAS TX. ')).toBe('dallas tx');
  });

  it('builds stable stop match keys', () => {
    expect(stopMatchKey({ name: "Batory's Oakley Chicago", city: 'Chicago, IL' }))
      .toBe('batorys oakley chicago|chicago, il');
    expect(stopMatchKey({ name: 'Batory', city: 'Chicago' }))
      .toBe('batory|chicago');
  });

  it('picks the most common raw variant as canonical', () => {
    expect(pickCanonicalName(['Acme', 'acme', 'ACME Inc.', 'acme'])).toBe('acme');
  });

  it('builds aliases excluding the canonical', () => {
    expect(
      buildAliases('Acme', ['Acme', 'acme', 'ACME Inc.', 'Acme Corp.'])
    ).toEqual(['ACME Inc.', 'Acme Corp.']);
  });
});
