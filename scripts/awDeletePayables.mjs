#!/usr/bin/env node
/**
 * Delete the OPEN payables dated 2025: every CarrierBill with billDate in 2025 and balanceCents > 0 (status TO_BE_PAID /
 * PARTIAL), nothing else. Ryne's decision (2026-11-09): 23 bills, 11 TO_BE_PAID + 12 PARTIAL, $14,730.21; the 1,360 paid
 * 2025 bills and everything else stay. Same machinery as scripts/awPreDelete.mjs (selection -> plan -> conservation proof ->
 * verified export -> conditional, idempotent, checkpointed apply -> restore), see scripts/lib/deletePayables.mjs for the rules
 * (payment split, LoadCarrier release).
 *
 *   dry run (read-only; counts, dollars, conservation proof, deviations, 0600 reports):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awDeletePayables.mjs --target prod --i-mean-production
 *   backup (< 6 h before the apply; the tables in scripts/lib/prodWriteSets.mjs awDeletePayables):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awDeletePayables --target prod --i-mean-production --apply
 *   apply (export first, then payments, legs, audit rows, bills):
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-delpayables node scripts/awDeletePayables.mjs \
 *       --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *   restore (put-if-absent; conditional revert of the edited rows; dry unless --apply; same gate):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awDeletePayables.mjs --restore ~/bcat-ops-backups/pre-delete-payables-2025 --target prod --i-mean-production [--apply ...]
 *
 * Never touched: AR/invoices, loads, shipments, orders, charges, paid bills, FactoringItem, TmsSettings, AuditLog (kept; +1 row per bill).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { verifyExport } from './lib/preDelete.mjs';
import { deleteRow, modifyPayment } from './awPreDelete.mjs';
import {
  CONFIRM_SUFFIX, EXPORT_DIR_NAME, SCRIPT, auditItems, buildManifest, conservationProof, deviations, dollars, exportFiles, fieldPatch,
  missingFromExport, planDeletePayables, removedTotals, toJsonLine,
} from './lib/deletePayables.mjs';

export { SCRIPT, EXPORT_DIR_NAME };
export const defaultExportDir = () => join(homedir(), 'bcat-ops-backups', EXPORT_DIR_NAME);

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function deletePayablesGate(values, deps = {}) {
  const apply = values.apply === true;
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awDeletePayables.models, readOnly: !apply, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-${CONFIRM_SUFFIX}`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) {
      throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
    }
  }
  return gate;
}

async function scanAll(doc, table) {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

// ───────────────────────────── executors (take a DocumentClient-like `doc`) ─────────────────────────────

async function pool(items, size, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const n = i; i += 1; await fn(items[n]); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}
const isCondFail = (err) => err?.name === 'ConditionalCheckFailedException';

/** Delete one bill only while it is still the open bill the plan read (never one that became PAID/VOID or moved). 'deleted' | 'changed'. */
export async function deleteBill({ doc, suffix, row }) {
  assertWritableSuffix(suffix, 'CarrierBill delpayables');
  try {
    await doc.send(new DeleteCommand({
      TableName: `CarrierBill-${suffix}`, Key: { id: row.id },
      ConditionExpression: 'attribute_exists(id) AND #st = :st AND balanceCents = :bal AND paidCents = :paid AND billDate = :bd',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':st': row.status, ':bal': row.balanceCents, ':paid': row.paidCents ?? 0, ':bd': row.billDate },
    }));
    return 'deleted';
  } catch (err) {
    if (isCondFail(err)) return 'changed';
    throw err;
  }
}

/** Turn a LoadCarrier from `from` into `to` (release on apply, revert on restore), conditional on every patched field. 'patched' | 'changed' | 'noop'. */
export async function patchLeg({ doc, suffix, from, to }) {
  assertWritableSuffix(suffix, 'LoadCarrier delpayables');
  const p = fieldPatch(from, to);
  if (!p) return 'noop';
  try {
    await doc.send(new UpdateCommand({ TableName: `LoadCarrier-${suffix}`, Key: { id: from.id }, ...p }));
    return 'patched';
  } catch (err) {
    if (isCondFail(err)) return 'changed';
    throw err;
  }
}

async function putAudit({ doc, suffix, item }) {
  assertWritableSuffix(suffix, 'AuditLog delpayables');
  try {
    await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: item, ConditionExpression: 'attribute_not_exists(id)' }));
    return 'written';
  } catch (err) {
    if (isCondFail(err)) return 'exists';
    throw err;
  }
}

/** Write the export (dir 0700, files 0600) and verify it from disk; reuse + verify an existing manifest. Returns {manifest, rows, reused}. */
export function writeAndVerifyExport({ dir, plan, suffix, fs = { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync }, now = new Date() }) {
  const manifestPath = join(dir, 'manifest.json');
  const files = exportFiles(plan);
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.suffix !== suffix) throw new Error(`export dir ${dir} belongs to ${manifest.suffix}, not ${suffix}`);
    const rows = verifyExport(manifest, (name) => fs.readFileSync(join(dir, name), 'utf8'));
    const missing = missingFromExport(plan, rows);
    if (missing.length) throw new Error(`export dir ${dir} does not hold ${missing.length} row(s) the plan needs (first: ${missing[0]}); move it aside and re-export`);
    return { manifest, rows, reused: true };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  if (fs.readdirSync(dir).length) throw new Error(`export dir ${dir} has files but no manifest.json: refusing to overwrite; move it aside`);
  for (const [name, f] of Object.entries(files)) fs.writeFileSync(join(dir, name), f.text, { mode: 0o600 });
  const manifest = buildManifest({ files, suffix, now });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const rows = verifyExport(manifest, (name) => fs.readFileSync(join(dir, name), 'utf8'));
  const missing = missingFromExport(plan, rows);
  if (missing.length) throw new Error(`export verification failed: ${missing.length} planned rows missing`);
  return { manifest, rows, reused: false };
}

/**
 * Execute the plan: payment edits, payment deletes, leg releases, AuditLog, then the bills last. Refuses a step unless its
 * export file is in `verifiedFiles`. Idempotent: every write is conditional.
 */
export async function applyPlan({ doc, suffix, plan, verifiedFiles, checkpoint = () => {}, now = new Date(), concurrency = 8, log = () => {} }) {
  assertWritableSuffix(suffix, 'delpayables');
  const needs = (name, count) => { if (count && !verifiedFiles.has(name)) throw new Error(`refusing: export file ${name} is not written and verified`); };
  const out = {};
  const bump = (k, r) => { out[k] = out[k] ?? {}; out[k][r] = (out[k][r] ?? 0) + 1; };
  const step = (k) => { checkpoint(k, out[k] ?? {}); log(`${k}: ${JSON.stringify(out[k] ?? {})}`); };
  needs('ApPayment.modify.jsonl', plan.modifies.ApPayment.length);
  needs('ApPayment.delete.jsonl', plan.deletes.ApPayment.length);
  needs('LoadCarrier.modify.jsonl', plan.modifies.LoadCarrier.length);
  needs('CarrierBill.delete.jsonl', plan.deletes.CarrierBill.length);
  await pool(plan.modifies.ApPayment, concurrency, async (entry) => bump('ApPayment.modify', await modifyPayment({ doc, suffix, model: 'ApPayment', entry })));
  step('ApPayment.modify');
  await pool(plan.deletes.ApPayment, concurrency, async (row) => bump('ApPayment.delete', await deleteRow({ doc, suffix, model: 'ApPayment', row })));
  step('ApPayment.delete');
  await pool(plan.modifies.LoadCarrier, concurrency, async ({ before, after }) => bump('LoadCarrier.release', await patchLeg({ doc, suffix, from: before, to: after })));
  step('LoadCarrier.release');
  await pool(auditItems(plan, now), concurrency, async (item) => bump('AuditLog.put', await putAudit({ doc, suffix, item })));
  step('AuditLog.put');
  await pool(plan.deletes.CarrierBill, concurrency, async (row) => bump('CarrierBill.delete', await deleteBill({ doc, suffix, row })));
  step('CarrierBill.delete');
  return out;
}

/** Restore from a verified export: put-if-absent for deleted rows, conditional revert for the edited payments and legs. */
export async function restoreExport({ doc, suffix, rows, apply, concurrency = 8 }) {
  if (apply) assertWritableSuffix(suffix, 'delpayables restore');
  const out = {};
  const bump = (k, r) => { out[k] = out[k] ?? {}; out[k][r] = (out[k][r] ?? 0) + 1; };
  const table = (m) => `${m}-${suffix}`;
  for (const model of ['CarrierBill', 'ApPayment']) {
    await pool(rows[`${model}.delete.jsonl`] ?? [], concurrency, async (item) => {
      if (!apply) {
        const r = await doc.send(new GetCommand({ TableName: table(model), Key: { id: item.id } }));
        bump(`${model}.put`, r.Item ? 'present' : 'wouldPut');
        return;
      }
      try {
        await doc.send(new PutCommand({ TableName: table(model), Item: item, ConditionExpression: 'attribute_not_exists(id)' }));
        bump(`${model}.put`, 'put');
      } catch (err) {
        if (!isCondFail(err)) throw err;
        bump(`${model}.put`, 'present');
      }
    });
  }
  await pool(rows['ApPayment.modify.jsonl'] ?? [], concurrency, async ({ before, after }) => {
    if (!apply) {
      const r = await doc.send(new GetCommand({ TableName: table('ApPayment'), Key: { id: before.id } }));
      bump('ApPayment.revert', !r.Item ? 'missing' : r.Item.amountCents === after.amountCents ? 'wouldRevert' : r.Item.amountCents === before.amountCents ? 'present' : 'changed');
      return;
    }
    try {
      await doc.send(new PutCommand({
        TableName: table('ApPayment'), Item: before,
        ConditionExpression: 'attribute_exists(id) AND amountCents = :a AND appliedCents = :p AND unappliedCents = :u',
        ExpressionAttributeValues: { ':a': after.amountCents, ':p': after.appliedCents, ':u': after.unappliedCents },
      }));
      bump('ApPayment.revert', 'reverted');
    } catch (err) {
      if (!isCondFail(err)) throw err;
      bump('ApPayment.revert', 'skipped');
    }
  });
  await pool(rows['LoadCarrier.modify.jsonl'] ?? [], concurrency, async ({ before, after }) => {
    if (!apply) {
      const r = await doc.send(new GetCommand({ TableName: table('LoadCarrier'), Key: { id: before.id } }));
      const same = (row, ref) => row.apStatus === ref.apStatus && row.apStatusChangedAt === ref.apStatusChangedAt && row.invoiceId === ref.invoiceId;
      bump('LoadCarrier.revert', !r.Item ? 'missing' : same(r.Item, after) ? 'wouldRevert' : same(r.Item, before) ? 'present' : 'changed');
      return;
    }
    const res = await patchLeg({ doc, suffix, from: after, to: before });
    bump('LoadCarrier.revert', res === 'patched' ? 'reverted' : res === 'changed' ? 'skipped' : 'present');
  });
  return out;
}

// ───────────────────────────── reports ─────────────────────────────

const csvq = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const write0600 = (path, text, fs = { writeFileSync, chmodSync }) => { fs.writeFileSync(path, text, { mode: 0o600 }); fs.chmodSync(path, 0o600); };

export function billsCsv(plan) {
  const leg = new Map(plan.modifies.LoadCarrier.map((x) => [x.billId, x]));
  const lines = ['bill id,bill number,bill date,status,carrier id,carrier name,shipment id,billed cents,paid cents,balance cents,leg id,leg action'];
  for (const b of plan.deletes.CarrierBill) {
    const l = leg.get(b.id);
    lines.push([b.id, b.billNumber ?? '', b.billDate, b.status, b.carrierId ?? '', b.carrierName ?? '', b.shipmentId ?? '', b.billedCents ?? 0, b.paidCents ?? 0, b.balanceCents ?? 0, b.loadCarrierId ?? '', l ? l.reason : 'LEG_UNTOUCHED'].map(csvq).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** One JSON line per edited or deleted payment (the mixed-payment list). */
export function mixedPaymentLines(plan) {
  const out = [];
  for (const x of plan.modifies.ApPayment) {
    out.push(toJsonLine({
      action: 'MODIFY', id: x.before.id, carrierId: x.before.carrierId ?? null, kind: x.before.kind ?? null, reason: x.reason,
      amountCents: x.before.amountCents, removedCents: x.removedCents, afterAmountCents: x.after.amountCents,
      appliedBefore: x.before.appliedCents, appliedAfter: x.after.appliedCents, unapplied: x.before.unappliedCents,
      appsBefore: x.before.applications, appsAfter: x.after.applications,
    }));
  }
  for (const p of plan.deletes.ApPayment) {
    out.push(toJsonLine({ action: 'DELETE', id: p.id, carrierId: p.carrierId ?? null, kind: p.kind ?? null, reason: 'ONLY_DELETED_BILLS', amountCents: p.amountCents, unapplied: p.unappliedCents, apps: p.applications }));
  }
  return out;
}

const AP_KEY = /^ap[A-Z]|bill/i;
/** Read-only: which AP-ish attributes live on the parents of the deleted bills (evidence that only LoadCarrier carries AP state). */
async function inspectParents(doc, suffix, bills) {
  const keys = {};
  for (const [model, field] of [['Load', 'loadId'], ['Order', 'orderId'], ['Shipment', 'shipmentId'], ['LoadFinancials', 'loadId']]) {
    const ids = [...new Set(bills.map((b) => b[field]).filter(Boolean))];
    const found = new Set();
    let n = 0;
    for (const id of ids) {
      const r = await doc.send(new GetCommand({ TableName: `${model}-${suffix}`, Key: { id } }));
      if (!r.Item) continue;
      n += 1;
      for (const k of Object.keys(r.Item)) if (AP_KEY.test(k)) found.add(k);
    }
    keys[model] = { rowsFound: n, apLikeKeys: [...found].sort() };
  }
  return keys;
}

async function main() {
  const { values } = parseArgs({
    options: {
      restore: { type: 'string' }, 'export-dir': { type: 'string' }, 'report-dir': { type: 'string' }, 'accept-deviations': { type: 'boolean' },
      apply: { type: 'boolean' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS,
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Usage: node scripts/awDeletePayables.mjs [--export-dir <dir>] [--report-dir <dir>] [--accept-deviations] [--apply]\n       node scripts/awDeletePayables.mjs --restore <export dir> [--apply]\n${PROD_GATE_USAGE}\nDry run unless --apply.`);
    return;
  }
  const gate = await deletePayablesGate(values);
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });

  if (values.restore) {
    const dir = values.restore;
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    if (manifest.script !== SCRIPT) throw new Error(`export in ${dir} was written by ${manifest.script}, not ${SCRIPT}`);
    if (manifest.suffix !== suffix) throw new Error(`export in ${dir} was taken from ${manifest.suffix}, not ${suffix}`);
    const rows = verifyExport(manifest, (name) => readFileSync(join(dir, name), 'utf8'));
    console.log(`export verified: ${Object.keys(manifest.files).length} files, ${Object.values(manifest.files).reduce((a, f) => a + f.count, 0)} rows (created ${manifest.createdAt})`);
    const res = await restoreExport({ doc, suffix, rows, apply });
    console.log(apply ? 'RESTORED' : 'DRY RUN: nothing written.', JSON.stringify(res));
    return;
  }

  const T = (m) => `${m}-${suffix}`;
  const [CarrierBill, ApPayment, LoadCarrier] = await Promise.all(['CarrierBill', 'ApPayment', 'LoadCarrier'].map((m) => scanAll(doc, T(m))));
  const data = { CarrierBill, ApPayment, LoadCarrier };
  const plan = planDeletePayables(data, { now: new Date() });
  const removed = removedTotals(plan);
  const proof = conservationProof(data, plan);
  const devs = deviations({ selection: plan.selection, removed, proof });
  const parents = await inspectParents(doc, suffix, plan.deletes.CarrierBill);

  console.log(`tables scanned: CarrierBill ${CarrierBill.length}, ApPayment ${ApPayment.length}, LoadCarrier ${LoadCarrier.length}`);
  console.log(`bills dated 2025: ${plan.selection.total2025} (PAID kept ${plan.selection.paid2025}; open to DELETE ${plan.selection.delete.length}; other kept ${plan.selection.other2025.length} ${JSON.stringify(plan.selection.other2025.map((b) => `${b.id}:${b.status}`).slice(0, 10))})`);
  console.log('HARD GUARANTEES ok: no PAID/VOID bill, none dated outside 2025, none without an open balance; AR/invoices/loads/shipments/orders are not scanned for writing');
  console.log('rows to DELETE per table', JSON.stringify({ CarrierBill: plan.deletes.CarrierBill.length, ApPayment: plan.deletes.ApPayment.length }));
  console.log('rows to MODIFY per table', JSON.stringify({ ApPayment: plan.modifies.ApPayment.length, LoadCarrier: plan.modifies.LoadCarrier.length }), 'payment mixed by reason', JSON.stringify(plan.modifies.ApPayment.reduce((o, x) => ({ ...o, [x.reason]: (o[x.reason] ?? 0) + 1 }), {})));
  console.log(`bills removed ${removed.bills.count} ${JSON.stringify(removed.bills.byStatus)}: billed ${dollars(removed.bills.billedCents)}, paid ${dollars(removed.bills.paidCents)}, credited ${dollars(removed.bills.creditedCents)}, open ${dollars(removed.bills.openCents)}; open by status ${JSON.stringify(Object.fromEntries(Object.entries(removed.bills.openCentsByStatus).map(([k, v]) => [k, dollars(v)])))}`);
  console.log(`AP payments: delete ${removed.apPayments.deleted} (${dollars(removed.apPayments.deletedCents)} money-out records), modify ${removed.apPayments.modified} (application dollars removed ${dollars(removed.apPayments.modifiedRemovedCents)}); kept untouched ${plan.notes.apKept}`);
  console.log('plan notes', JSON.stringify(plan.notes));
  console.log('parents of the deleted bills (AP-like attributes found; only LoadCarrier is edited)', JSON.stringify(parents));
  console.log('CONSERVATION BEFORE', JSON.stringify(proof.before));
  console.log('CONSERVATION AFTER ', JSON.stringify(proof.after));
  console.log(`  whole-table open AP ${dollars(proof.before.openApCents)} -> ${dollars(proof.after.openApCents)} (drops ${dollars(proof.before.openApCents - proof.after.openApCents)}); retained paid AP ${dollars(proof.before.paidApCents - removed.bills.paidCents)} -> ${dollars(proof.after.paidApCents)} (paid bills ${proof.after.paidBills})`);
  console.log('  checks', JSON.stringify(proof.checks), proof.ok ? 'PROOF OK' : 'PROOF FAILED');
  const topCarriers = Object.entries(proof.carriers.removed).sort((a, b) => b[1].openCents - a[1].openCents).slice(0, 10);
  console.log(`carrier totals removed (${Object.keys(proof.carriers.removed).length} carriers; top by open $)`, JSON.stringify(topCarriers.map(([k, v]) => [k, v.bills, dollars(v.openCents)])));
  for (const b of plan.blockers.slice(0, 20)) console.log(`BLOCKER ${b}`);
  if (plan.blockers.length) console.log(`BLOCKERS ${plan.blockers.length}`);
  for (const d of devs) console.log(`DEVIATION from Ryne's numbers: ${d}`);
  if (!devs.length) console.log("no deviations from Ryne's numbers");

  const reportDir = values['report-dir'] ?? join(homedir(), 'aljex-export', 'reports');
  mkdirSync(reportDir, { recursive: true });
  const stamp = localDate(new Date());
  const mixed = mixedPaymentLines(plan);
  write0600(join(reportDir, `delpayables-bills-${stamp}.csv`), billsCsv(plan));
  write0600(join(reportDir, `delpayables-mixed-payments-${stamp}.jsonl`), `${mixed.join('\n')}${mixed.length ? '\n' : ''}`);
  console.log(`reports (0600) in ${reportDir}: delpayables-bills-${stamp}.csv (${plan.deletes.CarrierBill.length} bills), delpayables-mixed-payments-${stamp}.jsonl (${mixed.length} payments)`);

  if (!apply) {
    console.log('DRY RUN: nothing written.');
    return;
  }
  if (plan.blockers.length) throw new Error(`refusing to apply: ${plan.blockers.length} blocker(s)`);
  if (!proof.ok) throw new Error('refusing to apply: the conservation proof failed');
  if (devs.length && !values['accept-deviations']) throw new Error(`refusing to apply: ${devs.length} deviation(s) from Ryne's numbers (re-run with --accept-deviations once Ryne confirms the new numbers)`);
  const dir = values['export-dir'] ?? defaultExportDir();
  const { manifest, rows, reused } = writeAndVerifyExport({ dir, plan, suffix });
  console.log(`export ${reused ? 'reused' : 'written'} and verified in ${dir}: ${Object.keys(manifest.files).length} files, ${Object.values(manifest.files).reduce((a, f) => a + f.count, 0)} rows`);
  const verifiedFiles = new Set(Object.keys(rows));
  const cp = join(dir, 'apply.checkpoint.json');
  const done = existsSync(cp) ? JSON.parse(readFileSync(cp, 'utf8')) : {};
  const out = await applyPlan({
    doc, suffix, plan, verifiedFiles, log: console.log,
    checkpoint: (stepName, counts) => { done[stepName] = counts; writeFileSync(cp, JSON.stringify({ ...done, savedAt: new Date().toISOString() }), { mode: 0o600 }); },
  });
  console.log('APPLIED', JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
