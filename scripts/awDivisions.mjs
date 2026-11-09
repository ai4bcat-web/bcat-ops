#!/usr/bin/env node
/**
 * Driver types + retiring the "Company" ownership division (Ryne 2026-11-09, queue items 39/40). One gated script, token `divisions`.
 * Dry by default. See scripts/lib/divisionPlan.mjs for the rules.
 *
 *   dry run (read-only: prints counts, writes the 0600 profile-review CSV into --report-dir):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awDivisions.mjs report --target prod --i-mean-production
 *   backup (once, < 6 h before an apply; covers Driver, OwnershipDivision, AuditLog):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awDivisions --target prod --i-mean-production --apply
 *   apply (either subcommand; the typed token is the same):
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-divisions node scripts/awDivisions.mjs drivers --apply \
 *       --target prod --i-mean-production --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-divisions node scripts/awDivisions.mjs retire-company --apply <same gate flags>
 *   restore the division row from its export:  ... awDivisions.mjs restore --from ~/bcat-ops-backups/pre-delete-company-division/<stamp> --apply <same gate flags>
 *
 * drivers         Driver.driverType ONLY, one conditional UpdateItem per driver (the stored value must still be the one the plan read), one
 *                 AuditLog row per driver with the previous value. Never fleetGroup / pay group / equipment (those are reported).
 * retire-company  Exports the COMPANY OwnershipDivision row (JSONL + manifest with sha256, dir 0700 / files 0600; no PII) then deletes it with a
 *                 conditional delete. Refuses while ANY row still references the code (live re-check of every table that can name a division).
 * restore         Put-if-absent of the exported division row (+ audit row).
 * PII: first names + id prefixes only on stdout; the CSV has no last names. No pay, tax or bank values are read.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';

register('./lib/tsExtensionlessHooks.mjs', import.meta.url);
const plan = await import('./lib/divisionPlan.mjs');
const { COMPANY_CODE, COMPANY_REF_SPECS, AUDIT_USER, planDriverTypes, planRetire, reviewDrivers, untypedDrivers } = plan;

export const SCRIPT = 'awDivisions';
export const SUBCOMMANDS = ['report', 'drivers', 'retire-company', 'restore'];
export const AUDIT_ACTIONS = { drivers: 'AW_DRIVER_TYPE', 'retire-company': 'AW_DIVISION_RETIRE', restore: 'AW_DIVISION_RESTORE' };
/** Tables each subcommand writes (the backup coverage the gate demands); the union is PROD_WRITE_SETS.awDivisions. */
export const SUB_MODELS = {
  report: ['Driver', 'OwnershipDivision', 'AuditLog'],
  drivers: ['Driver', 'AuditLog'],
  'retire-company': ['OwnershipDivision', 'AuditLog'],
  restore: ['OwnershipDivision', 'AuditLog'],
};
export const EXPORT_DIR_NAME = 'pre-delete-company-division';
export const defaultExportDir = () => join(homedir(), 'bcat-ops-backups', EXPORT_DIR_NAME);

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function divisionsGate(sub, values, deps = {}) {
  if (!SUBCOMMANDS.includes(sub)) throw new Error(`unknown subcommand "${sub}" (${SUBCOMMANDS.join(' | ')})`);
  const apply = values.apply === true;
  const gate = await requireProd({ script: SCRIPT, values, tables: SUB_MODELS[sub], readOnly: !apply, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-divisions`;
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

/** Every table that can name a division, projected to just those fields. A missing table counts as empty. */
export async function scanRefTables(doc, suffix) {
  const out = {};
  for (const spec of COMPANY_REF_SPECS) {
    try {
      out[spec.model] = await scanAll(doc, `${spec.model}-${suffix}`, ['id', ...spec.fields]);
    } catch (err) {
      if (err?.name === 'ResourceNotFoundException') { out[spec.model] = []; continue; }
      throw err;
    }
  }
  return out;
}

const NOT_SET = 'attribute_not_exists(#f) OR attribute_type(#f, :nul) OR #f = :blank';

/** One driver: conditional driverType write + one AuditLog row. Returns 'written' | 'lost'. */
export async function applyDriver({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'driver type');
  const nowIso = now.toISOString();
  try {
    await doc.send(new UpdateCommand({
      TableName: `Driver-${suffix}`,
      Key: { id: entry.id },
      UpdateExpression: 'SET #f = :v, updatedAt = :now',
      ConditionExpression: entry.prev == null ? `attribute_exists(id) AND (${NOT_SET})` : 'attribute_exists(id) AND #f = :prev',
      ExpressionAttributeNames: { '#f': 'driverType' },
      ExpressionAttributeValues: { ':v': entry.next, ':now': nowIso, ...(entry.prev == null ? { ':nul': 'NULL', ':blank': '' } : { ':prev': entry.prev }) },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return 'lost';
    throw err;
  }
  await doc.send(new PutCommand({
    TableName: `AuditLog-${suffix}`,
    Item: {
      id: randomUUID(), __typename: 'AuditLog', entityType: 'DRIVER', entityId: entry.id, action: AUDIT_ACTIONS.drivers, user: AUDIT_USER,
      changes: JSON.stringify({ field: 'driverType', previous: entry.prev, next: entry.next, source: 'Ryne 2026-11-09', key: entry.key }),
      createdAt: nowIso, updatedAt: nowIso,
    },
  }));
  return 'written';
}

/** Export the division row (JSONL + manifest). Returns the directory. Throws before anything is deleted when it cannot be written. */
export function exportDivision(row, { dir = defaultExportDir(), now = new Date() } = {}) {
  const stampDir = join(dir, now.toISOString().replace(/[:.]/g, '-'));
  mkdirSync(stampDir, { recursive: true, mode: 0o700 });
  chmodSync(stampDir, 0o700);
  const body = `${JSON.stringify(row)}\n`;
  const file = join(stampDir, 'OwnershipDivision.jsonl');
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
  const manifest = { createdAt: now.toISOString(), tables: { OwnershipDivision: { rows: 1, sha256: createHash('sha256').update(body).digest('hex') } } };
  const mf = join(stampDir, 'manifest.json');
  writeFileSync(mf, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  chmodSync(mf, 0o600);
  return stampDir;
}

/** Read an export back, verifying its sha256 against the manifest. */
export function readExport(stampDir) {
  const body = readFileSync(join(stampDir, 'OwnershipDivision.jsonl'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(stampDir, 'manifest.json'), 'utf8'));
  if (createHash('sha256').update(body).digest('hex') !== manifest.tables.OwnershipDivision.sha256) throw new Error('export sha256 does not match its manifest');
  return body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Live re-check, export, conditional delete, audit. Refuses while any row references the code. */
export async function retireCompany({ doc, suffix, exportDir, now = new Date() }) {
  assertWritableSuffix(suffix, 'division retire');
  const divisions = await scanAll(doc, `OwnershipDivision-${suffix}`);
  const p = planRetire({ divisions, rowsByModel: await scanRefTables(doc, suffix) });
  if (p.status === 'ALREADY_GONE') return { status: p.status };
  if (p.status !== 'DELETE') return { status: p.status, refs: p.refs };
  const dir = exportDivision(p.row, { dir: exportDir, now });
  try {
    await doc.send(new DeleteCommand({
      TableName: `OwnershipDivision-${suffix}`,
      Key: { id: p.row.id },
      ConditionExpression: 'attribute_exists(id) AND #c = :code',
      ExpressionAttributeNames: { '#c': 'code' },
      ExpressionAttributeValues: { ':code': COMPANY_CODE },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { status: 'LOST_RACE', exportDir: dir };
    throw err;
  }
  const nowIso = now.toISOString();
  await doc.send(new PutCommand({
    TableName: `AuditLog-${suffix}`,
    Item: {
      id: randomUUID(), __typename: 'AuditLog', entityType: 'OWNERSHIP_DIVISION', entityId: p.row.id, action: AUDIT_ACTIONS['retire-company'], user: AUDIT_USER,
      changes: JSON.stringify({ deleted: { id: p.row.id, code: p.row.code, name: p.row.name, active: p.row.active }, mergedInto: 'ASSETS', exportDir: dir }),
      createdAt: nowIso, updatedAt: nowIso,
    },
  }));
  return { status: 'DELETED', exportDir: dir };
}

/** Put-if-absent of the exported row. */
export async function restoreDivision({ doc, suffix, from, now = new Date() }) {
  assertWritableSuffix(suffix, 'division restore');
  const rows = readExport(from);
  let restored = 0;
  for (const row of rows) {
    try {
      await doc.send(new PutCommand({ TableName: `OwnershipDivision-${suffix}`, Item: row, ConditionExpression: 'attribute_not_exists(id)' }));
      restored += 1;
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      continue;
    }
    const nowIso = now.toISOString();
    await doc.send(new PutCommand({
      TableName: `AuditLog-${suffix}`,
      Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'OWNERSHIP_DIVISION', entityId: row.id, action: AUDIT_ACTIONS.restore, user: AUDIT_USER, changes: JSON.stringify({ restoredFrom: from }), createdAt: nowIso, updatedAt: nowIso },
    }));
  }
  return { rows: rows.length, restored };
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function writeReviewCsv(path, reviewRows) {
  const head = ['first name', 'id prefix', 'active', 'driverType now', 'driverType proposed', 'fleetGroup now', 'fleetGroup proposed', 'payGroup now', 'payGroup proposed', 'unitType', 'truck unit', 'truck fleet group', 'trailer unit', 'division now', 'division after', 'status', 'flags'];
  const lines = reviewRows.map((r) => [r.firstName, r.id.slice(0, 8), r.active, r.driverType.current, r.driverType.proposed, r.fleetGroup.current, r.fleetGroup.proposed, r.payGroup.current, r.payGroup.proposed, r.unitType, r.truck?.unit, r.truck?.fleetGroup, r.trailer?.unit, r.before, r.after, r.status, r.flags.join('; ')]);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${[head.join(','), ...lines.map((l) => l.map(csvCell).join(','))].join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const histogram = (items, f) => { const o = {}; for (const x of items) { const k = f(x); o[k] = (o[k] ?? 0) + 1; } return o; };

async function main() {
  const { values, positionals } = parseArgs({
    options: { 'report-dir': { type: 'string' }, 'export-dir': { type: 'string' }, from: { type: 'string' }, apply: { type: 'boolean' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS },
    allowPositionals: true,
  });
  const sub = positionals[0] ?? 'report';
  if (values.help || !SUBCOMMANDS.includes(sub)) {
    console.log(`Usage: node scripts/awDivisions.mjs <${SUBCOMMANDS.join('|')}> [--report-dir <dir>] [--export-dir <dir>] [--from <export dir>] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`);
    return;
  }
  if (sub === 'restore' && !values.from) throw new Error('restore needs --from <export dir>');
  const gate = await divisionsGate(sub, values);
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const apply = values.apply === true && (gate === null ? true : gate.apply);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const T = (m) => `${m}-${suffix}`;

  if (sub === 'restore') {
    if (!apply) { console.log('DRY RUN: nothing written. restore would put-if-absent the exported OwnershipDivision row.'); return; }
    console.log('RESTORED', JSON.stringify(await restoreDivision({ doc, suffix, from: values.from })));
    return;
  }

  const [drivers, paySettings, equipment, divisions, rules] = await Promise.all([
    scanAll(doc, T('Driver'), ['id', 'name', 'type', 'active', 'driverType', 'fleetGroup', 'unitType', 'ivanApp', 'timeClock', 'assignedTruckId', 'assignedTrailerId']),
    scanAll(doc, T('DriverPaySetting'), ['id', 'driverId', 'payGroup', 'active']),
    scanAll(doc, T('Equipment'), ['id', 'type', 'unitNumber', 'fleetGroup', 'active', 'assignedDriverId']),
    scanAll(doc, T('OwnershipDivision')),
    scanAll(doc, T('OwnershipRule')),
  ]);

  if (sub === 'report' || sub === 'drivers') {
    const { entries, problems } = planDriverTypes(drivers);
    const review = reviewDrivers({ drivers, paySettings, equipment, divisions, rules });
    const toWrite = entries.filter((e) => e.status === 'WRITE');
    console.log(`DRIVERS ${drivers.length} rows (${review.length} roster drivers). Targets matched ${entries.length}/${plan.DRIVER_TARGETS.length}; problems ${JSON.stringify(problems)}`);
    console.log(`DRIVER TYPE WRITES ${toWrite.length} (field Driver.driverType only): ${JSON.stringify(toWrite.map((e) => `${e.id.slice(0, 8)} ${e.key.split('-')[0]} ${e.prev ?? 'blank'}->${e.next}`))}`);
    console.log(`NOOP ${JSON.stringify(entries.filter((e) => e.status === 'NOOP').map((e) => `${e.id.slice(0, 8)} ${e.key.split('-')[0]} ${e.next}`))}`);
    console.log(`NO TYPE FROM RYNE (not set, listed for him): ${JSON.stringify(untypedDrivers(drivers).map((d) => `${d.id.slice(0, 8)} ${String(d.name).split(' ')[0]} type=${d.driverType ?? 'blank'}`))}`);
    console.log(`DIVISION RESOLVER before->after ${JSON.stringify(histogram(review.filter((r) => r.status !== 'NOT_TARGET'), (r) => `${r.before}->${r.after}`))}; changed ${review.filter((r) => !r.topUnchanged).length}`);
    for (const r of review.filter((x) => x.flags.length)) console.log(`  ${r.id.slice(0, 8)} ${r.firstName}: ${r.flags.join('; ')}`);
    const csv = join(values['report-dir'] ?? join(homedir(), 'aljex-export', 'reports'), `driver-profile-review-${localDate(new Date())}.csv`);
    writeReviewCsv(csv, review);
    console.log(`profile review CSV (0600, first names only): ${csv}`);
    if (sub === 'drivers') {
      if (!apply) console.log(`DRY RUN: nothing written. ${toWrite.length} driver(s) would get driverType.`);
      else {
        const out = { written: 0, lost: 0 };
        for (const e of toWrite) out[(await applyDriver({ doc, suffix, entry: e })) === 'written' ? 'written' : 'lost'] += 1;
        console.log('APPLIED', JSON.stringify(out));
      }
    }
  }

  if (sub === 'report' || sub === 'retire-company') {
    const p = planRetire({ divisions, rowsByModel: await scanRefTables(doc, suffix) });
    const ruleCount = rules.filter((r) => r.divisionCode === COMPANY_CODE).length;
    console.log(`COMPANY DIVISION: ${p.status}; row ${p.row ? `active=${p.row.active} parentId=${p.row.parentId ?? 'null'}` : 'absent'}; ASSETS active top-level ${p.assetsActive}; OwnershipRule targeting it ${ruleCount}`);
    console.log(`REFERENCES to ${COMPANY_CODE} per table.field (0 = none): ${JSON.stringify(p.refs)}; blocking rows ${p.blocking}; tables scanned ${COMPANY_REF_SPECS.map((s) => s.model).join(',')}`);
    if (sub === 'retire-company') {
      if (!apply) console.log(`DRY RUN: nothing written. ${p.status === 'DELETE' ? 'Would export then delete the COMPANY OwnershipDivision row.' : `Would do nothing (${p.status}).`}`);
      else console.log('APPLIED', JSON.stringify(await retireCompany({ doc, suffix, exportDir: values['export-dir'] })));
    } else if (!apply) console.log('DRY RUN: nothing written.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
