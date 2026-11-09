#!/usr/bin/env node
/**
 * Sales rep id enrich for migrated Aljex shipments (dry by default, prod-gated apply). ENRICH ONLY.
 *
 * The importer stored the sales rep as a NAME in Shipment.salesRepCode (RYNE BANDOLIK, ...). The "Sales rep" required
 * field and the rep picker read Shipment.salesRepId / Order.customerRepId (a UserProfile id). This maps each name to
 * the person's UserProfile (name, then e-mail local part; ambiguous = unmapped) and fills those ids where they are empty.
 * Run backfillUserProfiles FIRST: the ids are read from the production UserProfile table at apply time.
 *
 *   dry run (read-only, prints counts, writes review CSVs mode 0600 into --report-dir):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awSalesRepId.mjs --target prod --i-mean-production
 *   PREVIEW before the profiles exist (ids taken from the backfill dry-run plan, labelled PREVIEW; never with --apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awSalesRepId.mjs --target prod --i-mean-production --assume-profiles <plan.json>
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awSalesRepId --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-salesrepid node scripts/awSalesRepId.mjs \
 *       --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Writes ONLY, each only while the target is still empty (conditional update; never overwrites): Shipment.salesRepId and
 * Order.customerRepId (what SET_SALES_REP mirrors), plus one AuditLog row per changed shipment with the previous values.
 * The Shipment write also requires salesRepCode to still be the planned name. Never a money or status field, never a notice /
 * e-mail / message; voided shipments are skipped; names with no login stay as salesRepCode and are listed.
 * Re-runnable and idempotent; progress is checkpointed to ~/bcat-ops-backups/aw-sales-rep-id-<suffix>.checkpoint.json.
 * PII: stdout carries counts, rep names and roles; e-mails and ids only go into the 0600 CSVs (ids), never stdout.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { csvCell } from './lib/releaseClassify.mjs';
import { WRITABLE, countWrites, mapRepNames, planSalesRepIds, profilesFromPlan } from './lib/salesRepPlan.mjs';

export const SCRIPT = 'awSalesRepId';
export const AUDIT_ACTION = 'AW_SALES_REP_ID';
export const AUDIT_USER = 'system:awSalesRepId';

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function salesRepIdGate(values, deps = {}) {
  if (values.apply === true && values['assume-profiles']) {
    throw new Error(`${SCRIPT}: --assume-profiles is a PREVIEW (profile ids from a plan, not the table) and cannot be combined with --apply`);
  }
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awSalesRepId.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-salesrepid`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) {
      throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
    }
  }
  return gate;
}

async function scanAll(doc, table, projection) {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: table,
      ProjectionExpression: projection.map((_, i) => `#p${i}`).join(','),
      ExpressionAttributeNames: Object.fromEntries(projection.map((p, i) => [`#p${i}`, p])),
      ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

const writeCsv = (path, head, lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${[head.join(','), ...lines.map((l) => l.map(csvCell).join(','))].join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

const tally = (items, keyOf) => {
  const out = {};
  for (const i of items) { const k = keyOf(i); out[k] = (out[k] ?? 0) + 1; }
  return out;
};

/** One shipment: conditional enrich of each empty target + one AuditLog row. Returns {written, lost} counts of fields. */
export async function applyOne({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'sales rep id enrich');
  const nowIso = now.toISOString();
  const done = [];
  let lost = 0;
  for (const w of entry.writes) {
    if (!WRITABLE[w.table]?.includes(w.field)) throw new Error(`refusing to write ${w.table}.${w.field}`);
    const isShipment = w.table === 'Shipment';
    try {
      await doc.send(new UpdateCommand({
        TableName: `${w.table}-${suffix}`,
        Key: { id: w.id },
        UpdateExpression: 'SET #f = :v',
        ConditionExpression: `attribute_exists(id) AND (attribute_not_exists(#f) OR attribute_type(#f, :nul) OR #f = :blank)${isShipment ? ' AND attribute_not_exists(voidedAt) AND salesRepCode = :code' : ''}`,
        ExpressionAttributeNames: { '#f': w.field },
        ExpressionAttributeValues: { ':v': w.value, ':nul': 'NULL', ':blank': '', ...(isShipment ? { ':code': entry.shipment.salesRepCode } : {}) },
      }));
      done.push(w);
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') { lost += 1; continue; }
      throw err;
    }
  }
  if (done.length) {
    await doc.send(new PutCommand({
      TableName: `AuditLog-${suffix}`,
      Item: {
        id: randomUUID(),
        __typename: 'AuditLog',
        entityType: 'SHIPMENT',
        entityId: entry.shipment.id,
        action: AUDIT_ACTION,
        user: AUDIT_USER,
        changes: JSON.stringify({
          viaSalesRepCode: entry.code,
          previous: done.map((w) => ({ table: w.table, id: w.id, field: w.field, value: null })),
          next: done.map((w) => ({ table: w.table, id: w.id, field: w.field, value: w.value })),
        }),
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    }));
  }
  return { written: done.length, lost };
}

const checkpointPath = (suffix) => join(homedir(), 'bcat-ops-backups', `aw-sales-rep-id-${suffix}.checkpoint.json`);
const loadCheckpoint = (path) => (existsSync(path) ? new Set(JSON.parse(readFileSync(path, 'utf8')).done ?? []) : new Set());
const saveCheckpoint = (path, done) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }), { mode: 0o600 });
};

async function main() {
  const { values } = parseArgs({
    options: {
      'assume-profiles': { type: 'string' }, 'report-dir': { type: 'string' }, apply: { type: 'boolean' },
      limit: { type: 'string' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS,
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Usage: node scripts/awSalesRepId.mjs [--assume-profiles <backfillUserProfiles plan.json>] [--report-dir <dir>] [--limit N] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply. --assume-profiles is a preview only (refused with --apply).`);
    return;
  }
  const gate = await salesRepIdGate(values);
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const T = (m) => `${m}-${suffix}`;
  const today = localDate(new Date());
  const reportDir = values['report-dir'] ?? join(homedir(), 'aljex-export', 'reports');

  const [shipments, orders, tableProfiles] = await Promise.all([
    scanAll(doc, T('Shipment'), ['id', 'salesRepCode', 'salesRepId', 'voidedAt']),
    scanAll(doc, T('Order'), ['id', 'shipmentId', 'customerRepId']),
    scanAll(doc, T('UserProfile'), ['id', 'email', 'name', 'role', 'status']),
  ]);
  const preview = Boolean(values['assume-profiles']);
  const profiles = preview
    ? profilesFromPlan(JSON.parse(readFileSync(resolve(values['assume-profiles']), 'utf8')), tableProfiles)
    : tableProfiles;

  const names = shipments.map((s) => String(s.salesRepCode ?? '').trim()).filter(Boolean);
  const mapping = mapRepNames(names, profiles);
  const { entries, skipped } = planSalesRepIds({ shipments, orders, mapping });
  const counts = tally(names, (n) => n);

  if (preview) console.log(`*** PREVIEW: profile ids come from the backfill plan (${profiles.filter((p) => p.planned).length} not in the table yet), NOT from ${T('UserProfile')}. Nothing here can be applied. ***`);
  console.log(`shipments ${shipments.length}; orders ${orders.length}; profiles in table ${tableProfiles.length}${preview ? ` (+${profiles.length - tableProfiles.length} planned)` : ''}`);
  console.log(`shipments with a salesRepCode ${names.length}; without ${shipments.length - names.length}`);
  const roleOf = (p) => `${p.role ?? '-'}${p.planned ? ' (planned profile)' : ''}`;
  for (const [name, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const m = mapping.get(name);
    const detail = m.status === 'MAPPED' ? `-> profile ${roleOf(m.profile)}` : m.status === 'AMBIGUOUS' ? `${m.candidates.length} profiles match` : m.status === 'INACTIVE' ? 'only an INACTIVE profile matches' : 'no login';
    console.log(`  ${m.status === 'MAPPED' ? 'MAPPED  ' : 'UNMAPPED'} ${name}: ${n} shipments, ${detail}`);
  }
  const wc = countWrites(entries);
  console.log(`TO APPLY${preview ? ' (PREVIEW)' : ''}: ${entries.length} shipments; Shipment.salesRepId ${wc.Shipment}, Order.customerRepId ${wc.Order}`);
  console.log(`skipped ${JSON.stringify(skipped)}`);

  const f = (name) => join(reportDir, `${name}-${today}${preview ? '-preview' : ''}.csv`);
  writeCsv(f('salesrepid-to-apply'), ['shipment id', 'sales rep name', 'table', 'id', 'field', 'profile id'],
    entries.flatMap((e) => e.writes.map((w) => [e.shipment.id, e.code, w.table, w.id, w.field, w.value])));
  writeCsv(f('salesrepid-unmapped'), ['sales rep name', 'shipments', 'reason', 'candidates'],
    [...mapping.entries()].filter(([, m]) => m.status !== 'MAPPED').map(([name, m]) => [name, counts[name], m.status, m.candidates.map((p) => p.email ?? p.id).join('|')]));
  console.log(`reports written to ${reportDir} (mode 0600): salesrepid-to-apply, salesrepid-unmapped (${today}${preview ? ', preview' : ''})`);

  if (!apply) {
    console.log(`DRY RUN: nothing written. ${entries.length} shipment(s) would be enriched.`);
    return;
  }
  const limit = values.limit ? Number(values.limit) : Infinity;
  const cpPath = checkpointPath(suffix);
  const done = loadCheckpoint(cpPath);
  const out = { shipments: 0, fieldsWritten: 0, fieldsAlreadyFilled: 0, skippedDone: 0 };
  let n = 0;
  for (const entry of entries) {
    if (n >= limit) break;
    if (done.has(entry.shipment.id)) { out.skippedDone += 1; continue; }
    n += 1;
    const r = await applyOne({ doc, suffix, entry });
    out.shipments += r.written ? 1 : 0;
    out.fieldsWritten += r.written;
    out.fieldsAlreadyFilled += r.lost;
    done.add(entry.shipment.id);
    if (n % 25 === 0) saveCheckpoint(cpPath, done);
  }
  saveCheckpoint(cpPath, done);
  console.log('APPLIED', JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
