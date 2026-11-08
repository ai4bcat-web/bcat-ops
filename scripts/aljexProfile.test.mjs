import { describe, expect, it } from 'vitest';
import { assertOutsideRepo, createProfiler, parseCents, parseDate } from './aljexProfile.mjs';

describe('parseCents', () => {
  it('handles currency formats and rejects placeholders', () => {
    expect(parseCents('1,234.5')).toBe(123450);
    expect(parseCents('$12.30')).toBe(1230);
    expect(parseCents('(5.25)')).toBe(-525);
    expect(parseCents('7.00-')).toBe(-700);
    expect(parseCents('$')).toBeNaN();
    expect(parseCents('')).toBeNaN();
    expect(parseCents('abc')).toBeNaN();
  });
});

describe('parseDate', () => {
  it('parses Aljex m/d/yy and rejects impossible dates', () => {
    expect(parseDate('3/9/24')).toEqual({ y: 2024, m: 3, d: 9 });
    expect(parseDate('01/01/70')).toEqual({ y: 1970, m: 1, d: 1 });
    expect(parseDate('2024-02-30')).toBeNull();
    expect(parseDate('00/00/00')).toBeNull();
    expect(parseDate('20240131')).toEqual({ y: 2024, m: 1, d: 31 });
  });
});

describe('assertOutsideRepo', () => {
  it('refuses paths inside the repo and accepts /tmp', () => {
    expect(() => assertOutsideRepo('./profile.json')).toThrow(/outside the repo/);
    expect(assertOutsideRepo('/tmp/x.json')).toBe('/tmp/x.json');
  });
});

function syntheticHeaders() {
  const h = ['Pro #', 'Type of Shipment', 'Dispatch Status', 'LH Revenue', 'Invoice Amount', 'Bal Due', 'Carrier Name', 'Driver Name'];
  for (let n = 1; n <= 3; n++) h.push(`Paid Date ${n}`, `Paid Amount ${n}`, `Days to Pay ${n}`);
  for (let n = 1; n <= 9; n++) h.push(`Proj Exp ${n}`, `Proj Amt ${n}`, `Type ${n}`);
  for (let n = 1; n <= 8; n++) h.push(`Acc Charge ${n}`, `Acc ${n}`);
  for (let n = 1; n <= 8; n++) h.push('Paid Exp Name', 'Paid Exp Amt', 'Paid Exp Date', 'Paid Exp Ck#', 'Paid Exp GL');
  for (let n = 1; n <= 3; n++) h.push(`Commission Rep ${n}`, `Commission Amt ${n}`);
  for (let n = 1; n <= 12; n++) h.push(`PS${n}`, 'Name', 'Address', 'City', 'State', 'Zip', 'Phone', 'Ref #');
  for (let n = 1; n <= 21; n++) h.push('Code', 'Description', 'Units/Code/Class', 'Weight', 'Rate', 'Extension');
  return h;
}

describe('createProfiler', () => {
  it('aggregates synthetic rows (right-truncated, memo, void) and enforces the layout', () => {
    const headers = syntheticHeaders();
    const col = (name, nth = 0) => headers.map((x, i) => (x === name ? i : -1)).filter((i) => i >= 0)[nth];
    const row = (vals) => {
      const r = Array(headers.length).fill('');
      for (const [k, v] of Object.entries(vals)) r[col(k)] = v;
      return r;
    };
    const p = createProfiler(headers);
    p.addRow(row({ 'Pro #': '1', 'Type of Shipment': 'FTL', 'Dispatch Status': 'DELIVERED', 'LH Revenue': '100.00', 'Invoice Amount': '100.00', 'Bal Due': '0', Code: 'F', Extension: '100.00' }));
    p.addRow(row({ 'Pro #': '2', 'Type of Shipment': 'CRED', 'LH Revenue': '-5.00', 'Invoice Amount': '-5.00', 'Bal Due': '0', Code: '2', Extension: '-5.00' }));
    p.addRow(['3', 'FTL', 'VOID']); // right-truncated
    const r = p.result();
    expect(r.rows).toBe(3);
    expect(r.rowLengthHistogram).toEqual({ 3: 1, [headers.length]: 2 });
    expect(r.reconciliationTotals.invoiceAmount).toBe(95);
    expect(r.chargeExtensionVsInvoice.rowsMismatch).toBe(0);
    expect(r.memoRows.CRED.invoiceAmount).toBe(-5);
    expect(r.void.rows).toBe(1);
    expect(() => createProfiler(['Pro #'])).toThrow(/layout mismatch/);
  });
});
