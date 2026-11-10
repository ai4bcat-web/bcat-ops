#!/usr/bin/env node
/**
 * Delete a driver nobody has used (Ryne 2026-11-10: "Ryne Test (Ivan)"). Dry by default, prod-gated apply.
 * The driver row is deleted ONLY when nothing references it (no LoadCarrier, Load, DriverSubmission); one that is in use is refused,
 * never half-deleted. Any company phone it carried goes back to the office. One AuditLog row keeps the deleted row.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awDriverDelete.mjs --target prod --i-mean-production --id <driver id>
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awDriverDelete --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-driverdelete node scripts/awDriverDelete.mjs --target prod --i-mean-production --id <driver id> --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
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
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, id: { type: 'string' }, ...PROD_GATE_OPTIONS } });
  if (!values.id) throw new Error('--id <driver id> is required');
  const gate = await driverGate(values);
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const driver = (await doc.send(new GetCommand({ TableName: `Driver-${suffix}`, Key: { id: values.id }, ConsistentRead: true }))).Item;
  if (!driver) throw new Error(`Driver not found: ${values.id}`);
  const [loadCarriers, loads, submissions, phones] = await Promise.all(['LoadCarrier', 'Load', 'DriverSubmission', 'CompanyPhone'].map((m) => scan(doc, `${m}-${suffix}`)));
  const refs = referenceCounts({ loadCarriers, loads, submissions }, values.id);
  const carried = phones.filter((p) => p.assignedDriverId === values.id);
  console.log(`driver "${driver.name}" refs ${JSON.stringify(refs)}; company phones carried ${carried.map((p) => p.label).join(', ') || 'none'}`);
  if (refs.loadCarriers + refs.loads + refs.submissions > 0) throw new Error('This driver is referenced by shipments or submissions; it is not deleted. Deactivate it instead.');
  if (!apply) return console.log('DRY RUN: nothing written.');
  assertWritableSuffix(suffix, 'driver delete');
  const now = new Date().toISOString();
  for (const p of carried) await doc.send(new UpdateCommand({ TableName: `CompanyPhone-${suffix}`, Key: { label: p.label }, UpdateExpression: 'SET assignedDriverId = :n, updatedAt = :t', ExpressionAttributeValues: { ':n': null, ':t': now } }));
  await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'DRIVER', entityId: values.id, action: 'AW_DRIVER_DELETE', user: `system:${SCRIPT}`, changes: JSON.stringify({ deleted: driver }), createdAt: now, updatedAt: now } }));
  await doc.send(new DeleteCommand({ TableName: `Driver-${suffix}`, Key: { id: values.id }, ConditionExpression: 'attribute_exists(id)' }));
  console.log('DELETED 1');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
