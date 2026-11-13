#!/usr/bin/env node
/**
 * Renumber the counter-numbered invoices created since cutover (INV-000001 …) to the shipment's PRO #
 * (Ryne 2026-11-12: "Invoice numbers should match our PRO#"). Dry by default, prod-gated apply.
 *
 * The Invoice id IS its number, so a renumber writes a NEW Invoice row (id = number = PRO, or PRO-2 … when
 * that number is already taken, e.g. by imported Aljex history), points the Order at it, moves the factoring
 * row's invoiceId and the shipment's `inv:<id>` document, and leaves the old row VOID with
 * "Renumbered to <PRO>" (nothing is deleted). The PDF object in S3 is reused as is.
 *
 * REFUSES (writes nothing for that invoice) when it is already sent, has money applied, is factored and
 * submitted to OTR, has a commission row, belongs to a multi-order shipment, or has no PRO.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awInvoiceRenumber.mjs --target prod --i-mean-production
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awInvoiceRenumber --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-renumber node scripts/awInvoiceRenumber.mjs --target prod --i-mean-production \
 *               --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Undo: restore Invoice / Order / FactoringItem / ShipmentDocument from the backup (AuditLog rows name every write).
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { scanAll } from './awCustomerEmail.mjs';

export const SCRIPT = 'awInvoiceRenumber';
export const AUDIT_ACTION = 'AW_INVOICE_RENUMBER';
export const AUDIT_USER = 'system:awInvoiceRenumber';

export async function renumberGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awInvoiceRenumber.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-renumber`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
  }
  return gate;
}

const appsOf = (p) => {
  let apps = p.applications;
  if (typeof apps === 'string') { try { apps = JSON.parse(apps); } catch { apps = []; } }
  return Array.isArray(apps) ? apps : [];
};

/** One verdict per counter-numbered invoice. Pure, so it is tested. */
export function planRenumber({ invoices, orders, payments, commissions, factoring }) {
  const taken = new Set(invoices.map((i) => String(i.id)));
  const plan = [];
  for (const inv of invoices.filter((i) => /^INV-\d+$/.test(String(i.id)))) {
    const why = [];
    const pro = String(inv.shipmentNumber ?? '').trim();
    if (!pro) why.push('no PRO on the invoice');
    if (inv.status === 'VOID') continue;
    if (inv.sentAt || inv.markedSentAt || Number(inv.sentCount ?? 0) > 0) why.push('already sent to the customer');
    if (Number(inv.paidCents ?? 0) > 0 || Number(inv.writtenOffCents ?? 0) > 0) why.push('money applied');
    if (payments.some((p) => p.invoiceId === inv.id || appsOf(p).some((a) => a?.invoiceId === inv.id))) why.push('a payment row names it');
    if (commissions.some((c) => c.invoiceId === inv.id)) why.push('a commission row names it');
    const item = inv.factoringItemId ? factoring.find((f) => f.id === inv.factoringItemId) : null;
    if (item?.otrInvoiceId) why.push('factored and already submitted to OTR');
    const shipmentOrders = orders.filter((o) => o.shipmentId === inv.shipmentId);
    if (shipmentOrders.length > 1) why.push('shipment has more than one order');
    const order = orders.find((o) => o.id === inv.orderId);
    if (!order) why.push('order not found');
    if (why.length) { plan.push({ invoice: inv, status: 'REFUSED', why }); continue; }
    let target = pro;
    for (let n = 2; taken.has(target) && n < 100; n++) target = `${pro}-${n}`;
    taken.add(target);
    plan.push({ invoice: inv, order, factoringItem: item ?? null, target, status: 'READY' });
  }
  return plan;
}

export async function applyOne({ doc, suffix, row, now = new Date() }) {
  assertWritableSuffix(suffix, 'invoice renumber');
  const at = now.toISOString();
  const oldId = String(row.invoice.id);
  const target = row.target;
  const audit = (entityType, entityId, changes) => doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType, entityId, action: AUDIT_ACTION, user: AUDIT_USER, changes: JSON.stringify(changes), createdAt: at, updatedAt: at } }));
  // pdfKey is carried over on purpose: it still names the OLD number, so tms-finance-actions sees the
  // PDF as stale (invoicePdfIsStale) and re-renders it with the new number before any preview or send.
  try {
    await doc.send(new PutCommand({
      TableName: `Invoice-${suffix}`,
      Item: { ...row.invoice, id: target, number: target, note: row.invoice.note ?? null, version: Number(row.invoice.version ?? 1) + 1, updatedAt: at, updatedBy: AUDIT_USER },
      ConditionExpression: 'attribute_not_exists(id)',
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: 1 };
    throw err;
  }
  await doc.send(new UpdateCommand({
    TableName: `Order-${suffix}`, Key: { id: row.order.id },
    UpdateExpression: 'SET invoiceId = :n, invoiceNumber = :n, updatedAt = :at',
    ConditionExpression: 'invoiceId = :old',
    ExpressionAttributeValues: { ':n': target, ':old': oldId, ':at': at },
  }));
  if (row.factoringItem) {
    await doc.send(new UpdateCommand({
      TableName: `FactoringItem-${suffix}`, Key: { id: row.factoringItem.id },
      UpdateExpression: 'SET invoiceId = :n, updatedAt = :at', ConditionExpression: 'invoiceId = :old',
      ExpressionAttributeValues: { ':n': target, ':old': oldId, ':at': at },
    }));
  }
  const docRow = (await doc.send(new GetCommand({ TableName: `ShipmentDocument-${suffix}`, Key: { id: `inv:${oldId}` } }))).Item;
  if (docRow) {
    await doc.send(new PutCommand({ TableName: `ShipmentDocument-${suffix}`, Item: { ...docRow, id: `inv:${target}`, invoiceId: target, name: String(docRow.name ?? '').replace(oldId, target), updatedAt: at }, ConditionExpression: 'attribute_not_exists(id)' })).catch((e) => { if (e?.name !== 'ConditionalCheckFailedException') throw e; });
    await doc.send(new UpdateCommand({ TableName: `ShipmentDocument-${suffix}`, Key: { id: `inv:${oldId}` }, UpdateExpression: 'SET #st = :v, updatedAt = :at', ExpressionAttributeNames: { '#st': 'status' }, ExpressionAttributeValues: { ':v': 'VOID', ':at': at } }));
  }
  await doc.send(new UpdateCommand({
    TableName: `Invoice-${suffix}`, Key: { id: oldId },
    UpdateExpression: 'SET #st = :void, voidReason = :why, voidedAt = :at, voidedBy = :by, updatedAt = :at REMOVE arOpen',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':void': 'VOID', ':why': `Renumbered to ${target}`, ':at': at, ':by': AUDIT_USER },
  }));
  await audit('Invoice', target, { renumberedFrom: oldId, orderId: row.order.id, factoringItemId: row.factoringItem?.id ?? null, document: docRow ? `inv:${target}` : null });
  return { written: 1, lost: 0 };
}

export function buildReport({ plan, today }) {
  const L = [`# Invoice renumber to PRO # (dry run ${today})`, ''];
  if (plan.length === 0) L.push('No counter-numbered (INV-…) invoices found.');
  for (const r of plan) L.push(`- ${r.invoice.id} (PRO ${r.invoice.shipmentNumber ?? '?'}, ${r.invoice.customerName ?? ''}): ${r.status === 'READY' ? `READY -> ${r.target}` : `REFUSED (${r.why.join('; ')})`}`);
  L.push('');
  return L.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { report: { type: 'string' }, apply: { type: 'boolean' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS }, allowPositionals: false });
  if (values.help) { console.log(`Usage: node scripts/awInvoiceRenumber.mjs [--report <file.md>] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`); return; }
  const gate = await renumberGate(values);
  let suffix;
  if (gate) suffix = gate.suffix; else { suffix = values.suffix ?? DEV_SUFFIX; if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate'); }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const all = await scanAll(doc, `Invoice-${suffix}`, ['id']);
  const invoices = [];
  for (const r of all) {
    if (/^INV-\d+$/.test(String(r.id))) invoices.push((await doc.send(new GetCommand({ TableName: `Invoice-${suffix}`, Key: { id: r.id } }))).Item);
    else invoices.push({ id: r.id });
  }
  const orders = await scanAll(doc, `Order-${suffix}`, ['id', 'shipmentId', 'invoiceId']);
  const payments = await scanAll(doc, `ArPayment-${suffix}`, ['id', 'invoiceId', 'applications']);
  const commissions = await scanAll(doc, `Commission-${suffix}`, ['id', 'invoiceId']);
  const factoring = await scanAll(doc, `FactoringItem-${suffix}`, ['id', 'invoiceId', 'otrInvoiceId']);
  const plan = planRenumber({ invoices, orders, payments, commissions, factoring });
  const report = buildReport({ plan, today: localDate(new Date()) });
  const path = values.report ?? '/private/tmp/invoice-renumber-report.md';
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${report}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  console.log(report);
  const ready = plan.filter((r) => r.status === 'READY');
  if (!apply) { console.log(`DRY RUN: nothing written. ${ready.length} of ${plan.length} would be renumbered.`); return; }
  const out = { written: 0, lost: 0 };
  for (const row of ready) { const x = await applyOne({ doc, suffix, row }); out.written += x.written; out.lost += x.lost; }
  console.log('APPLIED', JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
