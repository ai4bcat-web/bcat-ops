#!/usr/bin/env node
/**
 * Restore shipments hard-deleted by DELETE_SHIPMENTS from their export (dry by default, prod-gated apply).
 *
 * The delete action (amplify/functions/tms-shipment-actions/shipmentDelete.ts) writes every row it removes to the
 * DataSafety bucket under `deletes/<stamp>/`: one `<Model>.jsonl` per table plus `manifest.json` (counts + sha256).
 * This script puts those rows back from that prefix (or from a local copy of it), the same way the RESTORE action does.
 *
 *   dry run (read-only; verifies every checksum, reports what would be put):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awRestoreDeleted.mjs --target prod --i-mean-production --prefix deletes/<stamp>/
 *     node scripts/awRestoreDeleted.mjs --dir ~/Downloads/deletes-<stamp>      (dev stack; no gate flags)
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awRestoreDeleted --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awRestoreDeleted.mjs --target prod --i-mean-production --apply \
 *       --prefix deletes/<stamp>/ --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Guarantees: manifest and EVERY table file are read and verified (sha256, row count, file name, allowlisted model, row id)
 * before the first write, so a corrupt export restores nothing. Rows are PUT only while the id is absent (conditional put;
 * never an overwrite, never an update). Only the models the delete removes are restored (ledger copies flagged
 * `deleted: false` are skipped). One AuditLog row per shipment that got at least one row back. Nothing is deleted anywhere
 * (S3 is only read). Re-runnable: rows already present are counted and left alone.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, requireProd, tableName } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { pickDataSafetyBucket } from './lib/awProdOffline.mjs';

export const SCRIPT = 'awRestoreDeleted';
export const AUDIT_ACTION = 'RESTORE_DELETED_SHIPMENT';
export const AUDIT_USER = 'system:awRestoreDeleted';
const LAMBDA_PREFIX = 'amplify-d3dejqzs77khq6-ma';

/**
 * Every model a restore may write: the models shipmentDelete.ts DELETE_ORDER removes (a unit test keeps them covered) plus
 * the forced-delete extras ArPayment / ApPayment (payment rows attached ONLY to the deleted invoices/bills) and LegacyAljexRow.
 * Listed in delete order; ProClaim is never deleted so never restored.
 */
export const RESTORABLE_MODELS = [
  'ArPayment', 'ApPayment', 'LegacyAljexRow', 'Commission', 'FactoringItem', 'Invoice', 'CarrierBill',
  'LaneRateSample', 'LoadFinancials', 'LoadCharge', 'LoadCheckCall', 'TrackingLink', 'ShipmentDocument',
  'ShipmentNotice', 'ShipmentPosting', 'ShipmentMessage', 'LoadCarrier', 'Load', 'Order', 'Shipment',
];
const PREFIX_PATTERN = /^deletes\/[A-Za-z0-9._-]+\/$/;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Same decoding as fromJsonLine in shipmentDelete.ts: `{ $set: [...] }` becomes a DynamoDB set. */
export function fromJsonLine(line) {
  return JSON.parse(line, (_k, v) => (v != null && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.$set) && Object.keys(v).length === 1 ? new Set(v.$set) : v));
}

export async function restoreGate(values, deps = {}) {
  return requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awRestoreDeleted.models, deps });
}

/**
 * Read + verify the whole export. Throws on the first problem; returns what to restore in write order
 * (Shipment first, then the reverse of the delete order, as the RESTORE action does).
 * @param {(name: string) => Promise<string>} read reads `manifest.json` / `<Model>.jsonl` from the prefix or directory
 */
export async function loadExport(read) {
  const manifest = JSON.parse(await read('manifest.json'));
  if (manifest?.kind !== 'SHIPMENT_DELETE' || manifest.version !== 1) throw new Error('Not a shipment-delete export manifest');
  if (!manifest.tables || typeof manifest.tables !== 'object' || !Array.isArray(manifest.shipments)) throw new Error('Malformed manifest');
  const loaded = [];
  for (const [model, meta] of Object.entries(manifest.tables)) {
    if (!meta.deleted) continue;
    if (!RESTORABLE_MODELS.includes(model)) throw new Error(`Model not allowed in a restore: ${model}`);
    if (meta.file !== `${model}.jsonl`) throw new Error(`Unexpected file name for ${model}: ${meta.file}`);
    const body = await read(meta.file);
    if (sha256(body) !== meta.sha256) throw new Error(`${meta.file} does not match its manifest hash; refusing to restore`);
    const rows = body.split('\n').filter((l) => l.trim() !== '').map(fromJsonLine);
    if (rows.length !== meta.count) throw new Error(`${meta.file} has ${rows.length} rows, the manifest says ${meta.count}`);
    for (const r of rows) {
      if (typeof r?.id !== 'string' || r.id === '') throw new Error(`${meta.file} has a row without an id`);
    }
    loaded.push({ model, rows });
  }
  const rank = (m) => (m === 'Shipment' ? -Infinity : -RESTORABLE_MODELS.indexOf(m));
  loaded.sort((a, b) => rank(a.model) - rank(b.model));
  return { manifest, loaded };
}

const isConditionalFail = (err) => err?.name === 'ConditionalCheckFailedException';

/**
 * Restore (or, when `apply` is false, preview) a loaded export. Put-if-absent only.
 * Returns per-table counts and the shipments that got an AuditLog row.
 */
export async function restoreRows({ doc, suffix, manifest, loaded, apply, prefix = null, now = new Date() }) {
  if (apply) assertWritableSuffix(suffix, 'restore deleted shipments');
  const tables = {};
  const restoredByModel = new Map();
  for (const { model, rows } of loaded) {
    const t = { rows: rows.length, restored: 0, alreadyPresent: 0, failed: 0 };
    tables[model] = t;
    restoredByModel.set(model, []);
    for (const row of rows) {
      try {
        if (!apply) {
          const got = await doc.send(new GetCommand({ TableName: tableName(model, suffix), Key: { id: row.id } }));
          if (got.Item) t.alreadyPresent += 1;
          else t.restored += 1;
          continue;
        }
        await doc.send(new PutCommand({
          TableName: tableName(model, suffix),
          Item: row,
          ConditionExpression: 'attribute_not_exists(id)',
        }));
        t.restored += 1;
        restoredByModel.get(model).push(row);
      } catch (err) {
        if (isConditionalFail(err)) t.alreadyPresent += 1;
        else t.failed += 1;
      }
    }
  }
  const audited = [];
  if (apply) {
    const nowIso = now.toISOString();
    for (const s of manifest.shipments) {
      const counts = {};
      for (const [model, rows] of restoredByModel) {
        const n = rows.filter((r) => (model === 'Shipment' ? r.id === s.id : r.shipmentId === s.id)).length;
        if (n) counts[model] = n;
      }
      if (Object.keys(counts).length === 0) continue;
      await doc.send(new PutCommand({
        TableName: tableName('AuditLog', suffix),
        Item: {
          id: randomUUID(),
          __typename: 'AuditLog',
          entityType: 'SHIPMENT',
          entityId: s.id,
          action: AUDIT_ACTION,
          user: AUDIT_USER,
          changes: JSON.stringify({ number: s.number ?? null, exportPrefix: prefix, restored: counts }),
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      }));
      audited.push(s.id);
    }
  }
  return { tables, audited };
}

export const dirReader = (dir) => async (name) => readFileSync(join(dir, name), 'utf8');
export const s3Reader = (s3, bucket, prefix) => async (name) => {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${name}` }));
  return r.Body.transformToString('utf8');
};

export function normalizePrefix(raw) {
  const prefix = raw.endsWith('/') ? raw : `${raw}/`;
  if (!PREFIX_PATTERN.test(prefix)) throw new Error('--prefix must look like deletes/<stamp>/');
  return prefix;
}

async function main() {
  const { values } = parseArgs({
    options: { prefix: { type: 'string' }, dir: { type: 'string' }, bucket: { type: 'string' }, apply: { type: 'boolean' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Usage: node scripts/awRestoreDeleted.mjs (--prefix deletes/<stamp>/ [--bucket <name>] | --dir <local copy of the export>) [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply. Put-if-absent only; nothing is deleted or overwritten.`);
    return;
  }
  if (Boolean(values.prefix) === Boolean(values.dir)) throw new Error('Pass exactly one of --prefix (S3) or --dir (local export directory)');
  const gate = await restoreGate(values);
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;

  let read;
  let prefix = null;
  if (values.dir) read = dirReader(resolve(values.dir.replace(/^~(?=\/)/, homedir())));
  else {
    prefix = normalizePrefix(values.prefix);
    const s3 = new S3Client({ region: REGION });
    let bucket = values.bucket;
    if (!bucket) {
      if (!gate || gate.rehearsal) throw new Error('--bucket is required outside a real production run');
      const names = ((await s3.send(new ListBucketsCommand({}))).Buckets ?? []).map((b) => b.Name);
      bucket = pickDataSafetyBucket(names, LAMBDA_PREFIX);
    }
    read = s3Reader(s3, bucket, prefix);
    console.log(`export s3://${bucket}/${prefix}`);
  }

  const { manifest, loaded } = await loadExport(read);
  console.log(`export verified: ${manifest.shipments.length} shipment(s), ${loaded.length} table file(s), created ${manifest.createdAt} by ${manifest.actor}`);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const { tables, audited } = await restoreRows({ doc, suffix, manifest, loaded, apply, prefix });
  const verb = apply ? 'restored' : 'would restore';
  for (const [model, t] of Object.entries(tables)) console.log(`  ${model}: ${t.rows} rows, ${verb} ${t.restored}, already present ${t.alreadyPresent}, failed ${t.failed}`);
  const failed = Object.values(tables).reduce((n, t) => n + t.failed, 0);
  if (!apply) console.log('DRY RUN: nothing written. Re-run with --apply to restore.');
  else console.log(`APPLIED: audit rows ${audited.length}, failed rows ${failed}`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
