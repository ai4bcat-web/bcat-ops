#!/usr/bin/env node
/**
 * Render Ryne's two reference invoices from production data, for a side-by-side look against
 * ~/aljex-export/invoice-examples/{bcat-1,ivan-1}.png.
 *
 * READ-ONLY. It scans/queries Shipment, Order, Load, LoadCarrier, Location, LoadCharge, Invoice, Customer and
 * TmsSettings and never writes a table, an e-mail or an object. When the PRO has an issued (non-void)
 * invoice, the PDF is built from that snapshot (what the app would re-render); when it has none, the
 * invoice is PREVIEWED from the shipment's customer charges, dated today on the customer's terms,
 * exactly as `generateInvoice`'s dry run would, and the output name says so.
 *
 *   BCAT_ALLOW_PROD=$(date +%F) node scripts/awInvoiceSamples.mjs --target prod --i-mean-production \
 *     [--pro 14742:bcat --pro 14905:ivan] [--out ~/aljex-export/reports/pdf-samples]
 *
 * Output (dir 0700, files 0600): invoice-14742-bcat.pdf, invoice-14905-ivan.pdf (+ `-preview` in the
 * name when no invoice row exists) and a PNG render of each (pdftoppm, if installed).
 * PII: stdout carries PRO numbers, counts and file paths only; customer data lives in the files.
 */
import { chmodSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { register } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, isProductionSuffix, localDate, requireProd, tableName } from './lib/prodGate.mjs';

register('./lib/tsExtensionlessHooks.mjs', import.meta.url);
const { buildInvoicePdf } = await import('../src/lib/invoicePdf.ts');
const { invoiceData, invoiceLinesFor, invoiceStopLocationIds, invoiceTermsDays, dueDateFor } = await import('../src/lib/invoiceBuild.ts');

export const SCRIPT = 'awInvoiceSamples';
const MODELS = ['Shipment', 'Order', 'Load', 'LoadCarrier', 'Location', 'LoadCharge', 'Invoice', 'Customer', 'TmsSettings'];
const DEFAULT_PROS = ['14742:bcat', '14905:ivan'];
const SETTINGS_ID = 'default';

async function scanWhere(doc, table, filter, names, values) {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: table, FilterExpression: filter, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

async function byShipment(doc, table, index, shipmentId) {
  const out = [];
  let key;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: table, IndexName: index, KeyConditionExpression: 'shipmentId = :s', ExpressionAttributeValues: { ':s': shipmentId }, ExclusiveStartKey: key,
    }));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return out;
}

/** Everything the invoice needs for one shipment number, or null when no such shipment is in the table. */
async function readShipment(doc, T, pro) {
  const found = await scanWhere(doc, T('Shipment'), '#n = :p OR contains(searchKey, :lp)', { '#n': 'number' }, { ':p': pro, ':lp': pro.toLowerCase() });
  const exact = found.filter((s) => String(s.number) === pro);
  const shipment = exact[0] ?? found[0];
  if (!shipment) return null;
  const [orders, loads, loadCarriers, charges] = await Promise.all([
    byShipment(doc, T('Order'), 'ordersByShipmentId', shipment.id),
    byShipment(doc, T('Load'), 'loadsByShipmentId', shipment.id),
    byShipment(doc, T('LoadCarrier'), 'loadCarriersByShipmentId', shipment.id),
    byShipment(doc, T('LoadCharge'), 'loadChargesByShipmentIdAndSortOrder', shipment.id),
  ]);
  const order = orders[0] ?? null;
  const customer = order?.customerId ? (await doc.send(new GetCommand({ TableName: T('Customer'), Key: { id: order.customerId } }))).Item ?? null : null;
  const locations = (await Promise.all(invoiceStopLocationIds(loads).map(async (id) => (await doc.send(new GetCommand({ TableName: T('Location'), Key: { id } }))).Item))).filter(Boolean);
  const invoices = (await scanWhere(doc, T('Invoice'), 'shipmentId = :s', undefined, { ':s': shipment.id })).filter((i) => i.status !== 'VOID');
  return { shipment, orders, order, loads, loadCarriers, locations, charges, customer, invoices, matches: found.length };
}

function previewInvoice(ctx, settings, today) {
  const { order, customer, charges } = ctx;
  const billTo = customer?.billToParties?.find((p) => p.id === order.billToId) ?? null;
  const termsDays = invoiceTermsDays(customer, billTo, settings);
  const { lines, subtotalCents } = invoiceLinesFor(charges, order.id);
  return {
    number: `PREVIEW-${ctx.shipment.number}`,
    orderId: order.id,
    invoiceDate: today,
    dueAt: dueDateFor(today, termsDays),
    termsDays,
    termsText: null,
    shipmentNumber: ctx.shipment.number,
    customerName: customer?.name ?? order.customerName ?? null,
    billTo: billTo
      ? { name: billTo.name, address: billTo.address ?? null, email: billTo.email ?? null }
      : { name: customer?.name ?? order.customerName ?? '', address: customer?.billingAddress ?? null, email: customer?.billingEmail ?? null },
    remitTo: null,
    lines,
    references: (order.references ?? []).filter((r) => r.visibility === 'CUSTOMER' || r.visibility === 'ALL'),
    subtotalCents,
    totalCents: subtotalCents,
    factored: customer?.factored === true,
  };
}

async function main() {
  const { values } = parseArgs({
    options: { pro: { type: 'string', multiple: true }, out: { type: 'string' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS },
  });
  if (values.help) {
    console.log(`Usage: node scripts/awInvoiceSamples.mjs [--pro <PRO>:<label> ...] [--out <dir>] [--suffix <dev suffix>] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nRead-only.`);
    return;
  }
  const gate = await requireProd({ script: SCRIPT, values, tables: MODELS, readOnly: true });
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const T = (m) => tableName(m, suffix);
  const out = values.out ?? join(homedir(), 'aljex-export', 'reports', 'pdf-samples');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  const today = localDate(new Date());
  const settings = (await doc.send(new GetCommand({ TableName: T('TmsSettings'), Key: { id: SETTINGS_ID } }))).Item ?? { id: SETTINGS_ID };

  for (const spec of values.pro?.length ? values.pro : DEFAULT_PROS) {
    const [pro, label = 'sample'] = spec.split(':');
    const ctx = await readShipment(doc, T, pro);
    if (!ctx) { console.log(`PRO ${pro}: no shipment with that number`); continue; }
    if (!ctx.order) { console.log(`PRO ${pro}: shipment has no order`); continue; }
    const issued = ctx.invoices.find((i) => i.orderId === ctx.order.id) ?? null;
    const snapshot = issued ?? previewInvoice(ctx, settings, today);
    const input = invoiceData({
      invoice: snapshot,
      bundle: { shipment: ctx.shipment, loads: ctx.loads, orders: ctx.orders, loadCarriers: ctx.loadCarriers, locations: ctx.locations },
      customer: ctx.customer,
      division: null,
      settings,
    });
    const bytes = await buildInvoicePdf(input);
    const base = `invoice-${pro}-${label}${issued ? '' : '-preview'}`;
    const pdfPath = join(out, `${base}.pdf`);
    writeFileSync(pdfPath, bytes, { mode: 0o600 });
    chmodSync(pdfPath, 0o600);
    let png = 'no render (pdftoppm missing)';
    try {
      execFileSync('pdftoppm', ['-r', '100', '-png', pdfPath, join(out, base)]);
      for (const f of readdirSync(out).filter((n) => n.startsWith(`${base}-`) && n.endsWith('.png'))) chmodSync(join(out, f), 0o600);
      png = `${base}-*.png`;
    } catch { /* pdftoppm is optional */ }
    console.log(`PRO ${pro}: shipment matches ${ctx.matches}, invoice ${issued ? 'ISSUED (snapshot)' : 'none (PREVIEW from charges)'}, division ${ctx.shipment.revDivision ?? '-'}/${ctx.shipment.revSubdivision ?? '-'}, lines ${snapshot.lines?.length ?? 0}, stops ${input.stops.length}, account number ${input.accountNumber ? 'yes' : 'no'} -> ${pdfPath} (${png})`);
  }
}

main().catch((err) => { console.error(err.message ?? err); process.exitCode = 1; });
