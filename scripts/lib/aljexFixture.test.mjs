import { describe, expect, it } from 'vitest';
import { ALJEX_HEADERS, dollars, generateAljex, renderAljexCsv, SYNTH_PRO_MAX, SYNTH_PRO_MIN } from './aljexFixture.mjs';

describe('aljex synthetic generator', () => {
  it('is reproducible per seed and differs across seeds', () => {
    const a = renderAljexCsv(generateAljex({ rows: 80, seed: 3 }));
    expect(renderAljexCsv(generateAljex({ rows: 80, seed: 3 }))).toBe(a);
    expect(renderAljexCsv(generateAljex({ rows: 80, seed: 4 }))).not.toBe(a);
  });

  it('emits exactly the requested row count at the real header width, right-truncated, every field quoted', () => {
    for (const rows of [10, 40, 333]) {
      const r = generateAljex({ rows, seed: 2 });
      expect(r.rows).toHaveLength(rows);
      expect(r.headers).toEqual(ALJEX_HEADERS);
      expect(r.headers).toHaveLength(486);
      for (const row of r.rows) expect(row.length).toBeLessThanOrEqual(486);
    }
    const r = generateAljex({ rows: 40, seed: 1 });
    const lines = renderAljexCsv(r).split('\n');
    expect(lines[0].startsWith('"Office","Pro #"')).toBe(true);
    expect(r.rows.some((x) => x.length === 474)).toBe(true);
    expect(r.rows.some((x) => x.length === 473)).toBe(true); // memo rows are one field shorter
  });

  it('keeps every PRO in the reserved band and every identity ZZ-prefixed (standard anomalies)', () => {
    const r = generateAljex({ rows: 500, seed: 9 });
    const pro = r.headers.indexOf('Pro #');
    for (const row of r.rows) {
      expect(Number(row[pro])).toBeGreaterThanOrEqual(SYNTH_PRO_MIN);
      expect(Number(row[pro])).toBeLessThanOrEqual(SYNTH_PRO_MAX);
    }
    const nameCols = [r.headers.indexOf('Customer Name'), r.headers.indexOf('Carrier Name')];
    for (const row of r.rows) for (const c of nameCols) if (row[c]) expect(row[c].startsWith('ZZ ')).toBe(true);
  });

  it('anomalies=none carries no duplicates, odd statuses or junk', () => {
    const r = generateAljex({ rows: 200, seed: 6, anomalies: 'none' });
    const o = r.oracle;
    expect(o.identicalDuplicateRows + o.conflictingDuplicateRows).toBe(0);
    expect(Object.keys(o.statusCounts)).toEqual(['DELIVERED']);
    expect(o.anomalyPros.junkShipDates).toEqual([]);
    expect(o.fileRows).toBe(o.loads + o.memos);
  });

  it('anomalies=all adds the ones that must block or error', () => {
    const o = generateAljex({ rows: 200, seed: 6, anomalies: 'all' }).oracle;
    expect(o.anomalyPros.unknownStatus).toHaveLength(1);
    expect(o.anomalyPros.badPros).toHaveLength(3);
    expect(o.anomalyPros.longRows).toHaveLength(1);
    expect(o.anomalyPros.chargeMismatch).toHaveLength(1);
  });

  it('oracle money bridges on its own: invoiced loads + memo adjustments - payments = Σ Bal Due', () => {
    const o = generateAljex({ rows: 600, seed: 12 }).oracle;
    const t = o.uniqueTotals;
    expect(t.invoiceAmountLoads - o.uninvoicedAmount - t.payments - (t.credits - o.creditsOnUninvoiced) + (t.debits - o.debitsOnUninvoiced)).toBe(o.netOpenAr);
    expect(t.balDue).toBe(o.netOpenAr);
    expect(o.invoiceTotalWithMemos - o.invoicePayments).toBe(o.netOpenAr);
    expect(o.memoLinkedCredTotal).toBe(-t.credits);
    expect(o.memoLinkedDebtTotal).toBe(t.debits);
    expect(o.memoAdjustments.appliedNet + o.memoAdjustments.orphanNet).toBe(o.memoNet);
    const reasons = o.memoAdjustments.orphans.map((x) => x.reason);
    expect(reasons).toEqual(expect.arrayContaining(['NO_REFERENCE', 'REFERENCE_NOT_FOUND']));
  });

  it('rejects an unknown anomalies mode and formats cents without floats', () => {
    expect(() => generateAljex({ rows: 5, anomalies: 'nope' })).toThrow();
    expect(dollars(-5)).toBe('-0.05');
    expect(dollars(123456789)).toBe('1234567.89');
  });
});
