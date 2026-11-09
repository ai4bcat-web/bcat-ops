import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChecks, parseCsv, writeChecks } from './awPostLoadChecks.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'awchecks-'));
  const tmp = join(root, 'tmp');
  const reports = join(root, 'reports');
  const exportDir = join(root, 'export');
  for (const d of [tmp, reports, exportDir]) mkdirSync(d, { recursive: true });
  const put = (rel, body) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); };
  return { root, tmp, reports, exportDir, put };
}
const opts = (sb) => ({ date: '2026-11-09', reportsDir: sb.reports, tmp: sb.tmp, exportDir: sb.exportDir });

describe('awPostLoadChecks', () => {
  it('without any earlier step it still lists every category with a "run it first" row, never silently empty', () => {
    const rows = buildChecks(opts(sandbox()));
    const cats = new Set(rows.map((r) => r[0]));
    for (const c of ['revenue difference', 'identical duplicate PRO', 'junk date', 'unmatched memo', 'open AR gap', 'AP_UNRESOLVED', 'AP_NOT_IN_ALJEX_LISTS', 'duplicate customer name', 'billing method needs review', 'name match not linked', 'same name, different carrier']) expect(cats.has(c), c).toBe(true);
    expect(rows.find((r) => r[0] === 'open AR gap')[3]).toBe('run AR + reconcile first');
  });

  it('lists each unresolved AP aging bill as AP_UNRESOLVED with the carrier-leg action', () => {
    const sb = sandbox();
    sb.put('tmp/aljex-run-aljexrun-3/imports/runs/aljexrun:3/ap-aging-unresolved.csv', 'pro,vendor_id,amount,reason\n14576,300002301,700.00,NO_CARRIER_LEG\n14563,300002104,125.00,LEG_CARRIER_DIFFERS\n');
    const rows = buildChecks(opts(sb)).filter((r) => r[0] === 'AP_UNRESOLVED');
    expect(rows.map((r) => r[1])).toEqual(['14576', '14563']);
    expect(rows[0][2]).toContain('$700.00');
    expect(rows[0][3]).toBe('Assign the carrier leg on the load and enter the bill');
  });

  it('splits open BCAT-only AP bills into stale-expected and on-no-Aljex-list, and skips the ones on the expected list', () => {
    const sb = sandbox();
    sb.put('tmp/aljex-run-aljexrun-4/imports/runs/aljexrun:4/reconcile-ap.csv', 'outcome,pro,vendor_id,carrier,bill_number,file_amount,bcat_balance,difference,file_due,bcat_due,file_pay_to,bcat_pay_to,notes\nMATCHED,100,1,A,9,10.00,10.00,0.00,,,,,\nBCAT_ONLY,200,,CAR B,,,50.00,,,2026-12-01,,,x\nBCAT_ONLY,300,,CAR C,,,70.00,,,2026-12-02,,,x\nBCAT_ONLY,400,,CAR D,,,90.00,,,2026-12-03,,,x\n');
    sb.put('export/ap-expected-stale-2026-11-08.csv', 'Vendor,Pay to,Pro #,Amount\nCAR C,CAR C,300,70.00\n');
    sb.put('export/aljex-ap-expected-2026-11-08.csv', 'Vendor,Pay to,Pro #,Amount\nCAR B,CAR B,200,50.00\nCAR C,CAR C,300,70.00\n');
    const rows = buildChecks(opts(sb));
    expect(rows.filter((r) => r[0] === 'AP_STALE_EXPECTED').map((r) => r[1])).toEqual(['300']);
    expect(rows.filter((r) => r[0] === 'AP_NOT_IN_ALJEX_LISTS').map((r) => r[1])).toEqual(['400']);
    expect(rows.find((r) => r[0] === 'AP open gap')[2]).toContain('1 on the AP expected list ($50.00), 1 on dropped stale expected rows ($70.00), 1 on no Aljex list ($90.00)');
  });

  it('lists open BCAT invoices that are not in the Aljex AR report from the named gap report, without repeating the AR_PRO_NOT_IN_BCAT rows', () => {
    const sb = sandbox();
    sb.put('reports/ar-open-gap-2026-11-08.csv', 'category,PRO,customer,Aljex amount,BCAT balance,difference,invoice date,age days,what to check,suggested action,Ryne note,Status\nAR_PRO_NOT_IN_BCAT,111,ACME,10.00,,,2026-01-01,300,in the Aljex AR report,Link\nAR_BCAT_ONLY_OPEN,222,BETA,,52.50,,2026-03-13,239,open in BCAT,Confirm it is really unpaid,,\n');
    const rows = buildChecks(opts(sb));
    expect(rows.filter((r) => r[0] === 'AR_BCAT_ONLY_OPEN').map((r) => r[1])).toEqual(['222']);
    expect(rows.some((r) => r[1] === '111')).toBe(false);
  });

  it('lists review-CSV revenue rows, one junk-date row per PRO, memo orphans, and the importer name-match / billing review split', () => {
    const sb = sandbox();
    sb.put('reports/revenue-differences-2026-11-09.csv', 'PRO,BCAT value ($),Aljex invoice ($),difference ($),Aljex higher/lower,open balance ($),due date,invoice state,customer,bill-to,suggested action,Ryne note,Status\n15001,100.00,110.00,10.00,Aljex higher,110.00,2026-12-01,OPEN,"ZZ, Inc",ZZ,x,,\n');
    sb.put('tmp/aljex-run-aljexrun-1/imports/jobs/aljexrun:1/stage-index.json', JSON.stringify({ rows: 9000, findings: [{ code: 'JUNK_DATE', pro: '15002', detail: 'Pickup' }, { code: 'JUNK_DATE', pro: '15002', detail: 'Delivered' }, { code: 'DUPLICATE_ROW_IDENTICAL', pro: '15003' }] }));
    sb.put('tmp/aljex-run-aljexrun-1/imports/jobs/aljexrun:1/masters.json', JSON.stringify({ memos: { orphans: [{ memoPro: 'M1', kind: 'CRED', referencePro: '15009', signedAmountCents: -2000, reason: 'REFERENCE_NOT_INVOICED' }] } }));
    sb.put('tmp/aljex-run-aljexrun-2/imports/runs/aljexrun:2/customers-master-review.csv', 'key,reason\n100001,billing seed flagged\n100002,a customer with the same name exists without an Aljex account; imported separately (possible duplicate)\n');
    const rows = buildChecks(opts(sb));
    const by = (c) => rows.filter((r) => r[0] === c);
    expect(by('revenue difference').map((r) => r[1])).toEqual(['15001']);
    expect(by('junk date')).toHaveLength(1);
    expect(by('junk date')[0][2]).toContain('Pickup, Delivered');
    expect(by('identical duplicate PRO').map((r) => r[1])).toEqual(['15003']);
    expect(by('unmatched memo').map((r) => r[1])).toEqual(['M1']);
    expect(by('billing method needs review').map((r) => r[1])).toEqual(['100001']);
    expect(by('name match not linked').map((r) => r[1])).toEqual(['100002']);
  });

  it('writes the file 0600 in a 0700 directory with the exact header, and quotes cells that hold commas', () => {
    const sb = sandbox();
    const res = writeChecks({ ...opts(sb), reportsDir: join(sb.root, 'new-reports') });
    expect(statSync(res.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(sb.root, 'new-reports')).mode & 0o777).toBe(0o700);
    const [header, ...body] = parseCsv(readFileSync(res.path, 'utf8'));
    expect(header).toEqual(['Category', 'Key', 'What to check', 'Suggested action', 'Ryne note', 'Status']);
    expect(body.length).toBe(res.rows);
    expect(body.every((r) => r.length === 6 && r[4] === '' && r[5] === '')).toBe(true);
  });
});
