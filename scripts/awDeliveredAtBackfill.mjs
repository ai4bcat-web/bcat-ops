#!/usr/bin/env node
/**
 * Delivered date for shipments that are DELIVERED but have no `deliveredAt` (Ryne 2026-11-12, PRO 20027).
 * Shipments are created with `deliveredAt: null`, and the stamp the notifier / projector write was guarded by
 * `attribute_not_exists(deliveredAt)`, which a NULL attribute fails, so these never got one. The guard is fixed;
 * this fills the ones it missed.
 *
 * Same precedence as the app (src/lib/deliveredAt.ts): the loads' own deliveredAt (latest), else the latest actual
 * time at a delivery stop (departure, else arrival), else when the shipment's status became DELIVERED. Only
 * `deliveredAt` (+ updatedAt/updatedBy) is written, only while the shipment is still DELIVERED and still unstamped;
 * the source of each value goes in its AuditLog row.
 *
 *   dry run (read-only):  BCAT_ALLOW_PROD=$(date +%F) node scripts/awDeliveredAtBackfill.mjs --target prod --i-mean-production
 *   backup (< 6 h before apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awDeliveredAtBackfill --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-delivered node scripts/awDeliveredAtBackfill.mjs --target prod --i-mean-production \
 *       --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Undo: set deliveredAt back to null on the shipments named in the AuditLog rows (action AW_DELIVERED_AT_BACKFILL), or restore from the backup.
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { scanAll } from './awCustomerEmail.mjs';

export const SCRIPT = 'awDeliveredAtBackfill';
export const AUDIT_ACTION = 'AW_DELIVERED_AT_BACKFILL';
export const AUDIT_USER = 'system:awDeliveredAtBackfill';

export async function deliveredGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awDeliveredAtBackfill.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-delivered`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
  }
  return gate;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const stopsOf = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

/** When one shipment was delivered, and from what. Pure, so it is tested. */
export function deliveredFor(shipment, loads) {
  const live = loads.filter((l) => !str(l.voidedAt));
  const stamps = live.map((l) => str(l.deliveredAt)).filter(Boolean).sort();
  if (stamps.length) return { at: stamps[stamps.length - 1], source: 'load deliveredAt' };
  const actuals = live.flatMap((l) => stopsOf(l.stops))
    .filter((s) => String(s?.type ?? '').toLowerCase() === 'delivery')
    .map((s) => str(s.departedAt) || str(s.arrivedAt))
    .filter(Boolean)
    .sort();
  if (actuals.length) return { at: actuals[actuals.length - 1], source: 'last delivery stop actual' };
  if (str(shipment.statusChangedAt)) return { at: str(shipment.statusChangedAt), source: 'status changed to DELIVERED' };
  return null;
}

export function planDeliveredAt({ shipments, loads }) {
  const byShipment = new Map();
  for (const l of loads) { const id = str(l.shipmentId); if (!id) continue; if (!byShipment.has(id)) byShipment.set(id, []); byShipment.get(id).push(l); }
  return shipments
    .filter((s) => s.status === 'DELIVERED' && !str(s.deliveredAt) && !str(s.voidedAt) && !str(s.deletedAt))
    .map((s) => {
      const found = deliveredFor(s, byShipment.get(s.id) ?? []);
      return found ? { shipment: s, status: 'READY', ...found } : { shipment: s, status: 'NO_DATE', why: 'no load stamp, stop actual or status change time' };
    })
    .sort((a, b) => String(a.shipment.number ?? '').localeCompare(String(b.shipment.number ?? '')));
}

export async function applyOne({ doc, suffix, row, now = new Date() }) {
  assertWritableSuffix(suffix, 'shipment deliveredAt backfill');
  const nowIso = now.toISOString();
  try {
    await doc.send(new UpdateCommand({
      TableName: `Shipment-${suffix}`, Key: { id: row.shipment.id },
      UpdateExpression: 'SET deliveredAt = :d, updatedAt = :at, updatedBy = :by',
      ConditionExpression: 'attribute_exists(id) AND #st = :delivered AND (attribute_not_exists(deliveredAt) OR attribute_type(deliveredAt, :nul) OR deliveredAt = :blank)',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':d': row.at, ':at': nowIso, ':by': AUDIT_USER, ':delivered': 'DELIVERED', ':nul': 'NULL', ':blank': '' },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: 1 };
    throw err;
  }
  await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'Shipment', entityId: row.shipment.id, action: AUDIT_ACTION, user: AUDIT_USER, changes: JSON.stringify({ previous: { deliveredAt: null }, next: { deliveredAt: row.at }, source: row.source, shipmentNumber: row.shipment.number ?? null }), createdAt: nowIso, updatedAt: nowIso } }));
  return { written: 1, lost: 0 };
}

export function buildReport({ plan, today }) {
  const L = [`# Shipments delivered with no delivered date (dry run ${today})`, ''];
  for (const r of plan) L.push(`- ${r.shipment.number ?? r.shipment.id}: ${r.status === 'READY' ? `${r.at} (${r.source})` : `NO_DATE (${r.why})`} · status changed ${r.shipment.statusChangedAt ?? '—'} by ${r.shipment.statusChangedBy ?? '—'}`);
  if (!plan.length) L.push('- none');
  L.push('');
  return L.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { report: { type: 'string' }, apply: { type: 'boolean' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS }, allowPositionals: false });
  if (values.help) { console.log(`Usage: node scripts/awDeliveredAtBackfill.mjs [--report <file.md>] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`); return; }
  const gate = await deliveredGate(values);
  let suffix;
  if (gate) suffix = gate.suffix; else { suffix = values.suffix ?? DEV_SUFFIX; if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate'); }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const shipments = await scanAll(doc, `Shipment-${suffix}`, ['id', 'number', 'status', 'deliveredAt', 'statusChangedAt', 'statusChangedBy', 'voidedAt', 'deletedAt']);
  const candidates = new Set(shipments.filter((s) => s.status === 'DELIVERED' && !str(s.deliveredAt)).map((s) => s.id));
  const loads = candidates.size ? (await scanAll(doc, `Load-${suffix}`, ['id', 'shipmentId', 'deliveredAt', 'stops', 'voidedAt'])).filter((l) => candidates.has(l.shipmentId)) : [];
  const plan = planDeliveredAt({ shipments, loads });
  const report = buildReport({ plan, today: localDate(new Date()) });
  const path = values.report ?? '/private/tmp/delivered-at-report.md';
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${report}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  console.log(report);
  const ready = plan.filter((r) => r.status === 'READY');
  if (!apply) { console.log(`DRY RUN: nothing written. ${ready.length} of ${plan.length} shipments would get a delivered date.`); return; }
  const out = { written: 0, lost: 0 };
  for (const row of ready) { const x = await applyOne({ doc, suffix, row }); out.written += x.written; out.lost += x.lost; }
  console.log('APPLIED', JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
