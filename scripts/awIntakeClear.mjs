#!/usr/bin/env node
/**
 * Clear OPEN intake rows whose shipment already exists (Ryne 2026-11-10). A row is matched to a shipment when its reference / pickup /
 * delivery number is one of the shipment's order reference values, or by an explicit `--pair <intakeId>=<PRO>`. The row becomes MOVED with
 * shipmentId + shipmentNumber, one conditional UpdateItem each (only while still OPEN) and one AuditLog row. Dry by default, prod-gated apply.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awIntakeClear.mjs --target prod --i-mean-production [--pair il:wf:TENDER:fad9c...=20002]
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awIntakeClear --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-intakeclear node scripts/awIntakeClear.mjs --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE [--pair ...]
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';

export const SCRIPT = 'awIntakeClear';
const norm = (v) => String(v ?? '').trim().toLowerCase();
const json = (v) => { if (typeof v !== 'string') return v ?? {}; try { return JSON.parse(v); } catch { return {}; } };

/** Pure: which OPEN rows to mark MOVED, and to which shipment. */
export function planIntakeClear({ intake, shipments, orders, pairs = {} }) {
  const refsOf = new Map();
  for (const o of orders) {
    const set = refsOf.get(o.shipmentId) ?? new Set();
    for (const r of Array.isArray(o.references) ? o.references : []) if (norm(r.value)) set.add(norm(r.value));
    refsOf.set(o.shipmentId, set);
  }
  const byNumber = new Map(shipments.filter((s) => !s.voidedAt).map((s) => [String(s.number), s]));
  const entries = []; const unmatched = [];
  for (const row of intake.filter((r) => r.status === 'OPEN')) {
    let ship = pairs[row.id] ? byNumber.get(String(pairs[row.id])) : null; let how = ship ? 'PAIR' : null;
    if (!ship) {
      const f = json(row.fields); const keys = [f.reference, f.pickupNumber, f.deliveryNumber].map(norm).filter(Boolean);
      const hits = shipments.filter((s) => !s.voidedAt && keys.some((k) => refsOf.get(s.id)?.has(k)));
      if (hits.length === 1) { ship = hits[0]; how = 'REFERENCE'; }
    }
    if (ship) entries.push({ row, shipment: ship, how }); else unmatched.push(row);
  }
  return { entries, unmatched };
}

async function scan(doc, table) { const rows = []; let key; do { const r = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ConsistentRead: true })); rows.push(...(r.Items ?? [])); key = r.LastEvaluatedKey; } while (key); return rows; }

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, pair: { type: 'string', multiple: true }, ...PROD_GATE_OPTIONS } });
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models });
  if (gate?.apply && process.env.AW_PROD_CONFIRM !== `${localDate(new Date())}-intakeclear`) throw new Error('AW_PROD_CONFIRM must be <today>-intakeclear');
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const pairs = Object.fromEntries((values.pair ?? []).map((p) => p.split('=')));
  const [intake, shipments, orders] = await Promise.all(['IntakeLoad', 'Shipment', 'Order'].map((m) => scan(doc, `${m}-${suffix}`)));
  const { entries, unmatched } = planIntakeClear({ intake, shipments, orders, pairs });
  for (const e of entries) console.log(`CLEAR ${e.row.id} (${String(e.row.subject ?? '').slice(0, 50)}) -> ${e.shipment.number} via ${e.how}`);
  for (const r of unmatched) console.log(`STAYS ${r.id} (${String(r.subject ?? '').slice(0, 50)})`);
  if (!apply) return console.log('DRY RUN: nothing written.');
  assertWritableSuffix(suffix, 'intake clear');
  const now = new Date().toISOString();
  for (const e of entries) {
    await doc.send(new UpdateCommand({
      TableName: `IntakeLoad-${suffix}`, Key: { id: e.row.id },
      UpdateExpression: 'SET #s = :moved, shipmentId = :sid, shipmentNumber = :num, updatedAt = :now, updatedBy = :by',
      ConditionExpression: '#s = :open', ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':moved': 'MOVED', ':open': 'OPEN', ':sid': e.shipment.id, ':num': e.shipment.number, ':now': now, ':by': `system:${SCRIPT}` },
    }));
    await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'INTAKE_LOAD', entityId: e.row.id, action: 'AW_INTAKE_CLEAR', user: `system:${SCRIPT}`, changes: JSON.stringify({ shipmentId: e.shipment.id, shipmentNumber: e.shipment.number, via: e.how }), createdAt: now, updatedAt: now } }));
  }
  console.log(`CLEARED ${entries.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
