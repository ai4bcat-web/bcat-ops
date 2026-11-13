#!/usr/bin/env node
/**
 * Car shipping: carrier bills already made by Move to billing get the delivered day as their bill date and
 * delivered + 2 days as their due date (Ryne 2026-11-13), the rule the release now applies itself
 * (amplify/functions/_shared/pendingCarrierBill.ts `carShippingBillDates`). That moves them from Payables →
 * Expected to Aging.
 *
 * Only bills that are still IN_REVIEW, still `datesPending`, with no money applied, on a CAR_SHIPPING shipment,
 * are touched; the write is the same field set SET_BILL_DATES writes (billDate, billMonth, dueAt, datesPending
 * false) plus termsDays 2, conditioned on the bill still being exactly that. `--exclude` takes PRO numbers to
 * leave alone. One AuditLog row per bill.
 *
 *   dry run (read-only):  BCAT_ALLOW_PROD=$(date +%F) node scripts/awAutoCarrierBillBackfill.mjs --target prod --i-mean-production
 *   backup (< 6 h before apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awAutoCarrierBillBackfill --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-autobills node scripts/awAutoCarrierBillBackfill.mjs --target prod --i-mean-production \
 *       --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE [--exclude 13175,14061]
 *
 * Undo: restore each bill's `from` values in its AuditLog row (action AW_AUTO_CARRIER_BILL_DATES), or restore from the backup.
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
import { deliveredTimeOf } from '../src/lib/deliveredAt.ts';

export const SCRIPT = 'awAutoCarrierBillBackfill';
export const AUDIT_ACTION = 'AW_AUTO_CARRIER_BILL_DATES';
export const AUDIT_USER = 'system:awAutoCarrierBillBackfill';
export const TERMS_DAYS = 2;

export async function autoBillGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awAutoCarrierBillBackfill.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-autobills`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
  }
  return gate;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const stopsOf = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : null; } catch { return null; } }
  return null;
};
const chicagoDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
export const isCarShipping = (row) => str(row?.revDivision).toUpperCase() === 'CAR_SHIPPING';

/** `YYYY-MM-DD` + n days, in UTC (the app's dueDateFor). */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The bill's dates from the shipment and its load: the same precedence as the release. Pure. */
export function datesFor(shipment, load) {
  const delivered = deliveredTimeOf({
    deliveredAt: str(shipment?.deliveredAt) || null,
    loadDeliveredAt: str(load?.deliveredAt) || null,
    stops: stopsOf(shipment?.stops) ?? stopsOf(load?.stops),
    status: str(shipment?.status) || null,
    statusChangedAt: str(shipment?.statusChangedAt) || null,
  });
  const at = delivered ? new Date(delivered) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const billDate = chicagoDay.format(at);
  return { billDate, dueAt: addDays(billDate, TERMS_DAYS) };
}

export function planAutoBills({ bills, shipments, loads, exclude = [] }) {
  const shipmentById = new Map(shipments.map((s) => [s.id, s]));
  const loadById = new Map(loads.map((l) => [l.id, l]));
  const skip = new Set(exclude.map(String));
  const plan = [];
  for (const bill of bills) {
    if (bill.status !== 'IN_REVIEW' || bill.datesPending !== true) continue;
    const shipment = shipmentById.get(bill.shipmentId);
    if (!isCarShipping(shipment)) continue;
    const number = String(shipment.number ?? bill.shipmentNumber ?? '');
    const base = { bill, number, carrierName: bill.carrierName ?? null };
    if (skip.has(number)) { plan.push({ ...base, status: 'EXCLUDED' }); continue; }
    if ((bill.paidCents ?? 0) + (bill.creditedCents ?? 0) > 0) { plan.push({ ...base, status: 'HAS_MONEY' }); continue; }
    const dates = datesFor(shipment, loadById.get(bill.loadId) ?? null);
    if (!dates) { plan.push({ ...base, status: 'NO_DELIVERED_DATE' }); continue; }
    plan.push({ ...base, status: 'READY', ...dates });
  }
  return plan.sort((a, b) => a.number.localeCompare(b.number));
}

export async function applyOne({ doc, suffix, row, now = new Date() }) {
  assertWritableSuffix(suffix, 'car-shipping carrier bill dates');
  const nowIso = now.toISOString();
  const { bill } = row;
  try {
    await doc.send(new UpdateCommand({
      TableName: `CarrierBill-${suffix}`, Key: { id: bill.id },
      UpdateExpression: 'SET billDate = :bd, billMonth = :bm, dueAt = :due, termsDays = :terms, datesPending = :f, updatedAt = :at, updatedBy = :by, version = :v',
      ConditionExpression: '#st = :review AND datesPending = :t AND version = :was',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':bd': row.billDate, ':bm': row.billDate.slice(0, 7), ':due': row.dueAt, ':terms': TERMS_DAYS, ':f': false, ':t': true,
        ':at': nowIso, ':by': AUDIT_USER, ':review': 'IN_REVIEW', ':was': bill.version ?? 1, ':v': (bill.version ?? 1) + 1,
      },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: 1 };
    throw err;
  }
  await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: {
    id: randomUUID(), __typename: 'AuditLog', entityType: 'CarrierBill', entityId: bill.id, action: AUDIT_ACTION, user: AUDIT_USER,
    changes: JSON.stringify({
      from: { billDate: bill.billDate, dueAt: bill.dueAt, termsDays: bill.termsDays ?? null, datesPending: true },
      to: { billDate: row.billDate, dueAt: row.dueAt, termsDays: TERMS_DAYS, datesPending: false },
      shipmentNumber: row.number, rule: 'Car shipping: carrier paid 2 days after delivery',
    }),
    createdAt: nowIso, updatedAt: nowIso,
  } }));
  return { written: 1, lost: 0 };
}

export function buildReport({ plan, today }) {
  const L = [`# Car-shipping carrier bills: due 2 days after delivery (dry run ${today})`, ''];
  for (const r of plan) L.push(`- ${r.number} · ${r.carrierName ?? '—'}: ${r.status === 'READY' ? `bill ${r.billDate}, due ${r.dueAt}` : r.status}`);
  if (!plan.length) L.push('- none');
  L.push('');
  return L.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { report: { type: 'string' }, apply: { type: 'boolean' }, suffix: { type: 'string' }, exclude: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS }, allowPositionals: false });
  if (values.help) { console.log(`Usage: node scripts/awAutoCarrierBillBackfill.mjs [--report <file.md>] [--exclude PRO,PRO] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`); return; }
  const gate = await autoBillGate(values);
  let suffix;
  if (gate) suffix = gate.suffix; else { suffix = values.suffix ?? DEV_SUFFIX; if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate'); }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const bills = (await scanAll(doc, `CarrierBill-${suffix}`, ['id', 'shipmentId', 'shipmentNumber', 'loadId', 'status', 'datesPending', 'paidCents', 'creditedCents', 'billDate', 'dueAt', 'termsDays', 'version', 'carrierName'])).filter((b) => b.status === 'IN_REVIEW' && b.datesPending === true);
  const shipmentIds = new Set(bills.map((b) => b.shipmentId));
  const shipments = (await scanAll(doc, `Shipment-${suffix}`, ['id', 'number', 'status', 'revDivision', 'deliveredAt', 'statusChangedAt'])).filter((s) => shipmentIds.has(s.id));
  const loadIds = new Set(bills.map((b) => b.loadId));
  const loads = (await scanAll(doc, `Load-${suffix}`, ['id', 'shipmentId', 'deliveredAt', 'stops'])).filter((l) => loadIds.has(l.id));
  const exclude = (values.exclude ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const plan = planAutoBills({ bills, shipments, loads, exclude });
  const report = buildReport({ plan, today: localDate(new Date()) });
  const path = values.report ?? '/private/tmp/auto-carrier-bill-report.md';
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${report}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  console.log(report);
  const ready = plan.filter((r) => r.status === 'READY');
  if (!apply) { console.log(`DRY RUN: nothing written. ${ready.length} of ${plan.length} car-shipping bills would move to Aging.`); return; }
  const out = { written: 0, lost: 0 };
  for (const row of ready) { const x = await applyOne({ doc, suffix, row }); out.written += x.written; out.lost += x.lost; }
  console.log('APPLIED', JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
