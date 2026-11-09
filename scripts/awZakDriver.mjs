#!/usr/bin/env node
/**
 * ZAK = the DRIVER (Ryne). Every shipment whose Aljex equipment code is ZAK gets the driver Zak Pace on its own-asset leg.
 * Dry by default, prod-gated apply, ENRICH ONLY (see the header of scripts/lib/zakDriverPlan.mjs for the rules).
 *
 *   dry run (read-only, prints counts, writes the review CSV mode 0600 into --report-dir):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awZakDriver.mjs --target prod --i-mean-production \
 *       --export ~/aljex-export/aljex-full-export-2026-11-07.csv \
 *       --files ~/aljex-export/shipments-with-equipment-2026-11-08.csv --dir ~/aljex-export/shipments-eq
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awZakDriver --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-zakdriver node scripts/awZakDriver.mjs <same args> \
 *       --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Writes ONLY LoadCarrier.driverId / driverName / driverPhone on the ACTIVE OWN_ASSET leg, each while still empty (conditional update,
 * never an overwrite), plus one AuditLog row per changed leg with the previous (blank) values. Never a Load, Order, Shipment, stop, money
 * or status field: pay reads Load.deliveryDriverId (Zak is BOX_TRUCK-paid), never a LoadCarrier, and LoadCarrier has no stream consumer, so no
 * pay line, settlement, notification or driver-app row appears. The Load mirrors / stops are deliberately NOT written (they WOULD move
 * box-truck unpulled loads, fleet P&L and the dashboard rollup for past weeks). Equipment stays blank.
 * Re-runnable and idempotent; checkpointed to ~/bcat-ops-backups/aw-zak-driver-<suffix>.checkpoint.json.
 * PII: names only go into the 0600 CSV (and only the driver id, never a name), stdout carries aggregated counts.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { readFullExport, readSourceFile, scanAll, sourcePaths, writeCsv } from './awEquipRep.mjs';
import { SCOPE_FROM, histogram, indexExport, indexSources } from './lib/equipRepPlan.mjs';
import { STATUS, ZAK_DRIVER_ID, planZak, zakPros } from './lib/zakDriverPlan.mjs';

export const SCRIPT = 'awZakDriver';
export const AUDIT_ACTION = 'AW_ZAK_DRIVER_BACKFILL';
export const AUDIT_USER = 'system:awZakDriver';
/** The only fields this script may write, per table. */
export const FIELDS = Object.freeze({ LoadCarrier: ['driverId', 'driverName', 'driverPhone'] });

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function zakDriverGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awZakDriver.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-zakdriver`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) {
      throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
    }
  }
  return gate;
}

/** A leg's blank test as a DynamoDB condition: absent, NULL or ''. */
const BLANK = 'attribute_exists(id) AND (attribute_not_exists(#f) OR attribute_type(#f, :nul) OR #f = :blank)';

/** One leg: conditional enrich of each empty field + one AuditLog row. Returns {written, lost} field counts. */
export async function applyOne({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'Zak driver enrich');
  const nowIso = now.toISOString();
  const done = [];
  let lost = 0;
  for (const w of entry.writes) {
    if (!FIELDS[w.table]?.includes(w.field)) throw new Error(`refusing to write ${w.table}.${w.field}`);
    try {
      await doc.send(new UpdateCommand({
        TableName: `${w.table}-${suffix}`,
        Key: { id: w.id },
        UpdateExpression: 'SET #f = :v',
        // The name/phone only ever go next to Zak's own id: a leg someone else assigned meanwhile is left alone.
        ConditionExpression: w.field === 'driverId' ? BLANK : `${BLANK} AND #d = :zak`,
        ExpressionAttributeNames: w.field === 'driverId' ? { '#f': w.field } : { '#f': w.field, '#d': 'driverId' },
        ExpressionAttributeValues: { ':v': w.value, ':nul': 'NULL', ':blank': '', ...(w.field === 'driverId' ? {} : { ':zak': ZAK_DRIVER_ID }) },
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
        entityType: 'LOAD_CARRIER',
        entityId: entry.legId,
        action: AUDIT_ACTION,
        user: AUDIT_USER,
        changes: JSON.stringify({
          pro: entry.pro,
          shipDate: entry.shipDate,
          loadId: entry.loadId,
          shipmentId: entry.shipmentId,
          source: { equipmentCode: 'ZAK' },
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

const checkpointPath = (suffix) => join(homedir(), 'bcat-ops-backups', `aw-zak-driver-${suffix}.checkpoint.json`);
const loadCheckpoint = (path) => (existsSync(path) ? new Set(JSON.parse(readFileSync(path, 'utf8')).done ?? []) : new Set());
const saveCheckpoint = (path, done) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }), { mode: 0o600 });
};

/** The roster check the app's assign flow makes (exists, not a broker, active) and the only-Zak check. Throws otherwise. */
export function resolveZak(drivers, id = ZAK_DRIVER_ID) {
  const zaks = drivers.filter((d) => /\bzak\b/i.test(String(d.name ?? '')));
  const d = drivers.find((x) => x.id === id);
  if (!d) throw new Error(`Driver ${id} does not exist in this stack`);
  if (zaks.length !== 1 || zaks[0].id !== id) throw new Error(`expected Driver ${id} to be the only Zak among ${drivers.length} drivers, found ${zaks.length} Zak row(s)`);
  if (String(d.type ?? '').toLowerCase() === 'broker' || d.active === false) throw new Error(`Driver ${id} is not a usable roster driver (broker or inactive)`);
  return d;
}

export const CATEGORY = Object.freeze({
  TO_SET: 'WRITE', ALREADY_ZAK: 'NOOP', DIFFERENT_DRIVER: 'REVIEW', NO_LEG: 'REVIEW', NOT_FOUND: 'REVIEW',
  OLDER: 'SKIP_DELETING', NO_SHIP_DATE: 'REVIEW', VOIDED: 'SKIP', OTHER: 'REVIEW',
});

async function main() {
  const { values } = parseArgs({
    options: {
      export: { type: 'string' }, files: { type: 'string' }, dir: { type: 'string' }, 'report-dir': { type: 'string' },
      apply: { type: 'boolean' }, limit: { type: 'string' }, suffix: { type: 'string' },
      help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS,
    },
    allowPositionals: false,
  });
  const paths = sourcePaths({ files: values.files, dir: values.dir });
  if (values.help || !values.export || paths.length === 0) {
    console.log(`Usage: node scripts/awZakDriver.mjs --export <aljex-full-export.csv> (--files a.csv,b.csv | --dir <dir>) [--report-dir <dir>] [--limit N] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply. Sets driver ${ZAK_DRIVER_ID} on the own-asset leg of every ZAK PRO whose leg has no driver.`);
    return;
  }
  const gate = await zakDriverGate(values);
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

  const [exportRows, ...sourceFiles] = await Promise.all([readFullExport(values.export), ...paths.map(readSourceFile)]);
  const { byPro: sources } = indexSources(sourceFiles.flat());
  const exportByPro = indexExport(exportRows);
  const { zak, conflicted } = zakPros(sources);
  const [drivers, shipments, loads, legs, claims] = await Promise.all([
    scanAll(doc, T('Driver'), ['id', 'name', 'phone', 'type', 'active']),
    scanAll(doc, T('Shipment'), ['id', 'number', 'voidedAt']),
    scanAll(doc, T('Load'), ['id', 'shipmentId', 'aljexId', 'status', 'voidedAt', 'pickupDriverId', 'deliveryDriverId', 'stops', 'legacyImported', 'rateConfirmKey']),
    scanAll(doc, T('LoadCarrier'), ['id', 'loadId', 'kind', 'status', 'driverId', 'driverName', 'driverPhone']),
    scanAll(doc, T('ProClaim'), ['id', 'shipmentId']),
  ]);
  const driver = resolveZak(drivers);
  const results = planZak({ shipments, loads, legs, claims, zakProSet: zak, exportByPro, driver });

  const by = histogram(results, (r) => r.status);
  console.log(`ZAK PROs ${zak.size} (equipment-export code exactly ZAK; ${conflicted.size} more PROs have ZAK plus a second code: not touched). Driver ${driver.id} verified: exists, the only Zak among ${drivers.length}, active.`);
  console.log(`BY STATUS ${JSON.stringify(by)}`);
  const toSet = results.filter((r) => r.status === STATUS.TO_SET);
  console.log(`TO SET ${toSet.length} legs; field writes ${JSON.stringify(histogram(toSet.flatMap((r) => r.writes), (w) => `${w.table}.${w.field}`))}`);
  for (const k of ['leg', 'legName', 'delivery', 'pickup', 'stops', 'legacyImported', 'loadStatus', 'rateConfirmKey']) {
    console.log(`TO SET facts ${k} ${JSON.stringify(histogram(toSet, (r) => r.facts[k]))}`);
  }
  console.log(`OTHER by reason ${JSON.stringify(histogram(results.filter((r) => r.status === STATUS.OTHER), (r) => r.reason.replace(/\d+/g, 'N')))}`);
  console.log(`OLDER than ${SCOPE_FROM} (skipped, being deleted) ${results.filter((r) => r.status === STATUS.OLDER).length}`);

  const reportPath = join(reportDir, `zak-driver-review-${today}.csv`);
  writeCsv(reportPath, ['PRO', 'status', 'category', 'current driver id', 'reason'], results.map((r) => [r.pro, r.status, CATEGORY[r.status], r.currentDriverId, r.reason]));
  chmodSync(reportPath, 0o600);
  console.log(`review CSV (mode 0600, no names): ${reportPath}`);

  if (!apply) {
    console.log(`DRY RUN: nothing written. ${toSet.length} leg(s) would be enriched.`);
    return;
  }
  const limit = values.limit ? Number(values.limit) : Infinity;
  const cpPath = checkpointPath(suffix);
  const done = loadCheckpoint(cpPath);
  const out = { legs: 0, fieldsWritten: 0, fieldsAlreadyFilled: 0, skippedDone: 0 };
  let n = 0;
  for (const entry of toSet) {
    if (n >= limit) break;
    if (done.has(entry.legId)) { out.skippedDone += 1; continue; }
    n += 1;
    const r = await applyOne({ doc, suffix, entry });
    out.legs += r.written ? 1 : 0;
    out.fieldsWritten += r.written;
    out.fieldsAlreadyFilled += r.lost;
    done.add(entry.legId);
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
