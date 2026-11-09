#!/usr/bin/env node
/**
 * Truck fleet groups (Ryne 2026-11-09, queue item 50). One gated script, token `truckfleet`. Dry by default.
 * See scripts/lib/truckFleetPlan.mjs for the rules.
 *
 *   dry run (read-only; prints the plan, writes nothing):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awTruckFleet.mjs report --target prod --i-mean-production
 *   backup (once, < 6 h before an apply; covers Equipment + AuditLog):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awTruckFleet --target prod --i-mean-production --apply
 *   apply (one step at a time):
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-truckfleet node scripts/awTruckFleet.mjs box-truck --apply \
 *       --target prod --i-mean-production --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *     (same flags) node scripts/awTruckFleet.mjs owner-operator --apply ...   REFUSES until EquipmentFleetGroup has OWNER_OPERATOR in the live schema
 *   rollback (restores the exported previous fleetGroup, only where the row still holds what this script wrote):
 *     (same flags) node scripts/awTruckFleet.mjs rollback --from ~/bcat-ops-backups/pre-truck-fleet/<stamp> --apply
 *
 * box-truck / owner-operator   Equipment.fleetGroup ONLY, one truck per driver. One conditional UpdateItem per truck (the stored value must still be
 *                              the one the plan read), one AuditLog row per truck with the previous value. Before the first write the target rows are
 *                              exported (JSONL + manifest with sha256, dir 0700 / files 0600) and every written row is checkpointed. Idempotent:
 *                              a row already at the target is skipped. Never a driver, pay setting, trailer or any other field.
 * PII: first names + unit numbers only on stdout.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AppSyncClient, GetIntrospectionSchemaCommand } from '@aws-sdk/client-appsync';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { AUDIT_USER, ENUM_NAME, STEPS, STEP_NAMES, applyRefusal, enumHasValue, planRollback, planStep } from './lib/truckFleetPlan.mjs';

export const SCRIPT = 'awTruckFleet';
export const SUBCOMMANDS = ['report', ...STEP_NAMES, 'rollback'];
export const SUB_MODELS = Object.fromEntries(SUBCOMMANDS.map((s) => [s, ['Equipment', 'AuditLog']]));
export const AUDIT_ACTIONS = { apply: 'AW_TRUCK_FLEET', rollback: 'AW_TRUCK_FLEET_ROLLBACK' };
export const EXPORT_DIR_NAME = 'pre-truck-fleet';
export const defaultExportDir = () => join(homedir(), 'bcat-ops-backups', EXPORT_DIR_NAME);

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function truckFleetGate(sub, values, deps = {}) {
  if (!SUBCOMMANDS.includes(sub)) throw new Error(`unknown subcommand "${sub}" (${SUBCOMMANDS.join(' | ')})`);
  const apply = values.apply === true;
  const gate = await requireProd({ script: SCRIPT, values, tables: SUB_MODELS[sub], readOnly: !apply, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-truckfleet`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) {
      throw new Error(`Production gate closed for ${SCRIPT} ${sub}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
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
      ...(projection ? {
        ProjectionExpression: projection.map((_, i) => `#p${i}`).join(','),
        ExpressionAttributeNames: Object.fromEntries(projection.map((p, i) => [`#p${i}`, p])),
      } : {}),
      ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

/** Does the LIVE AppSync schema accept `value` for Equipment.fleetGroup? (API id = the table suffix without -NONE.) Read-only. */
export async function liveSchemaHasEnumValue(suffix, value, client = new AppSyncClient({ region: REGION })) {
  const r = await client.send(new GetIntrospectionSchemaCommand({ apiId: suffix.replace(/-NONE$/, ''), format: 'SDL' }));
  return enumHasValue(Buffer.from(r.schema).toString('utf8'), ENUM_NAME, value);
}

/** One truck: conditional fleetGroup write + one AuditLog row. Returns 'written' | 'lost'. */
export async function applyTruck({ doc, suffix, entry, action = AUDIT_ACTIONS.apply, from = entry.from, to = entry.to, now = new Date() }) {
  assertWritableSuffix(suffix, 'truck fleet group');
  const nowIso = now.toISOString();
  try {
    await doc.send(new UpdateCommand({
      TableName: `Equipment-${suffix}`,
      Key: { id: entry.equipmentId },
      UpdateExpression: 'SET #f = :to, updatedAt = :now',
      ConditionExpression: 'attribute_exists(id) AND #f = :from',
      ExpressionAttributeNames: { '#f': 'fleetGroup' },
      ExpressionAttributeValues: { ':to': to, ':from': from, ':now': nowIso },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return 'lost';
    throw err;
  }
  await doc.send(new PutCommand({
    TableName: `AuditLog-${suffix}`,
    Item: {
      id: randomUUID(), __typename: 'AuditLog', entityType: 'EQUIPMENT', entityId: entry.equipmentId, action, user: AUDIT_USER,
      changes: JSON.stringify({ field: 'fleetGroup', previous: from, next: to, unit: entry.unit, source: 'Ryne 2026-11-09 (queue 50)', key: entry.key }),
      createdAt: nowIso, updatedAt: nowIso,
    },
  }));
  return 'written';
}

/** Export the before-values of the rows about to change. Returns the directory. Throws before any write when it cannot be written. */
export function exportBefore({ step, toWrite, rowsById }, { dir = defaultExportDir(), now = new Date() } = {}) {
  const stampDir = join(dir, now.toISOString().replace(/[:.]/g, '-'));
  mkdirSync(stampDir, { recursive: true, mode: 0o700 });
  chmodSync(stampDir, 0o700);
  const body = toWrite.map((e) => `${JSON.stringify(rowsById.get(e.equipmentId))}\n`).join('');
  const file = join(stampDir, 'Equipment.jsonl');
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
  const manifest = {
    createdAt: now.toISOString(), step,
    tables: { Equipment: { rows: toWrite.length, sha256: createHash('sha256').update(body).digest('hex') } },
    entries: toWrite.map((e) => ({ key: e.key, equipmentId: e.equipmentId, unit: e.unit, firstName: e.firstName, from: e.from, to: e.to })),
  };
  const mf = join(stampDir, 'manifest.json');
  writeFileSync(mf, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  chmodSync(mf, 0o600);
  const cp = join(stampDir, 'checkpoint.jsonl');
  writeFileSync(cp, '', { mode: 0o600 });
  return stampDir;
}

/** Read an export back, verifying its sha256 against the manifest. */
export function readExport(stampDir) {
  const body = readFileSync(join(stampDir, 'Equipment.jsonl'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(stampDir, 'manifest.json'), 'utf8'));
  if (createHash('sha256').update(body).digest('hex') !== manifest.tables.Equipment.sha256) throw new Error('export sha256 does not match its manifest');
  return { manifest, rows: body.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const checkpoint = (stampDir, line) => appendFileSync(join(stampDir, 'checkpoint.jsonl'), `${JSON.stringify(line)}\n`);

/** Export, then write each WRITE row (checkpointed). Returns { exportDir, written, lost }. */
export async function applyStep({ doc, suffix, step, plan, rowsById, exportDir, now = new Date() }) {
  const dir = exportBefore({ step, toWrite: plan.toWrite, rowsById }, { dir: exportDir, now });
  const out = { exportDir: dir, written: 0, lost: 0 };
  for (const e of plan.toWrite) {
    const r = await applyTruck({ doc, suffix, entry: e, now });
    out[r === 'written' ? 'written' : 'lost'] += 1;
    checkpoint(dir, { equipmentId: e.equipmentId, unit: e.unit, result: r, at: new Date().toISOString() });
  }
  return out;
}

/** Restore the exported previous values where the row still holds what this script wrote. */
export async function rollbackFrom({ doc, suffix, from, now = new Date() }) {
  assertWritableSuffix(suffix, 'truck fleet rollback');
  const { manifest } = readExport(from);
  const current = new Map((await scanAll(doc, `Equipment-${suffix}`, ['id', 'fleetGroup'])).map((r) => [r.id, r]));
  const plan = planRollback(manifest, current);
  const out = { restored: 0, skipped: 0, lost: 0, statuses: plan.map((p) => `${p.firstName} ${p.unit}: ${p.status}`) };
  for (const p of plan) {
    if (p.status !== 'RESTORE') { out.skipped += 1; continue; }
    const r = await applyTruck({ doc, suffix, entry: p, action: AUDIT_ACTIONS.rollback, from: p.to, to: p.from, now });
    out[r === 'written' ? 'restored' : 'lost'] += 1;
  }
  return out;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { 'export-dir': { type: 'string' }, from: { type: 'string' }, apply: { type: 'boolean' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS },
    allowPositionals: true,
  });
  const sub = positionals[0] ?? 'report';
  if (values.help || !SUBCOMMANDS.includes(sub)) {
    console.log(`Usage: node scripts/awTruckFleet.mjs <${SUBCOMMANDS.join('|')}> [--export-dir <dir>] [--from <export dir>] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`);
    return;
  }
  if (sub === 'rollback' && !values.from) throw new Error('rollback needs --from <export dir>');
  const gate = await truckFleetGate(sub, values);
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const apply = values.apply === true && (gate === null ? true : gate.apply);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });

  if (sub === 'rollback') {
    if (!apply) { const { manifest } = readExport(values.from); console.log(`DRY RUN: nothing written. rollback would restore ${manifest.entries.length} truck(s): ${manifest.entries.map((e) => `${e.firstName} ${e.unit} ${e.to}->${e.from}`).join('; ')}`); return; }
    console.log('ROLLED BACK', JSON.stringify(await rollbackFrom({ doc, suffix, from: values.from })));
    return;
  }

  const [drivers, equipment] = await Promise.all([
    scanAll(doc, `Driver-${suffix}`, ['id', 'name', 'type', 'active', 'fleetGroup', 'assignedTruckId', 'assignedTrailerId']),
    scanAll(doc, `Equipment-${suffix}`),
  ]);
  const rowsById = new Map(equipment.map((e) => [e.id, e]));
  const steps = sub === 'report' ? STEP_NAMES : [sub];
  const enumHasTarget = {};
  for (const s of steps) enumHasTarget[s] = STEPS[s].needsEnumValue ? await liveSchemaHasEnumValue(suffix, STEPS[s].to).catch(() => false) : true;

  for (const s of steps) {
    const plan = planStep(s, { drivers, equipment });
    const problems = plan.entries.filter((e) => e.status === 'PROBLEM');
    console.log(`STEP ${s}: ${plan.toWrite.length} to write, ${plan.entries.filter((e) => e.status === 'DONE').length} already done, ${problems.length} problem(s); ${ENUM_NAME} has ${STEPS[s].to} in the live schema: ${enumHasTarget[s]}`);
    for (const e of plan.entries) {
      console.log(`  ${e.firstName ?? e.key} unit ${e.unit}: ${e.current ?? '?'} -> ${e.to} [${e.status}${e.problem ? ` ${e.problem}` : ''}] trailers (report only, never written): ${e.trailers.length ? e.trailers.map((t) => `${t.unit}:${t.fleetGroup ?? 'none'}`).join(', ') : 'none'}`);
    }
    if (sub === 'report') continue;
    if (!apply) { console.log(`DRY RUN: nothing written. ${plan.toWrite.length} truck(s) would change Equipment.fleetGroup.`); continue; }
    const refusal = applyRefusal(s, { problems, enumHasTarget: enumHasTarget[s] });
    if (refusal) throw new Error(refusal);
    if (!plan.toWrite.length) { console.log('APPLIED {"written":0,"note":"nothing to do (idempotent)"}'); continue; }
    console.log('APPLIED', JSON.stringify(await applyStep({ doc, suffix, step: s, plan, rowsById, exportDir: values['export-dir'] })));
  }
  if (sub === 'report') console.log('DRY RUN: nothing written.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
