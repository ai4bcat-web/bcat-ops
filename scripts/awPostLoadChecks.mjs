#!/usr/bin/env node
/**
 * Post-load checks list for Ryne: one CSV of everything the Aljex load leaves to a human decision.
 *
 *   node scripts/awPostLoadChecks.mjs [--date YYYY-MM-DD]
 *
 * Output: <reports dir>/post-load-checks-<date>.csv (mode 600, dir mode 700; default reports dir
 * /Users/adminoid/aljex-export/reports, override with env AW_REPORTS_DIR). Columns:
 *   Category, Key (PRO / account / name), What to check, Suggested action, Ryne note (empty), Status (empty)
 * The files hold names (PII): they stay outside the repo and ONLY the path and row counts are printed.
 * Called by scripts/awProdRun.sh after the loads apply and again after reconcile (the list fills in as the steps run).
 * Every source is a LOCAL file; this script never touches AWS.
 *
 * Categories and where each comes from:
 *  1. "revenue difference"      reports/revenue-differences-<date>.csv, written by the loads run at APPLY: every row on the
 *                               review list (outstanding/partial/unverified). Rows the invoice carries at the PAID amount are
 *                               internal findings and are NOT listed. No such file yet: one row "run the loads apply first".
 *  2. "identical duplicate PRO" newest local loads run (TMPDIR/aljex-run-*): stage-index.json findings DUPLICATE_ROW_IDENTICAL
 *                               (the later copy was skipped; check it really is a copy).
 *  3. "junk date"               same stage-index.json, findings JUNK_DATE (one row per PRO + column).
 *  4. "unmatched memo"          same run, masters.json memos.orphans (memoOrphans bridge item; key = the memo PRO).
 *  5. "open AR gap"             newest local AR file run (ar-file-summary.json / ar-unresolved.csv, same TMPDIR) and the newest
 *                               loads reconcile summary.json: one total row (Aljex AR report vs BCAT open AR) plus one row per
 *                               AR-report invoice BCAT could not match (key = PRO). Filled only once the AR and reconcile steps
 *                               ran; otherwise one row "run AR + reconcile first". Per-customer BCAT open AR is not persisted
 *                               locally, so the per-customer view is the unresolved list's customer account in the text.
 *  6. "duplicate customer name" the importer's own groups (customers-master-findings.csv CUSTOMER_DUPLICATE_NAME, newest customers run) named from the customers export (aljex-customers-<date>.csv in the export dir, or --customers <file>); without a run, grouped by normalised name
 *                               key = the group name, check = "possible duplicate accounts <n>".
 *  7. "billing method needs review" newest customers master run (customers-master-review.csv): reviews that are not the
 *                               name-match kind (customers whose billing seed was flagged, Customer.billingNeedsReview).
 *  8. "name match not linked"   same review CSV: "a customer with the same name exists without an Aljex account" (90 on 11-08).
 *  9. "same name, different carrier" carriers master run: only the COUNT (carriers-master-summary.json sameNameDifferentCarrier,
 *                               10 on 11-08) is persisted, not the names: one row with the count and "rerun carriers dry run to list".
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const HEADER = ['Category', 'Key', 'What to check', 'Suggested action', 'Ryne note', 'Status'];
const EXPORT_DIR = '/Users/adminoid/aljex-export';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}

const cellOut = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
const csvOut = (rows) => `${rows.map((r) => r.map(cellOut).join(',')).join('\n')}\n`;
const dollars = (cents) => `${cents < 0 ? '-' : ''}$${Math.trunc(Math.abs(cents) / 100).toLocaleString('en-US')}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const localDate = () => new Date().toLocaleDateString('en-CA');

/** Best file `name` under tmp/aljex-run-* /imports/<kind>/<id>/: the one with the highest `weight(path)` (default 0), then the newest (mtime); null when none. */
function newestRunFile(tmp, kind, name, weight = () => 0) {
  let best = null;
  for (const d of existsSync(tmp) ? readdirSync(tmp) : []) {
    if (!d.startsWith('aljex-run-')) continue;
    const base = join(tmp, d, 'imports', kind);
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const p = join(base, id, name);
      if (!existsSync(p)) continue;
      const m = statSync(p).mtimeMs;
      const w = weight(p);
      if (!best || w > best.w || (w === best.w && m > best.m)) best = { p, m, w };
    }
  }
  return best?.p ?? null;
}


export function buildChecks({ date, reportsDir, tmp = tmpdir(), exportDir = EXPORT_DIR, customersFile }) {
  const rows = [];
  const add = (category, key, what, action) => rows.push([category, key, what, action, '', '']);

  // 1. revenue differences
  const rev = join(reportsDir, `revenue-differences-${date}.csv`);
  if (existsSync(rev)) {
    const [h, ...body] = parseCsv(readFileSync(rev, 'utf8'));
    const ix = (n) => h.indexOf(n);
    for (const r of body) add('revenue difference', r[ix('PRO')], `BCAT ${r[ix('BCAT value ($)')]} vs Aljex ${r[ix('Aljex invoice ($)')]} (${r[ix('invoice state')]}, open ${r[ix('open balance ($)')]}); the invoice follows Aljex`, 'See revenue-differences report: confirm the amount, fix BCAT rate or Aljex');
  } else add('revenue difference', '(none yet)', 'revenue-differences report not found for this date', 'run the loads apply first');

  // 2-4. stage findings and memo orphans of the newest local loads run
  const stageIndex = newestRunFile(tmp, 'jobs', 'stage-index.json', (p) => readJson(p).rows ?? 0);
  if (stageIndex) {
    const junk = new Map();
    for (const f of readJson(stageIndex).findings ?? []) {
      if (f.code === 'DUPLICATE_ROW_IDENTICAL') add('identical duplicate PRO', f.pro, 'PRO repeats with a byte-identical row; the later copy was skipped', 'Confirm it is a true duplicate row in Aljex');
      if (f.code === 'JUNK_DATE') junk.set(f.pro, [...(junk.get(f.pro) ?? []), f.detail ?? '?']);
    }
    for (const [pro, cols] of junk) add('junk date', pro, `unusable date in column(s) ${cols.join(', ')}`, 'Fix the date in Aljex; the import ignored it');
    const masters = join(stageIndex, '..', 'masters.json');
    if (existsSync(masters)) for (const o of readJson(masters).memos?.orphans ?? []) add('unmatched memo', o.memoPro, `${o.kind} memo ${dollars(o.signedAmountCents)} references PRO ${o.referencePro || '(blank)'}: ${o.reason}`, 'Find the invoice this memo belongs to or void it');
  } else {
    for (const c of ['identical duplicate PRO', 'junk date', 'unmatched memo']) add(c, '(none yet)', 'no local loads run found', 'run the loads plan first');
  }

  // 5. open AR gap
  const arSummary = newestRunFile(tmp, 'runs', 'ar-file-summary.json', (p) => readJson(p).invoices ?? 0);
  const reconcileSummary = newestRunFile(tmp, 'runs', 'summary.json');
  if (arSummary && reconcileSummary) {
    const ar = readJson(arSummary);
    const rec = readJson(reconcileSummary);
    const bcat = rec.openArCents;
    add('open AR gap', 'total', `Aljex AR report ${dollars(ar.totalCents)} vs BCAT open AR ${typeof bcat === 'number' ? dollars(bcat) : 'n/a'} (difference ${typeof bcat === 'number' ? dollars(bcat - ar.totalCents) : 'n/a'}); ${ar.balanceDiffers} existing invoice(s) differ, ${ar.unresolved?.length ?? 0} unresolved`, 'Work the rows below, then the total should close');
    const unresolved = join(arSummary, '..', 'ar-unresolved.csv');
    if (existsSync(unresolved)) for (const r of parseCsv(readFileSync(unresolved, 'utf8')).slice(1)) add('open AR gap', r[0], `in the Aljex AR report (${dollars(Math.round(Number(r[2]) * 100))} open, account ${r[1] || '(none)'}) but BCAT has no matching open invoice: ${r[3]}`, 'Link the PRO/customer or invoice it');
  } else add('open AR gap', '(none yet)', 'AR and reconcile have not both run', 'run AR + reconcile first');

  // 5b. AP bills in the Aljex AP aging that BCAT cannot place (no carrier leg, or the leg has another carrier).
  // The reports file (named, with carrier and suggested action) wins; the importer's run file is the fallback.
  const apUnresolvedReport = readdirSyncSafe(reportsDir).filter((n) => /^ap-unresolved-.*\.csv$/.test(n)).sort().pop();
  const apUnresolvedRun = newestRunFile(tmp, 'runs', 'ap-aging-unresolved.csv', (p) => parseCsv(readFileSync(p, 'utf8')).length);
  const apSuggested = 'Assign the carrier leg on the load and enter the bill';
  if (apUnresolvedReport) {
    const [h, ...body] = parseCsv(readFileSync(join(reportsDir, apUnresolvedReport), 'utf8'));
    const ix = (n) => h.indexOf(n);
    for (const r of body) add('AP_UNRESOLVED', r[ix('PRO')], `in the Aljex AP aging (${dollars(Math.round(Number(r[ix('amount')]) * 100))}, ${r[ix('carrier')]}) but BCAT cannot place it: ${r[ix('reason')]}`, r[ix('suggested action')] || apSuggested);
  } else if (apUnresolvedRun) {
    for (const r of parseCsv(readFileSync(apUnresolvedRun, 'utf8')).slice(1)) add('AP_UNRESOLVED', r[0], `in the Aljex AP aging (${dollars(Math.round(Number(r[2]) * 100))}, vendor ${r[1]}) but BCAT cannot place it: ${r[3]}`, apSuggested);
  } else add('AP_UNRESOLVED', '(none yet)', 'ap-aging has not been planned or applied', 'run ap-aging first');

  // 5c. open BCAT bills that are on no Aljex list (reconcile-ap BCAT_ONLY rows), split by the dropped stale expected rows
  const apRecon = newestRunFile(tmp, 'runs', 'reconcile-ap.csv', (p) => parseCsv(readFileSync(p, 'utf8')).length);
  if (apRecon) {
    const staleFile = join(exportDir, readdirSyncSafe(exportDir).filter((n) => /^ap-expected-stale-.*\.csv$/.test(n)).sort().pop() ?? 'ap-expected-stale.csv');
    const keyOf = (pro) => String(pro ?? '').replace(/\D/g, '').replace(/^0+/, '');
    const stale = new Set(existsSync(staleFile) ? parseCsv(readFileSync(staleFile, 'utf8')).slice(1).map((r) => keyOf(r[2])) : []);
    const expectedFile = join(exportDir, readdirSyncSafe(exportDir).filter((n) => /^aljex-ap-expected-.*\.csv$/.test(n)).sort().pop() ?? 'aljex-ap-expected.csv');
    const expected = new Set(existsSync(expectedFile) ? parseCsv(readFileSync(expectedFile, 'utf8')).slice(1).map((r) => keyOf(r[2])).filter((k) => !stale.has(k)) : []);
    const [h, ...body] = parseCsv(readFileSync(apRecon, 'utf8'));
    const ix = (n) => h.indexOf(n);
    const tally = { expected: [0, 0], stale: [0, 0], none: [0, 0] };
    for (const r of body) {
      if (r[ix('outcome')] !== 'BCAT_ONLY') continue;
      const k = keyOf(r[ix('pro')]);
      const t = expected.has(k) ? tally.expected : stale.has(k) ? tally.stale : tally.none;
      t[0] += 1; t[1] += Math.round(Number(r[ix('bcat_balance')]) * 100);
    }
    add('AP open gap', 'total', `open BCAT bills not in the AP aging: ${tally.expected[0]} on the AP expected list (${dollars(tally.expected[1])}), ${tally.stale[0]} on dropped stale expected rows (${dollars(tally.stale[1])}), ${tally.none[0]} on no Aljex list (${dollars(tally.none[1])}); all stay OPEN`, 'Explains BCAT open AP being higher than the AP aging total; the 8 AP_UNRESOLVED bills are the other side');
    for (const r of body) {
      if (r[ix('outcome')] !== 'BCAT_ONLY') continue;
      const k = keyOf(r[ix('pro')]);
      if (expected.has(k)) continue; // on the AP expected list: the ap-expected step marks it
      const what = `${r[ix('carrier')]}, ${dollars(Math.round(Number(r[ix('bcat_balance')]) * 100))} open, due ${r[ix('bcat_due')]}`;
      if (stale.has(k)) add('AP_STALE_EXPECTED', r[ix('pro')], `open in BCAT, on an AP expected row that was dropped as stale (${what})`, 'Confirm with the carrier whether it is still owed; pay or close it');
      else add('AP_NOT_IN_ALJEX_LISTS', r[ix('pro')], `open in BCAT, on no Aljex AP list (${what})`, 'Confirm it is really unpaid (Aljex shows it paid or never listed it); pay, close, or leave open');
    }
  } else add('AP_NOT_IN_ALJEX_LISTS', '(none yet)', 'the AP reconcile has not run', 'run reconcile first');

  // 5d. open BCAT invoices that are not in the Aljex AR report (and amount differences), from the named AR gap report
  const arGapReport = readdirSyncSafe(reportsDir).filter((n) => /^ar-open-gap-.*\.csv$/.test(n)).sort().pop();
  if (arGapReport) {
    const [h, ...body] = parseCsv(readFileSync(join(reportsDir, arGapReport), 'utf8'));
    const ix = (n) => h.indexOf(n);
    for (const r of body) {
      const cat = r[ix('category')];
      if (cat === 'AR_PRO_NOT_IN_BCAT') continue; // already listed above as open AR gap rows (from the importer's unresolved file)
      add(cat, r[ix('PRO')], `${r[ix('customer')]}, BCAT ${r[ix('BCAT balance')] ? `$${r[ix('BCAT balance')]}` : 'n/a'} vs Aljex ${r[ix('Aljex amount')] ? `$${r[ix('Aljex amount')]}` : 'n/a'}, invoice date ${r[ix('invoice date')]} (${r[ix('age days')]} days): ${r[ix('what to check')]}`, r[ix('suggested action')]);
    }
  }

  // 6-9. customers export and master reports
  const custPath = customersFile ?? join(exportDir, readdirSyncSafe(exportDir).filter((n) => /^aljex-customers-.*\.csv$/.test(n)).sort().pop() ?? 'aljex-customers.csv');
  if (existsSync(custPath)) {
    const [h, ...body] = parseCsv(readFileSync(custPath, 'utf8'));
    const nameIx = h.findIndex((x) => ['name', 'customer'].includes(norm(x.replace(/^\uFEFF/, ''))));
    const acctIx = h.findIndex((x) => norm(x) === 'account');
    const nameOf = new Map(body.map((r) => [r[acctIx], r[nameIx]]));
    // The importer's own groups (customers + locations, normalised by the layout): customers-master-findings.csv, detail = accounts.
    const findingsCsv = newestRunFile(tmp, 'runs', 'customers-master-findings.csv', (p) => parseCsv(readFileSync(p, 'utf8')).length);
    let groups = [];
    if (findingsCsv) groups = parseCsv(readFileSync(findingsCsv, 'utf8')).slice(1).filter((r) => r[0] === 'CUSTOMER_DUPLICATE_NAME').map((r) => r[1].split(','));
    else {
      const byName = new Map();
      for (const r of body) if (norm(r[nameIx])) byName.set(norm(r[nameIx]), [...(byName.get(norm(r[nameIx])) ?? []), r[acctIx]]);
      groups = [...byName.values()].filter((x) => x.length > 1);
    }
    for (const accounts of groups.sort((x, y) => String(nameOf.get(x[0])).localeCompare(String(nameOf.get(y[0]))))) add('duplicate customer name', nameOf.get(accounts[0]) ?? accounts[0], `possible duplicate accounts ${accounts.length} (${accounts.join(', ')})`, 'Merge or rename in Aljex; BCAT imported them as separate customers');
  } else add('duplicate customer name', '(none yet)', 'customers export not found', 'place aljex-customers-<date>.csv in the export folder');
  const custReview = newestRunFile(tmp, 'runs', 'customers-master-review.csv', (p) => parseCsv(readFileSync(p, 'utf8')).length);
  if (custReview) {
    for (const [key, reason] of parseCsv(readFileSync(custReview, 'utf8')).slice(1)) {
      if (/same name exists/.test(reason)) add('name match not linked', key, reason, 'Decide whether this is the existing customer and merge');
      else add('billing method needs review', key, reason, 'Set the billing method on the customer');
    }
  } else for (const c of ['billing method needs review', 'name match not linked']) add(c, '(none yet)', 'no customers master run found', 'rerun customers dry run to list');
  const carrSummary = newestRunFile(tmp, 'runs', 'carriers-master-summary.json');
  const sameName = carrSummary ? readJson(carrSummary).summary?.sameNameDifferentCarrier : undefined;
  add('same name, different carrier', 'count', `${sameName ?? 'unknown'} carrier name(s) are used by more than one carrier (names are not persisted)`, 'rerun carriers dry run to list');
  return rows;
}

function readdirSyncSafe(d) { return existsSync(d) ? readdirSync(d) : []; }

export function writeChecks(opts) {
  const rows = buildChecks(opts);
  mkdirSync(opts.reportsDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.reportsDir, 0o700);
  const path = join(opts.reportsDir, `post-load-checks-${opts.date}.csv`);
  writeFileSync(path, csvOut([HEADER, ...rows]), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, rows: rows.length, byCategory: rows.reduce((m, r) => ({ ...m, [r[0]]: (m[r[0]] ?? 0) + 1 }), {}) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const reportsDir = process.env.AW_REPORTS_DIR ?? join(EXPORT_DIR, 'reports');
  const res = writeChecks({ date: val('date') ?? localDate(), reportsDir, customersFile: val('customers') });
  console.log(`post-load checks: ${res.rows} row(s) -> ${res.path} (0600; PII, outside the repo)`);
  console.log(`  by category: ${Object.entries(res.byCategory).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
