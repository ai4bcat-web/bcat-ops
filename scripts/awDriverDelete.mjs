#!/usr/bin/env node
/**
 * Delete test drivers (Ryne 2026-11-10: every "Ryne Test" account). Dry by default, prod-gated apply. Repeat --id for each driver.
 * A driver nothing references is simply deleted. One that is still referenced (Load / LoadCarrier / DriverSubmission) is refused unless
 * --detach is given: then the references are cleared first (Load.pickupDriverId / deliveryDriverId and LoadCarrier.driverId set to null, the
 * driver NAME text on the leg kept; the driver's own DriverSubmission + DriverSubmissionDoc rows deleted; S3 files left alone). Any company
 * phone it carried goes back to the office. One AuditLog row per driver keeps the deleted row and what was detached.
 * A driver's sign-in (Cognito driver pool) is not touched here.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awDriverDelete.mjs --target prod --i-mean-production --id <id> [--id <id>] [--detach]
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awDriverDelete --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-driverdelete node scripts/awDriverDelete.mjs --target prod --i-mean-production --id <id> [--id <id>] [--detach] --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';

export const SCRIPT = 'awDriverDelete';

/** Pure: how many rows point at the driver. */
export const referenceCounts = ({ loadCarriers, loads, submissions }, id) => ({
  loadCarriers: loadCarriers.filter((r) => r.driverId === id).length,
  loads: loads.filter((r) => r.pickupDriverId === id || r.deliveryDriverId === id).length,
  submissions: submissions.filter((r) => r.driverId === id).length,
});

export async function driverGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models, deps });
  if (gate?.apply && !gate.rehearsal && (deps.env ?? process.env).AW_PROD_CONFIRM !== `${localDate(deps.now ?? new Date())}-driverdelete`) {
    throw new Error('AW_PROD_CONFIRM must be <today>-driverdelete');
  }
  return gate;
}

const scan = async (doc, table) => { const rows = []; let key; do { const r = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ConsistentRead: true })); rows.push(...(r.Items ?? [])); key = r.LastEvaluatedKey; } while (key); return rows; };

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, detach: { type: 'boolean' }, suffix: { type: 'string' }, id: { type: 'string', multiple: true }, ...PROD_GATE_OPTIONS } });
  if (!values.id?.length) throw new Error('--id <driver id> is required (repeat it for each driver)');
  const gate = await driverGate(values);
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const [loadCarriers, loads, submissions, submissionDocs, phones] = await Promise.all(['LoadCarrier', 'Load', 'DriverSubmission', 'DriverSubmissionDoc', 'CompanyPhone'].map((m) => scan(doc, `${m}-${suffix}`)));
  const plans = [];
  for (const id of values.id) {
    const driver = (await doc.send(new GetCommand({ TableName: `Driver-${suffix}`, Key: { id }, ConsistentRead: true }))).Item;
    if (!driver) throw new Error(`Driver not found: ${id}`);
    const refs = referenceCounts({ loadCarriers, loads, submissions }, id);
    const used = refs.loadCarriers + refs.loads + refs.submissions;
    console.log(`driver "${driver.name}" refs ${JSON.stringify(refs)}; company phones carried ${phones.filter((p) => p.assignedDriverId === id).map((p) => p.label).join(', ') || 'none'}${used ? (values.detach ? '; will be DETACHED then deleted' : '; REFUSED without --detach') : ''}`);
    if (used && !values.detach) throw new Error('This driver is referenced by shipments or submissions. Re-run with --detach to clear those references, or leave it.');
    plans.push({ id, driver, refs });
  }
  if (!apply) return console.log('DRY RUN: nothing written.');
  assertWritableSuffix(suffix, 'driver delete');
  const now = new Date().toISOString();
  for (const { id, driver, refs } of plans) {
    const detached = { loads: [], loadCarriers: [], submissions: [], submissionDocs: [] };
    for (const l of loads.filter((r) => r.pickupDriverId === id || r.deliveryDriverId === id)) {
      const names = {}; const sets = [];
      if (l.pickupDriverId === id) { sets.push('pickupDriverId = :n'); }
      if (l.deliveryDriverId === id) { sets.push('deliveryDriverId = :n'); }
      await doc.send(new UpdateCommand({ TableName: `Load-${suffix}`, Key: { id: l.id }, UpdateExpression: `SET ${sets.join(', ')}, updatedAt = :t`, ExpressionAttributeValues: { ':n': null, ':t': now } }));
      detached.loads.push({ id: l.id, pickupDriverId: l.pickupDriverId ?? null, deliveryDriverId: l.deliveryDriverId ?? null });
    }
    for (const lc of loadCarriers.filter((r) => r.driverId === id)) {
      await doc.send(new UpdateCommand({ TableName: `LoadCarrier-${suffix}`, Key: { id: lc.id }, UpdateExpression: 'SET driverId = :n, updatedAt = :t', ExpressionAttributeValues: { ':n': null, ':t': now } }));
      detached.loadCarriers.push({ id: lc.id, driverId: id });
    }
    for (const d of submissionDocs.filter((r) => r.driverId === id)) { await doc.send(new DeleteCommand({ TableName: `DriverSubmissionDoc-${suffix}`, Key: { id: d.id } })); detached.submissionDocs.push(d); }
    for (const sub of submissions.filter((r) => r.driverId === id)) { await doc.send(new DeleteCommand({ TableName: `DriverSubmission-${suffix}`, Key: { id: sub.id } })); detached.submissions.push(sub); }
    for (const p of phones.filter((x) => x.assignedDriverId === id)) await doc.send(new UpdateCommand({ TableName: `CompanyPhone-${suffix}`, Key: { label: p.label }, UpdateExpression: 'SET assignedDriverId = :n, updatedAt = :t', ExpressionAttributeValues: { ':n': null, ':t': now } }));
    await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'DRIVER', entityId: id, action: 'AW_DRIVER_DELETE', user: `system:${SCRIPT}`, changes: JSON.stringify({ deleted: driver, refs, detached }), createdAt: now, updatedAt: now } }));
    await doc.send(new DeleteCommand({ TableName: `Driver-${suffix}`, Key: { id }, ConditionExpression: 'attribute_exists(id)' }));
    console.log(`DELETED "${driver.name}"`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
