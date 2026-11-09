#!/usr/bin/env node
/**
 * Tie-out of the Brokerage dashboard (src/lib/brokerageRevenue.ts over the DashboardRollup month payload) to the raw
 * rows. READ-ONLY (scans / queries only; counts and dollar totals on stdout, no names, no PRO numbers, no ids).
 *
 *   BCAT_ALLOW_PROD=$(date +%F) node scripts/awBrokerageCheck.mjs --target prod --i-mean-production [--months 2026-10,2026-09]
 *
 * For each month it prints three independent figures:
 *   A  what the dashboard code path shows: `computeMonth` (the rollup Lambda's own function) over the month's lane
 *      samples and shipments, then `monthRows` / `repRows` (rep rows are checked to add up to the month row);
 *   B  from the raw rows: every Brokerage Load with a LoadFinancials row, re-run through `laneSampleFor` (the function
 *      that turns Load + LoadFinancials + LoadCarrier + Shipment into a sample), so a missing or stale sample shows;
 *   C  the invoices / carrier bills of the same shipments (Invoice.totalCents by invoiceMonth, CarrierBill.grossCents
 *      by billMonth): the accounting view, with the reasons it differs from A (delivered-but-uninvoiced, invoiced in
 *      another month, carried-over Aljex invoices, voided).
 * A summary (counts and dollars only) is also written, mode 0600, to ~/aljex-export/reports/brokerage-check-<date>.json.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { build } from 'esbuild';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, isProductionSuffix, localDate, requireProd, tableName } from './lib/prodGate.mjs';

export const SCRIPT = 'awBrokerageCheck';
const MODELS = ['Shipment', 'Load', 'LoadFinancials', 'LoadCarrier', 'LaneRateSample', 'Order', 'Customer', 'Invoice', 'CarrierBill', 'OwnershipDivision'];
const root = resolve(fileURLToPath(import.meta.url), '..', '..');

/** The two pure libs the dashboard is built from, bundled so this script runs the very same code. */
async function loadLibs() {
  const entry = `export * from './src/lib/dashboardRollup.ts'; export * from './src/lib/brokerageRevenue.ts'; export { laneSampleFor } from './src/lib/laneKey.ts';`;
  const out = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    alias: { '@': join(root, 'src') },
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

async function scan(doc, table, fields, filter) {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: table,
      ProjectionExpression: fields.map((_, i) => `#p${i}`).join(','),
      ExpressionAttributeNames: Object.fromEntries(fields.map((f, i) => [`#p${i}`, f])),
      ...(filter ?? {}),
      ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

async function queryIndex(doc, table, index, keyName, keyValue, fields) {
  const items = [];
  let key;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: table, IndexName: index,
      KeyConditionExpression: '#k = :v',
      ProjectionExpression: fields.map((_, i) => `#p${i}`).join(','),
      ExpressionAttributeNames: { '#k': keyName, ...Object.fromEntries(fields.map((f, i) => [`#p${i}`, f])) },
      ExpressionAttributeValues: { ':v': keyValue },
      ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

const usd = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
const readStops = (load) => {
  let v = load.stops;
  for (let i = 0; i < 4 && typeof v === 'string'; i++) { try { v = JSON.parse(v); } catch { break; } }
  return Array.isArray(v) ? v.filter((s) => s && typeof s === 'object').sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)) : [];
};

/** Last two full UTC months relative to today. */
function defaultMonths(now = new Date()) {
  const month = (back) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); return d.toISOString().slice(0, 7); };
  return [month(1), month(2)];
}

async function main() {
  const { values } = parseArgs({
    options: { months: { type: 'string' }, suffix: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS },
  });
  if (values.help) {
    console.log(`Usage: node scripts/awBrokerageCheck.mjs [--months YYYY-MM,YYYY-MM] [--suffix <dev suffix>] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nRead-only.`);
    return;
  }
  const gate = await requireProd({ script: SCRIPT, values, tables: MODELS, readOnly: true });
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const months = (values.months ? values.months.split(',') : defaultMonths()).map((m) => m.trim());
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const T = (m) => tableName(m, suffix);
  const lib = await loadLibs();

  const divisions = (await scan(doc, T('OwnershipDivision'), ['id', 'code', 'parentId'])).map((d) => ({ code: d.code ?? d.id, parentId: d.parentId ?? null }));
  const tree = divisions.length > 0 ? divisions : [{ code: 'BROKERAGE', parentId: null }];
  const shipments = await scan(doc, T('Shipment'), ['id', 'status', 'pickupAppt', 'pickupMonth', 'revDivision', 'revSubdivision', 'voidedAt', 'deletedAt', 'salesRepId', 'salesRepCode', 'customerId']);
  const shipById = new Map(shipments.map((s) => [s.id, s]));
  const brokerage = new Set(shipments.filter((s) => lib.isBrokerageScope(lib.scopeKey(s.revDivision, s.revSubdivision), tree)).map((s) => s.id));
  console.log(`shipments ${shipments.length}; brokerage-tagged ${brokerage.size}; voided ${shipments.filter((s) => s.voidedAt).length}`);
  const byDivision = {};
  for (const s of shipments) { const k = lib.scopeKey(s.revDivision, s.revSubdivision); byDivision[k] = (byDivision[k] ?? 0) + 1; }
  console.log(`shipments by revDivision|revSubdivision: ${JSON.stringify(byDivision)}`);

  const loads = (await scan(doc, T('Load'), ['id', 'shipmentId', 'orderId', 'status', 'deliveredAt', 'stops', 'voidedAt', 'revDivision', 'salesRepId', 'miles', 'equipmentType', 'carrierName', 'customer', 'divisionKey', 'carrierRepId']))
    .filter((l) => brokerage.has(l.shipmentId) || (l.revDivision && lib.isBrokerageScope(lib.scopeKey(l.revDivision, null), tree)));
  const loadIds = new Set(loads.map((l) => l.id));
  const financials = new Map((await scan(doc, T('LoadFinancials'), ['id', 'loadId', 'customerRateCents', 'revenueCents', 'carrierRateCents', 'costCents', 'profitCents', 'marginBps']))
    .filter((f) => loadIds.has(f.loadId ?? f.id)).map((f) => [f.loadId ?? f.id, f]));
  const legs = new Map();
  for (const lc of await scan(doc, T('LoadCarrier'), ['id', 'loadId', 'status', 'kind', 'carrierId', 'carrierName', 'carrierRepId'])) {
    if (!loadIds.has(lc.loadId)) continue;
    legs.set(lc.loadId, [...(legs.get(lc.loadId) ?? []), lc]);
  }
  const orders = new Map((await scan(doc, T('Order'), ['id', 'shipmentId', 'customerId', 'customerName', 'invoicedAt', 'invoiceId', 'customerRepId'])).map((o) => [o.id, o]));
  const invoices = (await scan(doc, T('Invoice'), ['id', 'shipmentId', 'orderId', 'status', 'invoiceMonth', 'totalCents', 'voidedAt', 'aljexDueDate'])).filter((i) => brokerage.has(i.shipmentId));
  const bills = (await scan(doc, T('CarrierBill'), ['id', 'shipmentId', 'loadId', 'status', 'billMonth', 'grossCents', 'netCents', 'voidedAt'])).filter((b) => brokerage.has(b.shipmentId) || loadIds.has(b.loadId));
  console.log(`brokerage loads ${loads.length}; with LoadFinancials ${financials.size}; invoices ${invoices.length}; carrier bills ${bills.length}`);

  const report = { generatedAt: new Date().toISOString(), suffix: isProductionSuffix(suffix) ? 'production' : 'dev', months: {} };
  for (const month of months) {
    // A. the dashboard code path over the month's samples.
    const samples = await queryIndex(doc, T('LaneRateSample'), 'laneRateSamplesBySampleMonthAndDate', 'sampleMonth', month,
      ['id', 'shipmentId', 'loadId', 'date', 'excluded', 'revenueCents', 'costCents', 'profitCents', 'revDivision', 'revSubdivision', 'podReceivedAt', 'salesRepId']);
    const src = {
      shipments: async (m) => shipments.filter((s) => !s.voidedAt && s.pickupMonth === m),
      loadsOf: async () => [],
      deliveredOrders: async () => [],
      samples: async () => samples,
      shipmentsByIds: async (ids) => ids.map((id) => shipById.get(id)).filter(Boolean),
    };
    const payload = await lib.computeMonth(src, month);
    const row = { id: `M:${month}`, schemaVersion: 1, computedAt: new Date().toISOString(), payload };
    const [a] = lib.monthRows([row], [month], tree);
    const reps = lib.repRows([row], [month], tree, { byId: new Map() });
    const tie = lib.tieOut([a], reps);

    // B. raw Load + LoadFinancials re-run through laneSampleFor (what the sample writer would produce today).
    let b = { loads: 0, revenueCents: 0, expenseCents: 0 };
    const reasons = { noFinancials: 0, notDelivered: 0, voided: 0, excluded: 0, otherMonth: 0, noSampleRow: 0, sampleDiffers: 0 };
    const sampleByLoad = new Map(samples.map((s) => [s.loadId, s]));
    const projected = [];
    for (const load of loads) {
      const ship = shipById.get(load.shipmentId);
      if (!ship || ship.voidedAt || load.voidedAt) { if (ship?.voidedAt || load.voidedAt) reasons.voided += 1; continue; }
      const fin = financials.get(load.id);
      const mine = legs.get(load.id) ?? [];
      const leg = mine.find((r) => r.status === 'ACTIVE') ?? mine.find((r) => r.status === 'TONU') ?? null;
      const order = orders.get(load.orderId) ?? null;
      const s = lib.laneSampleFor({ load: { ...load, stops: readStops(load) }, financials: fin ?? null, order, loadCarrier: leg, shipment: ship }, new Date().toISOString());
      if (!fin) { reasons.noFinancials += 1; continue; }
      if (!s) { reasons.notDelivered += 1; continue; }
      if (s.sampleMonth === month) projected.push({ ...s, excluded: s.excluded || mine.filter((r) => r.status === 'ACTIVE').length >= 2, salesRepId: load.salesRepId ?? ship.salesRepId ?? null, revDivision: load.revDivision ?? ship.revDivision ?? null, revSubdivision: load.revSubdivision ?? ship.revSubdivision ?? null });
      if (s.sampleMonth !== month) { if (sampleByLoad.get(load.id)) reasons.otherMonth += 1; continue; }
      const excluded = s.excluded || mine.filter((r) => r.status === 'ACTIVE').length >= 2;
      if (excluded) { reasons.excluded += 1; continue; }
      b.loads += 1; b.revenueCents += s.revenueCents ?? 0; b.expenseCents += s.costCents ?? 0;
      const stored = sampleByLoad.get(load.id);
      if (!stored) reasons.noSampleRow += 1;
      else if ((stored.revenueCents ?? 0) !== (s.revenueCents ?? 0) || (stored.costCents ?? 0) !== (s.costCents ?? 0)) reasons.sampleDiffers += 1;
    }

    // A'. the same code path over the samples the writer WOULD produce from the raw rows (what the rollup holds once
    // the lane samples are backfilled): must equal B exactly, and its rep rows must add up to its month row.
    const projPayload = await lib.computeMonth({ ...src, samples: async () => projected }, month);
    const projRow = { id: `M:${month}`, schemaVersion: 1, computedAt: new Date().toISOString(), payload: projPayload };
    const [ap] = lib.monthRows([projRow], [month], tree);
    const projReps = lib.repRows([projRow], [month], tree, { byId: new Map() });
    const projTie = lib.tieOut([ap], projReps);
    const noRep = projReps.find((r) => r.repKey === '');

    // C. accounting view.
    const inv = invoices.filter((i) => i.invoiceMonth === month && i.status !== 'VOID' && !i.voidedAt);
    const bil = bills.filter((x) => x.billMonth === month && x.status !== 'VOID' && !x.voidedAt);
    const shipsDelivered = new Set(samples.filter((s) => !s.excluded && s.shipmentId && brokerage.has(s.shipmentId)).map((s) => s.shipmentId));
    const invoicedShips = new Set(invoices.filter((i) => i.status !== 'VOID' && !i.voidedAt).map((i) => i.shipmentId));
    const uninvoiced = [...shipsDelivered].filter((id) => !invoicedShips.has(id));
    const uninvoicedRev = sum(samples.filter((s) => !s.excluded && uninvoiced.includes(s.shipmentId)), (s) => s.revenueCents);
    const carried = inv.filter((i) => i.aljexDueDate);

    const figures = {
      A_dashboard: { loads: a.loads, revenue: usd(a.revenueCents), expense: usd(a.expenseCents), profit: usd(a.profitCents), profitPct: a.marginBps == null ? '—' : `${(a.marginBps / 100).toFixed(1)}%`, repRowsTieToMonth: tie.ok, repRows: reps.length },
      Aprime_codePathOverRawSamples: { loads: ap.loads, revenue: usd(ap.revenueCents), expense: usd(ap.expenseCents), profit: usd(ap.profitCents), profitPct: ap.marginBps == null ? '—' : `${(ap.marginBps / 100).toFixed(1)}%`, equalsB: ap.loads === b.loads && ap.revenueCents === b.revenueCents && ap.expenseCents === b.expenseCents, repRowsTieToMonth: projTie.ok, repRowCount: projReps.length, noSalesRep: noRep ? { loads: noRep.loads, revenue: usd(noRep.revenueCents) } : null },
      B_rawLoadFinancials: { loads: b.loads, revenue: usd(b.revenueCents), expense: usd(b.expenseCents), revenueDiff: usd(b.revenueCents - a.revenueCents), expenseDiff: usd(b.expenseCents - a.expenseCents), loadsDiff: b.loads - a.loads, reasons },
      C_invoicesAndBills: { invoices: inv.length, invoiceTotal: usd(sum(inv, (i) => i.totalCents)), carrierBills: bil.length, billGross: usd(sum(bil, (x) => x.grossCents)), carriedOverInvoices: carried.length, deliveredNotInvoicedShipments: uninvoiced.length, deliveredNotInvoicedRevenue: usd(uninvoicedRev) },
      A_minus_C: { revenue: usd(a.revenueCents - sum(inv, (i) => i.totalCents)), expense: usd(a.expenseCents - sum(bil, (x) => x.grossCents)) },
      rawCents: { A: a, B: b },
    };
    report.months[month] = figures;
    console.log(`\n=== ${month}`);
    console.log(JSON.stringify(figures, null, 2));
  }

  const dir = values.out ?? join(homedir(), 'aljex-export', 'reports');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `brokerage-check-${localDate(new Date())}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`\nsummary written (0600): ${file}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
}
