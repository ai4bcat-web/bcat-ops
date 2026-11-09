#!/usr/bin/env node
/**
 * Released-status data fix: mark migrated DELIVERED shipments RELEASED the way the app itself models it.
 *
 * "Released" is ORDER-level (src/lib/shipmentLists.ts isReleasedToInvoicing): Order.readyToInvoiceAt / Order.invoiceId set,
 * or Order.arStatus beyond DOCS_NEEDED. Shipment.status stays DELIVERED; the Active list hides a released row and the All
 * list keeps it. SOURCE OF TRUTH is the Aljex export's Release Date (+ Invoice Date); where the export has no row for a
 * BCAT shipment: an Invoice exists, or an approved CarrierBill => released.
 *
 *   dry run (read-only):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awRelease.mjs --export ~/aljex-export/aljex-full-export-2026-11-07.csv \
 *       --target prod --i-mean-production [--report <csv>]
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awRelease --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-release node scripts/awRelease.mjs --export <csv> \
 *       --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Writes ONLY: Order (arStatus, arStatusChangedAt, readyToInvoiceAt, updatedBy, updatedAt, version) and one AuditLog row per
 * changed shipment (previous Order state inside). Never a money field; never ShipmentNotice / notification / message /
 * FactoringItem / Invoice / CarrierBill / ApPayment / ArPayment / LoadFinancials / LoadCharge. Only shipments currently
 * DELIVERED whose single Order is still DOCS_NEEDED with no invoice are written; the update is conditional on exactly that
 * state, so a re-run (or a concurrent real release) writes nothing twice. Progress is checkpointed to
 * ~/bcat-ops-backups/aw-release-<suffix>.checkpoint.json; --report writes the full list (mode 0600).
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { createCsvParser } from './lib/csvStream.mjs';
import { normalizePro } from '../src/lib/proNumber.ts';
import {
  CATEGORIES, RELEASE_FIELDS, RELEASE_USER, classifyShipment, csvCell, indexExport, isApprovedBill, releasePatch,
} from './lib/releaseClassify.mjs';

export const SCRIPT = 'awRelease';
export const AUDIT_ACTION = 'AW_RELEASE_BACKFILL';

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function releaseGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awRelease.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-release`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) {
      throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
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
      ...(projection ? { ProjectionExpression: projection.map((_, i) => `#p${i}`).join(','), ExpressionAttributeNames: Object.fromEntries(projection.map((p, i) => [`#p${i}`, p])) } : {}),
      ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

/** Stream the export into `{pro, release, invoice, status}` rows by header name. */
export async function readExport(path) {
  const rows = [];
  let cols = null;
  const parser = createCsvParser((r) => {
    if (!cols) {
      const at = (name) => r.findIndex((h) => h.trim().toLowerCase() === name);
      cols = { pro: at('pro #'), release: at('release date'), invoice: at('invoice date'), status: at('dispatch status') };
      for (const [k, v] of Object.entries(cols)) if (v < 0) throw new Error(`export column missing: ${k}`);
      return;
    }
    rows.push({ pro: r[cols.pro] ?? '', release: r[cols.release] ?? '', invoice: r[cols.invoice] ?? '', status: r[cols.status] ?? '' });
  });
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) parser.write(chunk);
  parser.end();
  return rows;
}

/**
 * Pure: classify every shipment.
 * @returns {{results: Array<{shipment: object, keys: string[], c: ReturnType<typeof classifyShipment>}>, counts: Record<string, number>, dupes: number}}
 */
export function planRelease({ shipments, orders, loads, claims, invoices, bills, exportRows }) {
  const { byPro, dupes } = indexExport(exportRows);
  const group = (rows, f) => {
    const m = new Map();
    for (const r of rows) { const k = f(r); if (k) (m.get(k) ?? m.set(k, []).get(k)).push(r); }
    return m;
  };
  const ordersByShip = group(orders, (o) => o.shipmentId);
  const loadsByShip = group(loads, (l) => l.shipmentId);
  const claimsByShip = group(claims, (c) => c.shipmentId);
  const invoiceShips = new Set(invoices.flatMap((i) => [i.shipmentId, i.orderId]).filter(Boolean));
  const billShips = new Set(bills.filter(isApprovedBill).map((b) => b.shipmentId).filter(Boolean));
  const counts = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
  const results = [];
  for (const shipment of shipments) {
    const shipOrders = ordersByShip.get(shipment.id) ?? [];
    const keys = [...new Set([
      normalizePro(shipment.number),
      ...(loadsByShip.get(shipment.id) ?? []).map((l) => normalizePro(l.aljexId)),
      ...(claimsByShip.get(shipment.id) ?? []).map((c) => normalizePro(c.id)),
    ].filter(Boolean))];
    const c = classifyShipment({
      shipment,
      orders: shipOrders,
      keys,
      exportByPro: byPro,
      hasInvoice: invoiceShips.has(shipment.id) || shipOrders.some((o) => o.invoiceId || invoiceShips.has(o.id)),
      hasApprovedBill: billShips.has(shipment.id),
    });
    counts[c.category] += 1;
    results.push({ shipment, keys, c });
  }
  return { results, counts, dupes };
}

export function reportCsv(results) {
  const head = ['PRO', 'current status', 'category', 'reason', 'release date', 'invoice date'];
  const lines = [head.join(',')];
  for (const { shipment, c } of results) {
    lines.push([shipment.number, shipment.status, c.category, c.reason, c.releaseDate, c.invoiceDate].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function histogram(rows, f) {
  const out = {};
  for (const r of rows) { const k = String(f(r)); out[k] = (out[k] ?? 0) + 1; }
  return out;
}

/** One conditional Order update + one AuditLog row. Returns 'written' | 'changed' (condition failed: state moved). */
export async function releaseOne({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'Order release');
  const nowIso = now.toISOString();
  const { shipment, c } = entry;
  const order = c.order;
  const patch = releasePatch(c, order, nowIso);
  const names = Object.keys(patch);
  if (names.some((n) => !RELEASE_FIELDS.includes(n)) || names.length !== RELEASE_FIELDS.length) throw new Error('release patch drifted from RELEASE_FIELDS');
  const values = Object.fromEntries(names.map((n) => [`:${n}`, patch[n]]));
  const hasVersion = typeof order.version === 'number';
  try {
    await doc.send(new UpdateCommand({
      TableName: `Order-${suffix}`,
      Key: { id: order.id },
      UpdateExpression: `SET ${names.map((n) => `#${n} = :${n}`).join(', ')}`,
      ConditionExpression: [
        'attribute_exists(id)',
        'arStatus = :prev',
        '(attribute_not_exists(invoiceId) OR attribute_type(invoiceId, :nul))',
        '(attribute_not_exists(readyToInvoiceAt) OR attribute_type(readyToInvoiceAt, :nul))',
        hasVersion ? '#version = :prevVersion' : 'attribute_not_exists(#version)',
      ].join(' AND '),
      ExpressionAttributeNames: Object.fromEntries(names.map((n) => [`#${n}`, n])),
      ExpressionAttributeValues: { ...values, ':prev': 'DOCS_NEEDED', ':nul': 'NULL', ...(hasVersion ? { ':prevVersion': order.version } : {}) },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return 'changed';
    throw err;
  }
  await doc.send(new PutCommand({
    TableName: `AuditLog-${suffix}`,
    Item: {
      id: randomUUID(),
      __typename: 'AuditLog',
      entityType: 'SHIPMENT',
      entityId: shipment.id,
      action: AUDIT_ACTION,
      user: RELEASE_USER,
      changes: JSON.stringify({
        orderId: order.id,
        shipmentStatus: shipment.status,
        source: c.source,
        reason: c.reason,
        aljexReleaseDate: c.releaseDate,
        aljexInvoiceDate: c.invoiceDate,
        previous: { arStatus: order.arStatus ?? null, arStatusChangedAt: order.arStatusChangedAt ?? null, readyToInvoiceAt: order.readyToInvoiceAt ?? null, version: order.version ?? null },
        next: { arStatus: patch.arStatus, readyToInvoiceAt: patch.readyToInvoiceAt },
      }),
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  }));
  return 'written';
}

const checkpointPath = (suffix) => join(homedir(), 'bcat-ops-backups', `aw-release-${suffix}.checkpoint.json`);
const loadCheckpoint = (path) => (existsSync(path) ? new Set(JSON.parse(readFileSync(path, 'utf8')).done ?? []) : new Set());
const saveCheckpoint = (path, done) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }), { mode: 0o600 });
};

async function main() {
  const { values } = parseArgs({
    options: { export: { type: 'string' }, report: { type: 'string' }, apply: { type: 'boolean' }, limit: { type: 'string' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS },
    allowPositionals: false,
  });
  if (values.help || !values.export) {
    console.log(`Usage: node scripts/awRelease.mjs --export <aljex-export.csv> [--report <csv>] [--limit N] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`);
    return;
  }
  const gate = await releaseGate(values);
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const T = (m) => `${m}-${suffix}`;

  const [exportRows, shipments, orders, loads, claims, invoices, bills] = await Promise.all([
    readExport(values.export),
    scanAll(doc, T('Shipment'), ['id', 'number', 'status', 'voidedAt', 'deletedAt']),
    scanAll(doc, T('Order'), ['id', 'shipmentId', 'arStatus', 'arStatusChangedAt', 'readyToInvoiceAt', 'invoiceId', 'version']),
    scanAll(doc, T('Load'), ['id', 'shipmentId', 'aljexId']),
    scanAll(doc, T('ProClaim'), ['id', 'shipmentId']),
    scanAll(doc, T('Invoice'), ['id', 'shipmentId', 'orderId']),
    scanAll(doc, T('CarrierBill'), ['id', 'shipmentId', 'status', 'approvedAt']),
  ]);
  const { results, counts, dupes } = planRelease({ shipments, orders, loads, claims, invoices, bills, exportRows });
  const toRelease = results.filter((r) => r.c.category === 'TO_RELEASE');

  console.log(`export rows ${exportRows.length} (duplicate PRO rows merged ${dupes}); shipments ${shipments.length}`);
  console.log('shipment status histogram', JSON.stringify(histogram(shipments, (s) => s.status)));
  console.log('categories', JSON.stringify(counts));
  console.log('TO_RELEASE by source', JSON.stringify(histogram(toRelease, (r) => r.c.source)));
  console.log('ALREADY_RELEASED by source', JSON.stringify(histogram(results.filter((r) => r.c.category === 'ALREADY_RELEASED'), (r) => r.c.source)));
  console.log('REVIEW by reason', JSON.stringify(histogram(results.filter((r) => r.c.category === 'REVIEW'), (r) => r.c.reason)));

  if (values.report) {
    mkdirSync(dirname(values.report), { recursive: true });
    writeFileSync(values.report, reportCsv(results), { mode: 0o600 });
    chmodSync(values.report, 0o600);
    console.log(`report written: ${results.length} rows (mode 0600)`);
  }

  if (!apply) {
    console.log(`DRY RUN: nothing written. ${toRelease.length} order(s) would be released.`);
    return;
  }
  const limit = values.limit ? Number(values.limit) : Infinity;
  const cpPath = checkpointPath(suffix);
  const done = loadCheckpoint(cpPath);
  const out = { written: 0, changed: 0, skippedDone: 0 };
  let n = 0;
  for (const entry of toRelease) {
    if (n >= limit) break;
    if (done.has(entry.c.order.id)) { out.skippedDone += 1; continue; }
    n += 1;
    const r = await releaseOne({ doc, suffix, entry });
    out[r] += 1;
    done.add(entry.c.order.id);
    if (n % 10 === 0) saveCheckpoint(cpPath, done);
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
