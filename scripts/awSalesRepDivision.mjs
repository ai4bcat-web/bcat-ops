#!/usr/bin/env node
/**
 * Sales rep by division (Ryne 2026-11-09): Ivan Cartage loads (ASSETS) -> Ivan Cartage, car shipping -> Ruben Vargas,
 * brokerage -> Ryne Bandolik. Dry by default, prod-gated apply. (1) sets TmsSettings.divisionSalesReps so every NEW shipment
 * defaults the same way (the shipment form and the server already read that map), (2) re-tags every live shipment that has a
 * different rep (Shipment.salesRepId/salesRepCode, Order.customerRepId), one conditional write each, one AuditLog row with the
 * previous values. A group rep (Ivan Cartage) has an empty salesRepCode, like awSalesRepId. Voided shipments are left alone.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awSalesRepDivision.mjs --target prod --i-mean-production
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awSalesRepDivision --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-salesrepdivision node scripts/awSalesRepDivision.mjs \
 *               --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { planDivisionReps } from './lib/salesRepDivisionPlan.mjs';

export const SCRIPT = 'awSalesRepDivision';
export const AUDIT_ACTION = 'AW_SALES_REP_DIVISION';

export async function divisionGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models, deps });
  if (gate?.apply && !gate.rehearsal && (deps.env ?? process.env).AW_PROD_CONFIRM !== `${localDate(deps.now ?? new Date())}-salesrepdivision`) {
    throw new Error('AW_PROD_CONFIRM must be <today>-salesrepdivision');
  }
  return gate;
}

const scan = async (doc, table, names) => {
  const rows = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: table, ExclusiveStartKey: key, ConsistentRead: true,
      ProjectionExpression: names.map((n) => `#${n}`).join(','), ExpressionAttributeNames: Object.fromEntries(names.map((n) => [`#${n}`, n])),
    }));
    rows.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return rows;
};

/** One shipment: conditional on the rep still being what the dry read saw (a person who changed it meanwhile wins). */
export async function applyEntry({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'sales rep by division');
  const nowIso = now.toISOString();
  let lost = 0;
  if (entry.shipWrite) {
    const b = entry.shipWrite.before;
    try {
      await doc.send(new UpdateCommand({
        TableName: `Shipment-${suffix}`, Key: { id: entry.shipment.id },
        UpdateExpression: 'SET salesRepId = :id, salesRepCode = :code, updatedAt = :now',
        ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(voidedAt) AND (attribute_not_exists(salesRepId) OR salesRepId = :was OR attribute_type(salesRepId, :nul))',
        ExpressionAttributeValues: { ':id': entry.shipWrite.value.salesRepId, ':code': entry.shipWrite.value.salesRepCode, ':now': nowIso, ':was': b.salesRepId ?? '', ':nul': 'NULL' },
      }));
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: 1 };
      throw err;
    }
  }
  for (const w of entry.orderWrites) {
    try {
      await doc.send(new UpdateCommand({
        TableName: `Order-${suffix}`, Key: { id: w.id }, UpdateExpression: 'SET customerRepId = :v, updatedAt = :now',
        ConditionExpression: 'attribute_exists(id)', ExpressionAttributeValues: { ':v': w.value, ':now': nowIso },
      }));
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') { lost += 1; continue; }
      throw err;
    }
  }
  await doc.send(new PutCommand({
    TableName: `AuditLog-${suffix}`,
    Item: {
      id: randomUUID(), __typename: 'AuditLog', entityType: 'SHIPMENT', entityId: entry.shipment.id, action: AUDIT_ACTION, user: `system:${SCRIPT}`,
      changes: JSON.stringify({ division: entry.shipment.revDivision, rep: entry.target.name, previous: { shipment: entry.shipWrite?.before ?? null, orders: entry.orderWrites.map((w) => ({ id: w.id, customerRepId: w.before })) }, next: { shipment: entry.shipWrite?.value ?? null } }),
      createdAt: nowIso, updatedAt: nowIso,
    },
  }));
  return { written: 1, lost };
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, ...PROD_GATE_OPTIONS } });
  const gate = await divisionGate(values);
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const [shipments, orders, profiles, settings] = await Promise.all([
    scan(doc, `Shipment-${suffix}`, ['id', 'voidedAt', 'revDivision', 'salesRepId', 'salesRepCode']),
    scan(doc, `Order-${suffix}`, ['id', 'shipmentId', 'customerRepId']),
    scan(doc, `UserProfile-${suffix}`, ['id', 'name', 'email', 'status']),
    doc.send(new GetCommand({ TableName: `TmsSettings-${suffix}`, Key: { id: 'default' }, ConsistentRead: true })).then((r) => r.Item),
  ]);
  let current = settings?.divisionSalesReps ?? {};
  if (typeof current === 'string') { try { current = JSON.parse(current); } catch { current = {}; } }
  const plan = planDivisionReps({ shipments, orders, profiles, currentSettingsMap: current });
  if (plan.missing.length) throw new Error(`Missing rep profile(s): ${plan.missing.join(', ')}`);
  const byDiv = {};
  for (const e of plan.entries) byDiv[`${e.shipment.revDivision}->${e.target.name}`] = (byDiv[`${e.shipment.revDivision}->${e.target.name}`] ?? 0) + 1;
  console.log(`shipments ${shipments.length}; to re-tag ${plan.entries.length} ${JSON.stringify(byDiv)}; already right ${plan.unchanged}; skipped ${JSON.stringify(plan.skipped)}`);
  console.log(`order rows to change ${plan.entries.reduce((n, e) => n + e.orderWrites.length, 0)}; settings default map ${plan.settings.changed ? 'will be set' : 'already set'}`);
  if (!apply) return console.log('DRY RUN: nothing written.');
  if (plan.settings.changed) {
    await doc.send(new UpdateCommand({
      TableName: `TmsSettings-${suffix}`, Key: { id: 'default' },
      UpdateExpression: 'SET divisionSalesReps = :m, updatedBy = :by, updatedAt = :at', ExpressionAttributeValues: { ':m': plan.settings.next, ':by': `system:${SCRIPT}`, ':at': new Date().toISOString() },
    }));
    console.log('SETTINGS divisionSalesReps set');
  }
  let written = 0; let lost = 0;
  for (const entry of plan.entries) {
    const r = await applyEntry({ doc, suffix, entry });
    written += r.written; lost += r.lost;
  }
  console.log(`APPLIED ${written} shipment(s); lost races ${lost}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
