#!/usr/bin/env node
/**
 * Pre-2025 data delete: remove the migrated Aljex shipments whose Aljex SHIP DATE is before a cutoff (default 2025-01-01)
 * with everything attached, while keeping every retained dollar. Ryne approved the cutoff (2026-11-08); the line is the SHIP
 * DATE from the Aljex export joined by PRO to Shipment.number, not the PRO. Run the APPLY only after Ryne's reconcile
 * run is finished and he says so.
 *
 *   dry run (read-only, prints exact counts, the conservation proof and deviations from Ryne's expectations):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awPreDelete.mjs --export ~/aljex-export/aljex-full-export-2026-11-07.csv \
 *       --target prod --i-mean-production [--ship-before 2025-01-01] [--cross-check /tmp/old_by_shipdate.json]
 *   backup (< 6 h before the apply; the tables in scripts/lib/prodWriteSets.mjs awPreDelete):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awPreDelete --target prod --i-mean-production --apply
 *   apply (export first, then payments, then children before parents):
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-predelete node scripts/awPreDelete.mjs --export <csv> \
 *       --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *   restore (put-if-absent; dry unless --apply; same gate):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awPreDelete.mjs --restore ~/bcat-ops-backups/pre-delete-2025 --target prod --i-mean-production [--apply ...]
 *
 * Selection: numeric Shipment.number + legacyImported only (never an L<pro> original); no / conflicting Ship Date => KEPT and
 * listed. Deleted with their shipment: Order, Load, LoadCarrier, LoadFinancials, LoadCharge, Invoice, CarrierBill, ProClaim,
 * LegacyAljexRow. A payment that also pays a retained invoice/bill is NOT deleted: only the old application lines go and
 * amount/applied are reduced by exactly the removed application dollars (unapplied is untouched), so applied+unapplied still
 * equals amount and every retained dollar conserves. A payment whose only applications are old AND has unapplied credit keeps
 * that credit (amount = unapplied). AuditLog is kept (one AW_PREDELETE row per shipment is added). Never touched:
 * FactoringItem, TmsSettings (the PRO counter), notices/messages, S3 documents, DashboardRollup (recomputed by its Lambda).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { createCsvParser } from './lib/csvStream.mjs';
import {
  DEFAULT_SHIP_BEFORE, DELETE_ORDER, KEY_FIELD, MODIFY_MODELS, RESTORE_ORDER, assertShipBefore, auditItems, buildManifest, conservationProof,
  deviations, dollars, exportFiles, indexShipDates, isPureNumeric, missingFromExport, planPreDelete, removedTotals,
  selectShipments, toJsonLine, verifyExport, wholeTableDrop,
} from './lib/preDelete.mjs';

export const SCRIPT = 'awPreDelete';
export const EXPORT_DIR_NAME = 'pre-delete-2025';
export const defaultExportDir = () => join(homedir(), 'bcat-ops-backups', EXPORT_DIR_NAME);

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function preDeleteGate(values, deps = {}) {
  const apply = values.apply === true;
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awPreDelete.models, readOnly: !apply, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-predelete`;
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

/** Stream the export into `{pro, shipDate}` raw strings by header name. */
export async function readShipDates(path) {
  const rows = [];
  let cols = null;
  const parser = createCsvParser((r) => {
    if (!cols) {
      const at = (name) => r.findIndex((h) => h.trim().toLowerCase() === name);
      cols = { pro: at('pro #'), shipDate: at('ship date') };
      for (const [k, v] of Object.entries(cols)) if (v < 0) throw new Error(`export column missing: ${k}`);
      return;
    }
    rows.push({ pro: r[cols.pro] ?? '', shipDate: r[cols.shipDate] ?? '' });
  });
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) parser.write(chunk);
  parser.end();
  return rows;
}

/** Hard guarantees: never an L<pro> original, never a non-legacy shipment, never a PRO that does not parse as numeric. */
export function assertHardGuarantees(selection, shipments) {
  const bad = selection.delete.filter((s) => !isPureNumeric(s.number) || s.legacyImported !== true || /^l/i.test(String(s.number).trim()));
  if (bad.length) throw new Error(`HARD GUARANTEE VIOLATED: ${bad.length} selected shipment(s) are not pure-numeric legacy rows`);
  const lOriginals = shipments.filter((s) => /^L\d/i.test(String(s.number).trim()));
  const ids = new Set(selection.delete.map((s) => s.id));
  if (lOriginals.some((s) => ids.has(s.id))) throw new Error('HARD GUARANTEE VIOLATED: an L<pro> original is in the delete set');
  return { lOriginals: lOriginals.length };
}

// ───────────────────────────── executors (take a DocumentClient-like `doc`) ─────────────────────────────

async function pool(items, size, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const n = i; i += 1; await fn(items[n]); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}
const isCondFail = (err) => err?.name === 'ConditionalCheckFailedException';

/** Delete one row only if it still has the planned key value. 'deleted' | 'changed' (gone or moved). */
export async function deleteRow({ doc, suffix, model, row }) {
  assertWritableSuffix(suffix, `${model} predelete`);
  const field = KEY_FIELD[model];
  const names = {};
  const values = {};
  const parts = ['attribute_exists(id)'];
  if (MODIFY_MODELS.includes(model)) {
    for (const f of ['amountCents', 'appliedCents', 'unappliedCents']) { names[`#${f}`] = f; values[`:${f}`] = row[f]; parts.push(`#${f} = :${f}`); }
  } else if (field && field !== 'id' && row[field] != null) {
    names['#k'] = field; values[':k'] = row[field]; parts.push('#k = :k');
  }
  try {
    await doc.send(new DeleteCommand({
      TableName: `${model}-${suffix}`, Key: { id: row.id }, ConditionExpression: parts.join(' AND '),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names, ExpressionAttributeValues: values } : {}),
    }));
    return 'deleted';
  } catch (err) {
    if (isCondFail(err)) return 'changed';
    throw err;
  }
}

/** Apply a planned payment edit, conditional on the amounts the plan read. */
export async function modifyPayment({ doc, suffix, model, entry }) {
  assertWritableSuffix(suffix, `${model} predelete`);
  const { before, after } = entry;
  const hasInvoiceId = model === 'ArPayment' && before.invoiceId !== after.invoiceId;
  try {
    await doc.send(new UpdateCommand({
      TableName: `${model}-${suffix}`, Key: { id: before.id },
      UpdateExpression: `SET applications = :apps, appliedCents = :applied, amountCents = :amount${hasInvoiceId ? ', invoiceId = :inv' : ''}`,
      ConditionExpression: 'attribute_exists(id) AND amountCents = :bAmount AND appliedCents = :bApplied AND unappliedCents = :bUnapplied',
      ExpressionAttributeValues: {
        ':apps': after.applications, ':applied': after.appliedCents, ':amount': after.amountCents,
        ':bAmount': before.amountCents, ':bApplied': before.appliedCents, ':bUnapplied': before.unappliedCents,
        ...(hasInvoiceId ? { ':inv': after.invoiceId } : {}),
      },
    }));
    return 'modified';
  } catch (err) {
    if (isCondFail(err)) return 'changed';
    throw err;
  }
}

async function putAudit({ doc, suffix, item }) {
  assertWritableSuffix(suffix, 'AuditLog predelete');
  try {
    await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: item, ConditionExpression: 'attribute_not_exists(id)' }));
    return 'written';
  } catch (err) {
    if (isCondFail(err)) return 'exists';
    throw err;
  }
}

/** Write the export (dir 0700, files 0600) and verify it from disk; reuse + verify an existing manifest. Returns {manifest, rows}. */
export function writeAndVerifyExport({ dir, plan, suffix, shipBefore, fs = { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync }, now = new Date() }) {
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
  const manifest = buildManifest({ files, suffix, shipBefore, now });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const rows = verifyExport(manifest, (name) => fs.readFileSync(join(dir, name), 'utf8'));
  const missing = missingFromExport(plan, rows);
  if (missing.length) throw new Error(`export verification failed: ${missing.length} planned rows missing`);
  return { manifest, rows, reused: false };
}

/**
 * Execute the plan: payments first (modify, then delete), then children before parents, AuditLog right before Shipment.
 * Refuses a model's step unless its export file is in `verifiedFiles`. Idempotent: every write is conditional.
 */
export async function applyPlan({ doc, suffix, plan, verifiedFiles, checkpoint = () => {}, now = new Date(), concurrency = 8, log = () => {} }) {
  assertWritableSuffix(suffix, 'predelete');
  const needs = (name, count) => { if (count && !verifiedFiles.has(name)) throw new Error(`refusing: export file ${name} is not written and verified`); };
  const out = {};
  const bump = (k, r) => { out[k] = out[k] ?? {}; out[k][r] = (out[k][r] ?? 0) + 1; };
  for (const model of MODIFY_MODELS) {
    needs(`${model}.modify.jsonl`, plan.modifies[model].length);
    await pool(plan.modifies[model], concurrency, async (entry) => bump(`${model}.modify`, await modifyPayment({ doc, suffix, model, entry })));
    checkpoint(`${model}.modify`, out[`${model}.modify`] ?? {});
  }
  for (const model of DELETE_ORDER) {
    const rows = plan.deletes[model] ?? [];
    needs(`${model}.delete.jsonl`, rows.length);
    if (model === 'Shipment') {
      await pool(auditItems(plan, now), concurrency, async (item) => bump('AuditLog.put', await putAudit({ doc, suffix, item })));
      checkpoint('AuditLog.put', out['AuditLog.put'] ?? {});
    }
    await pool(rows, concurrency, async (row) => bump(`${model}.delete`, await deleteRow({ doc, suffix, model, row })));
    checkpoint(`${model}.delete`, out[`${model}.delete`] ?? {});
    log(`${model}: ${JSON.stringify(out[`${model}.delete`] ?? {})}`);
  }
  return out;
}

/** Restore from a verified export: put-if-absent for deleted rows, conditional revert for modified payments. */
export async function restoreExport({ doc, suffix, manifest, rows, apply, concurrency = 8 }) {
  if (apply) assertWritableSuffix(suffix, 'predelete restore');
  const out = {};
  const bump = (k, r) => { out[k] = out[k] ?? {}; out[k][r] = (out[k][r] ?? 0) + 1; };
  const table = (m) => `${m}-${suffix}`;
  const order = [...RESTORE_ORDER];
  for (const model of order) {
    const items = rows[`${model}.delete.jsonl`] ?? [];
    await pool(items, concurrency, async (item) => {
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
  for (const model of MODIFY_MODELS) {
    const items = rows[`${model}.modify.jsonl`] ?? [];
    await pool(items, concurrency, async ({ before, after }) => {
      if (!apply) {
        const r = await doc.send(new GetCommand({ TableName: table(model), Key: { id: before.id } }));
        bump(`${model}.revert`, !r.Item ? 'missing' : r.Item.amountCents === after.amountCents ? 'wouldRevert' : r.Item.amountCents === before.amountCents ? 'present' : 'changed');
        return;
      }
      try {
        await doc.send(new PutCommand({
          TableName: table(model), Item: before,
          ConditionExpression: 'attribute_exists(id) AND amountCents = :a AND appliedCents = :p AND unappliedCents = :u',
          ExpressionAttributeValues: { ':a': after.amountCents, ':p': after.appliedCents, ':u': after.unappliedCents },
        }));
        bump(`${model}.revert`, 'reverted');
      } catch (err) {
        if (!isCondFail(err)) throw err;
        bump(`${model}.revert`, 'skipped');
      }
    });
  }
  return out;
}

// ───────────────────────────── reports ─────────────────────────────

const csvq = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const write0600 = (path, text, fs = { writeFileSync, chmodSync }) => { fs.writeFileSync(path, text, { mode: 0o600 }); fs.chmodSync(path, 0o600); };

export function reviewCsv(selection) {
  const lines = ['PRO,reason'];
  for (const [reason, list] of [['NO_SHIP_DATE', selection.noShipDate], ['CONFLICTING_SHIP_DATES', selection.ambiguous], ['NOT_IN_EXPORT', selection.notInExport]]) {
    for (const s of list) lines.push([s.number, reason].map(csvq).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function mixedPaymentLines(plan) {
  const out = [];
  for (const model of MODIFY_MODELS) {
    for (const x of plan.modifies[model]) {
      out.push(toJsonLine({
        model, id: x.before.id, party: x.before.customerId ?? x.before.carrierId ?? null, kind: x.before.kind ?? null, reason: x.reason,
        amountCents: x.before.amountCents, removedCents: x.removedCents, afterAmountCents: x.after.amountCents,
        appliedBefore: x.before.appliedCents, appliedAfter: x.after.appliedCents, unapplied: x.before.unappliedCents,
      }));
    }
  }
  return out;
}

const histogram = (rows, f) => { const o = {}; for (const r of rows) { const k = String(f(r)); o[k] = (o[k] ?? 0) + 1; } return o; };

async function main() {
  const { values } = parseArgs({
    options: {
      export: { type: 'string' }, 'ship-before': { type: 'string' }, 'cross-check': { type: 'string' }, 'export-dir': { type: 'string' },
      restore: { type: 'string' }, 'report-dir': { type: 'string' }, 'accept-deviations': { type: 'boolean' },
      apply: { type: 'boolean' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS,
    },
    allowPositionals: false,
  });
  if (values.help || (!values.export && !values.restore)) {
    console.log(`Usage: node scripts/awPreDelete.mjs --export <aljex-full-export.csv> [--ship-before ${DEFAULT_SHIP_BEFORE}] [--cross-check <json>] [--export-dir <dir>] [--accept-deviations] [--apply]\n       node scripts/awPreDelete.mjs --restore <export dir> [--apply]\n${PROD_GATE_USAGE}\nDry run unless --apply.`);
    return;
  }
  const gate = await preDeleteGate(values);
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
    if (manifest.suffix !== suffix) throw new Error(`export in ${dir} was taken from ${manifest.suffix}, not ${suffix}`);
    const rows = verifyExport(manifest, (name) => readFileSync(join(dir, name), 'utf8'));
    console.log(`export verified: ${Object.keys(manifest.files).length} files, ${Object.values(manifest.files).reduce((a, f) => a + f.count, 0)} rows (created ${manifest.createdAt})`);
    const res = await restoreExport({ doc, suffix, manifest, rows, apply });
    console.log(apply ? 'RESTORED' : 'DRY RUN: nothing written.', JSON.stringify(res));
    return;
  }

  const shipBefore = assertShipBefore(values['ship-before'] ?? DEFAULT_SHIP_BEFORE);
  const T = (m) => `${m}-${suffix}`;
  const models = [...new Set([...DELETE_ORDER, 'FactoringItem'])];
  const [dates, ...scans] = await Promise.all([readShipDates(values.export), ...models.map((m) => scanAll(doc, T(m)))]);
  const data = Object.fromEntries(models.map((m, i) => [m, scans[i]]));
  const shipDates = indexShipDates(dates);
  const selection = selectShipments({ shipments: data.Shipment, shipDates, shipBefore });
  const guar = assertHardGuarantees(selection, data.Shipment);
  const plan = planPreDelete(data, selection);
  const removed = removedTotals(plan);
  const proof = conservationProof(data, plan);
  const drop = wholeTableDrop(data, plan);
  const devs = deviations({ selection, removed, proof });

  console.log(`ship-before ${shipBefore}; export PROs ${shipDates.size}; Shipment rows ${data.Shipment.length}`);
  console.log(`HARD GUARANTEES ok: L originals ${guar.lOriginals} untouched (0 in delete set); only pure-numeric legacyImported rows selected; non-candidates ${selection.notCandidate}`);
  console.log(`selection: candidates ${selection.candidates}; DELETE ${selection.delete.length}; keep ${selection.keep.length}; no ship date ${selection.noShipDate.length}; conflicting ${selection.ambiguous.length}; not in export ${selection.notInExport.length}`);
  console.log('delete set by Aljex ship-date year', JSON.stringify(histogram(selection.delete, (s) => s.__shipDate.slice(0, 4))), `(placeholder 01/01/70 rows counted as 1970: ${selection.delete.filter((s) => s.__shipDate.startsWith('19')).length})`);
  console.log('rows to DELETE per table', JSON.stringify(Object.fromEntries(DELETE_ORDER.map((m) => [m, plan.deletes[m].length]))));
  console.log('rows to MODIFY per table', JSON.stringify(Object.fromEntries(MODIFY_MODELS.map((m) => [m, plan.modifies[m].length]))), 'mixed by reason', JSON.stringify(histogram([...plan.modifies.ArPayment, ...plan.modifies.ApPayment], (x) => x.reason)));
  console.log(`invoices removed ${removed.invoices.count}: total ${dollars(removed.invoices.totalCents)}, paid ${dollars(removed.invoices.paidCents)}, open ${dollars(removed.invoices.openCents)}`);
  console.log(`bills removed ${removed.bills.count} ${JSON.stringify(removed.bills.byStatus)}: billed ${dollars(removed.bills.billedCents)}, paid ${dollars(removed.bills.paidCents)}, open ${dollars(removed.bills.openCents)} (${removed.bills.openCount} open)`);
  console.log(`AR payments: delete ${removed.arPayments.deleted} (${dollars(removed.arPayments.deletedCents)}), modify ${removed.arPayments.modified} (old application dollars removed ${dollars(removed.arPayments.modifiedRemovedCents)})`);
  console.log(`AP payments: delete ${removed.apPayments.deleted} (${dollars(removed.apPayments.deletedCents)}), modify ${removed.apPayments.modified} (old application dollars removed ${dollars(removed.apPayments.modifiedRemovedCents)})`);
  console.log('payment notes', JSON.stringify(plan.notes));
  console.log('CONSERVATION BEFORE', JSON.stringify(proof.before));
  console.log('CONSERVATION AFTER ', JSON.stringify(proof.after));
  console.log(`  retained open AR ${dollars(proof.before.openArCents)} -> ${dollars(proof.after.openArCents)}; retained paid AR ${dollars(proof.before.paidArCents)} -> ${dollars(proof.after.paidArCents)}; whole-table open AP ${dollars(drop.openApBeforeCents)} -> ${dollars(drop.openApAfterCents)} (drops ${dollars(drop.dropCents)})`);
  console.log('  checks', JSON.stringify(proof.checks), proof.ok ? 'PROOF OK' : 'PROOF FAILED');
  console.log('references left untouched: FactoringItem (blocker if referenced), TmsSettings PRO counter, AuditLog (kept; +1 AW_PREDELETE per shipment), S3 documents, DashboardRollup');
  for (const b of plan.blockers.slice(0, 20)) console.log(`BLOCKER ${b}`);
  if (plan.blockers.length) console.log(`BLOCKERS ${plan.blockers.length}`);
  for (const d of devs) console.log(`DEVIATION from Ryne's expectation: ${d}`);
  if (!devs.length) console.log('no deviations from Ryne\'s expectations');

  if (values['cross-check']) {
    const theirs = new Set(JSON.parse(readFileSync(values['cross-check'], 'utf8')).map(String));
    const mine = new Set(selection.delete.map((s) => String(s.number).trim()));
    console.log(`cross-check vs ${values['cross-check']}: mine ${mine.size}, theirs ${theirs.size}, only mine ${[...mine].filter((p) => !theirs.has(p)).length}, only theirs ${[...theirs].filter((p) => !mine.has(p)).length}`);
  }

  const reportDir = values['report-dir'] ?? join(homedir(), 'aljex-export', 'reports');
  mkdirSync(reportDir, { recursive: true });
  const stamp = localDate(new Date());
  write0600(join(reportDir, `predelete-review-${stamp}.csv`), reviewCsv(selection));
  write0600(join(reportDir, `predelete-mixed-payments-${stamp}.jsonl`), `${mixedPaymentLines(plan).join('\n')}${mixedPaymentLines(plan).length ? '\n' : ''}`);
  console.log(`reports (0600) in ${reportDir}: predelete-review-${stamp}.csv (${selection.noShipDate.length + selection.ambiguous.length + selection.notInExport.length} kept-for-review PROs), predelete-mixed-payments-${stamp}.jsonl (${plan.modifies.ArPayment.length + plan.modifies.ApPayment.length} payments)`);

  if (!apply) {
    console.log('DRY RUN: nothing written.');
    return;
  }
  if (plan.blockers.length) throw new Error(`refusing to apply: ${plan.blockers.length} blocker(s)`);
  if (!proof.ok) throw new Error('refusing to apply: the conservation proof failed');
  if (devs.length && !values['accept-deviations']) throw new Error(`refusing to apply: ${devs.length} deviation(s) from the approved scope (re-run with --accept-deviations once Ryne confirms the new numbers)`);
  const dir = values['export-dir'] ?? defaultExportDir();
  const { manifest, rows, reused } = writeAndVerifyExport({ dir, plan, suffix, shipBefore });
  console.log(`export ${reused ? 'reused' : 'written'} and verified in ${dir}: ${Object.keys(manifest.files).length} files, ${Object.values(manifest.files).reduce((a, f) => a + f.count, 0)} rows`);
  const verifiedFiles = new Set(Object.keys(rows));
  const cp = join(dir, 'apply.checkpoint.json');
  const done = existsSync(cp) ? JSON.parse(readFileSync(cp, 'utf8')) : {};
  const out = await applyPlan({
    doc, suffix, plan, verifiedFiles, log: console.log,
    checkpoint: (step, counts) => { done[step] = counts; writeFileSync(cp, JSON.stringify({ ...done, savedAt: new Date().toISOString() }), { mode: 0o600 }); },
  });
  console.log('APPLIED', JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
