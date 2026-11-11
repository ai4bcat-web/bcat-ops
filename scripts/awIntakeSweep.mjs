#!/usr/bin/env node
/**
 * Sweep the Intake queue (Ryne 2026-11-10: "remove everything from October 30 and sooner, and everything already built today and
 * yesterday"). Only OPEN rows are touched, one conditional UpdateItem each (only while still OPEN) and one AuditLog row each:
 *   - BUILT: a row whose reference / pickup / delivery number is an order reference of a shipment CREATED today or yesterday becomes
 *     MOVED with that shipment's id and number (the same result as awIntakeClear, limited to those shipments);
 *   - SUBJECT: `--subject "<text>=<PRO>"` (repeatable) moves every OPEN row whose subject contains <text> (case-insensitive) to shipment <PRO>;
 *     a row matching two different --subject texts is left alone;
 *   - DUPLICATE (`--dedupe`): of the OPEN rows left, the same e-mail delivered twice (same subject and opening text within 10 minutes) keeps the
 *     earliest row and DISMISSES the later copies with the reason "Duplicate of <id>";
 *   - OLD: every other row RECEIVED on or before --through (default 2026-10-30, local date) becomes DISMISSED with a reason.
 * Nothing is deleted: a dismissed or moved row stays in the Dismissed / Moved views. Dry by default, prod-gated apply.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awIntakeSweep.mjs --target prod --i-mean-production [--through 2026-10-30] [--pair il:wf:TENDER:fad9c...=20002] [--subject "Sussex to NY=20011"]
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awIntakeSweep --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-intakesweep node scripts/awIntakeSweep.mjs --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { planIntakeClear } from './awIntakeClear.mjs';
import { isSameEmail } from '../src/lib/intakeDup.ts';

export const SCRIPT = 'awIntakeSweep';
export const DEFAULT_THROUGH = '2026-10-30';
const DAY_MS = 24 * 60 * 60 * 1000;

const dateOf = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : localDate(d); };

/**
 * Pure: which OPEN rows are MOVED to a shipment built today or yesterday, and which of the rest are DISMISSED as old.
 * `through` is a local date (YYYY-MM-DD): a row received on that day or earlier is old.
 */
export function planIntakeSweep({ intake, shipments, orders, now = new Date(), through = DEFAULT_THROUGH, pairs = {}, subjects = [], dedupe = false }) {
  const recent = new Set([localDate(now), localDate(new Date(now.getTime() - DAY_MS))]);
  const builtRecently = shipments.filter((s) => recent.has(dateOf(s.createdAt)));
  const built = planIntakeClear({ intake, shipments: builtRecently, orders, pairs });
  const moved = built.entries;
  const movedIds = new Set(moved.map((e) => e.row.id));
  // Subject matches: each OPEN row not already matched, to the one shipment number its subject names.
  const byNumber = new Map(shipments.filter((s) => !s.voidedAt).map((s) => [String(s.number), s]));
  const ambiguous = [];
  for (const row of intake.filter((r) => r.status === 'OPEN' && !movedIds.has(r.id))) {
    const subject = String(row.subject ?? '').toLowerCase();
    const hits = subjects.filter((sj) => sj.text && subject.includes(sj.text.toLowerCase()));
    const numbers = [...new Set(hits.map((h) => String(h.number)))];
    if (numbers.length > 1) { ambiguous.push(row.id); movedIds.add(row.id); continue; }
    const ship = numbers.length === 1 ? byNumber.get(numbers[0]) : null;
    if (ship) { moved.push({ row, shipment: ship, how: 'SUBJECT' }); movedIds.add(row.id); }
  }
  const dismissed = []; const stays = [];
  for (const row of intake.filter((r) => r.status === 'OPEN' && !movedIds.has(r.id))) {
    const received = dateOf(row.receivedAt || row.createdAt);
    if (received && received <= through) dismissed.push(row); else stays.push(row);
  }
  const duplicates = [];
  const keep = [];
  if (dedupe) {
    const ordered = [...stays].sort((a, b) => String(a.receivedAt ?? a.createdAt).localeCompare(String(b.receivedAt ?? b.createdAt)));
    for (const row of ordered) {
      const first = keep.find((k) => isSameEmail(k, row));
      if (first) duplicates.push({ row, of: first }); else keep.push(row);
    }
  } else keep.push(...stays);
  const staying = [...keep, ...intake.filter((r) => ambiguous.includes(r.id))];
  return { moved, dismissed, duplicates, stays: staying, recentDays: [...recent] };
}

async function scan(doc, table) { const rows = []; let key; do { const r = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ConsistentRead: true })); rows.push(...(r.Items ?? [])); key = r.LastEvaluatedKey; } while (key); return rows; }

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, through: { type: 'string' }, pair: { type: 'string', multiple: true }, dedupe: { type: 'boolean' }, subject: { type: 'string', multiple: true }, ...PROD_GATE_OPTIONS } });
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models });
  if (gate?.apply && process.env.AW_PROD_CONFIRM !== `${localDate(new Date())}-intakesweep`) throw new Error('AW_PROD_CONFIRM must be <today>-intakesweep');
  const through = values.through ?? DEFAULT_THROUGH;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through)) throw new Error('--through must be YYYY-MM-DD');
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const pairs = Object.fromEntries((values.pair ?? []).map((p) => p.split('=')));
  const [intake, shipments, orders] = await Promise.all(['IntakeLoad', 'Shipment', 'Order'].map((m) => scan(doc, `${m}-${suffix}`)));
  const subjects = (values.subject ?? []).map((v) => { const i = v.lastIndexOf('='); return { text: v.slice(0, i).trim(), number: v.slice(i + 1).trim() }; });
  for (const sj of subjects) if (!sj.text || !sj.number) throw new Error('--subject must be "<text>=<PRO>"');
  const plan = planIntakeSweep({ intake, shipments, orders, through, pairs, subjects, dedupe: values.dedupe === true });
  for (const sj of subjects) if (!shipments.some((s) => !s.voidedAt && String(s.number) === sj.number)) throw new Error(`--subject: no live shipment ${sj.number}`);
  const label = (r) => `${r.id} (${String(r.receivedAt ?? '').slice(0, 10)} ${String(r.subject ?? '').slice(0, 50)})`;
  for (const e of plan.moved) console.log(`BUILT   ${label(e.row)} -> ${e.shipment.number} via ${e.how}`);
  for (const r of plan.dismissed) console.log(`OLD     ${label(r)}`);
  for (const d of plan.duplicates) console.log(`DUP     ${label(d.row)} duplicate of ${d.of.id}`);
  console.log(`built days: ${plan.recentDays.join(', ')} | MOVE ${plan.moved.length} | DISMISS ${plan.dismissed.length} (received on or before ${through}) | DUPLICATES ${plan.duplicates.length} | STAY ${plan.stays.length}`);
  if (!apply) return console.log('DRY RUN: nothing written.');
  assertWritableSuffix(suffix, 'intake sweep');
  const now = new Date().toISOString();
  const by = `system:${SCRIPT}`;
  const audit = (rowId, action, changes) => doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'INTAKE_LOAD', entityId: rowId, action, user: by, changes: JSON.stringify(changes), createdAt: now, updatedAt: now } }));
  for (const e of plan.moved) {
    await doc.send(new UpdateCommand({
      TableName: `IntakeLoad-${suffix}`, Key: { id: e.row.id },
      UpdateExpression: 'SET #s = :moved, shipmentId = :sid, shipmentNumber = :num, updatedAt = :now, updatedBy = :by',
      ConditionExpression: '#s = :open', ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':moved': 'MOVED', ':open': 'OPEN', ':sid': e.shipment.id, ':num': e.shipment.number, ':now': now, ':by': by },
    }));
    await audit(e.row.id, 'AW_INTAKE_SWEEP_BUILT', { shipmentId: e.shipment.id, shipmentNumber: e.shipment.number, via: e.how });
  }
  for (const r of plan.dismissed) {
    await doc.send(new UpdateCommand({
      TableName: `IntakeLoad-${suffix}`, Key: { id: r.id },
      UpdateExpression: 'SET #s = :dis, dismissedAt = :now, dismissedBy = :by, dismissReason = :why, updatedAt = :now, updatedBy = :by',
      ConditionExpression: '#s = :open', ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':dis': 'DISMISSED', ':open': 'OPEN', ':now': now, ':by': by, ':why': `Cleared: received on or before ${through}` },
    }));
    await audit(r.id, 'AW_INTAKE_SWEEP_OLD', { through, receivedAt: r.receivedAt ?? null });
  }
  for (const d of plan.duplicates) {
    await doc.send(new UpdateCommand({
      TableName: `IntakeLoad-${suffix}`, Key: { id: d.row.id },
      UpdateExpression: 'SET #s = :dis, dismissedAt = :now, dismissedBy = :by, dismissReason = :why, updatedAt = :now, updatedBy = :by',
      ConditionExpression: '#s = :open', ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':dis': 'DISMISSED', ':open': 'OPEN', ':now': now, ':by': by, ':why': `Duplicate of ${d.of.id}` },
    }));
    await audit(d.row.id, 'AW_INTAKE_SWEEP_DUPLICATE', { duplicateOf: d.of.id });
  }
  console.log(`MOVED ${plan.moved.length}, DISMISSED ${plan.dismissed.length}, DUPLICATES ${plan.duplicates.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
