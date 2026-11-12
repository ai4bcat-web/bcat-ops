#!/usr/bin/env node
/**
 * "Customer paid on" for the three factoring rows OTR marked Dead but the customers paid directly (Ryne 2026-11-12): PROs 14749, 14700, 14538.
 * Dry by default, prod-gated apply. Each row gets FactoringItem.customerPaidOn (+ customerPaymentRef) taken from the customer payment already
 * applied to its invoice, only while the field is still empty and the row is still Pending with OTR. The row's status, the shipment, the invoice
 * and the payment are never touched, and the row is NOT marked Factored (OTR never funded it).
 *
 * The expected dates below are what Ryne was shown; the script re-reads the invoice and the payment and REFUSES (writes nothing) if any row
 * is not as expected: row missing / not Pending with OTR / OTR status not Dead / invoice not fully paid / payment date or amount different.
 *
 *   dry run (read-only):  BCAT_ALLOW_PROD=$(date +%F) node scripts/awFactoringCustomerPaid.mjs --target prod --i-mean-production
 *   backup (< 6 h before apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awFactoringCustomerPaid --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-facpaid node scripts/awFactoringCustomerPaid.mjs --target prod --i-mean-production \
 *       --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Undo: set customerPaidOn / customerPaymentRef back to empty on the three rows (the AuditLog rows hold the previous values), or restore from the backup.
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

export const SCRIPT = 'awFactoringCustomerPaid';
export const AUDIT_ACTION = 'AW_FACTORING_CUSTOMER_PAID';
export const AUDIT_USER = 'system:awFactoringCustomerPaid';

/** What Ryne was shown, from the customer payments applied to each invoice. */
export const EXPECTED = [
  { pro: '14749', paidOn: '2026-10-30', amountCents: 40000, reference: '2383731' },
  { pro: '14700', paidOn: '2026-10-28', amountCents: 330000, reference: 'MAV145128206' },
  { pro: '14538', paidOn: '2026-10-13', amountCents: 80000, reference: '2010269' },
];

export async function facPaidGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awFactoringCustomerPaid.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-facpaid`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
  }
  return gate;
}

const otrCode = (v) => { const s = String(v ?? '').trim(); return /^\d+$/.test(s) ? Number(s) : /^dead$/i.test(s) ? 4 : null; };
const appliesTo = (payment, invoiceId) => {
  let apps = payment.applications;
  if (typeof apps === 'string') { try { apps = JSON.parse(apps); } catch { apps = []; } }
  return payment.invoiceId === invoiceId || (Array.isArray(apps) && apps.some((a) => a?.invoiceId === invoiceId));
};

/** One verdict per expected row: either READY (with what it would write) or REFUSED (with why). Pure, so it is tested. */
export function planCustomerPaid({ expected = EXPECTED, items, invoices, payments }) {
  return expected.map((exp) => {
    const item = items.find((i) => String(i.id) === exp.pro);
    const why = [];
    if (!item) return { exp, status: 'REFUSED', why: ['factoring row not found'] };
    if (item.status !== 'PENDING_WITH_OTR') why.push(`row status is ${item.status}, expected PENDING_WITH_OTR`);
    if (otrCode(item.otrStatus) !== 4) why.push(`OTR status is ${item.otrStatus ?? 'blank'}, expected Dead (4)`);
    if (item.customerPaidOn) return { exp, item, status: 'ALREADY_SET', why: [`customerPaidOn is already ${item.customerPaidOn}`] };
    const invoice = invoices.find((i) => String(i.number ?? i.id) === exp.pro || String(i.id) === exp.pro);
    if (!invoice) why.push('no invoice with this number');
    else if (invoice.status === 'VOID') why.push('invoice is void');
    else if (Number(invoice.balanceCents) !== 0 || !Number(invoice.paidCents)) why.push(`invoice not fully paid (paid ${invoice.paidCents}, balance ${invoice.balanceCents})`);
    const pays = invoice ? payments.filter((p) => (p.kind ?? 'PAYMENT') === 'PAYMENT' && appliesTo(p, invoice.id)) : [];
    if (invoice && pays.length !== 1) why.push(`expected exactly one customer payment applied to the invoice, found ${pays.length}`);
    const pay = pays[0];
    const paidOn = pay?.receivedAt ? String(pay.receivedAt).slice(0, 10) : null;
    if (pay && paidOn !== exp.paidOn) why.push(`payment date is ${paidOn}, expected ${exp.paidOn}`);
    if (pay && Number(pay.amountCents) !== exp.amountCents) why.push(`payment amount is ${pay.amountCents}, expected ${exp.amountCents}`);
    if (pay && exp.reference && !String(pay.reference ?? '').includes(exp.reference)) why.push(`payment reference is ${pay.reference ?? 'blank'}, expected ${exp.reference}`);
    if (why.length) return { exp, item, invoice, payment: pay, status: 'REFUSED', why };
    return { exp, item, invoice, payment: pay, status: 'READY', paidOn, reference: String(pay.reference ?? exp.reference).slice(0, 80) };
  });
}

export async function applyOne({ doc, suffix, row, now = new Date() }) {
  assertWritableSuffix(suffix, 'factoring customer-paid fill');
  const nowIso = now.toISOString();
  try {
    await doc.send(new UpdateCommand({
      TableName: `FactoringItem-${suffix}`, Key: { id: row.item.id },
      UpdateExpression: 'SET customerPaidOn = :d, customerPaymentRef = :r, customerPaidSetBy = :by, customerPaidSetAt = :at',
      ConditionExpression: 'attribute_exists(id) AND #st = :pending AND (attribute_not_exists(customerPaidOn) OR attribute_type(customerPaidOn, :nul) OR customerPaidOn = :blank)',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':d': row.paidOn, ':r': row.reference, ':by': AUDIT_USER, ':at': nowIso, ':pending': 'PENDING_WITH_OTR', ':nul': 'NULL', ':blank': '' },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: 1 };
    throw err;
  }
  await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'FactoringItem', entityId: row.item.id, action: AUDIT_ACTION, user: AUDIT_USER, changes: JSON.stringify({ previous: { customerPaidOn: null, customerPaymentRef: null }, next: { customerPaidOn: row.paidOn, customerPaymentRef: row.reference }, proNumber: row.exp.pro, paymentId: row.payment?.id ?? null, source: 'customer payment applied to the invoice' }), createdAt: nowIso, updatedAt: nowIso } }));
  return { written: 1, lost: 0 };
}

export function buildReport({ plan, today }) {
  const L = [`# Factoring: customer paid on (dry run ${today})`, ''];
  for (const r of plan) {
    L.push(`- ${r.exp.pro}: ${r.status}${r.status === 'READY' ? ` -> customerPaidOn ${r.paidOn}, ref ${r.reference} (invoice ${r.invoice.id} paid ${r.invoice.paidCents}c, row ${r.item.status}, OTR status ${r.item.otrStatus})` : ` (${r.why.join('; ')})`}`);
  }
  L.push('');
  return L.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { report: { type: 'string' }, apply: { type: 'boolean' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS }, allowPositionals: false });
  if (values.help) { console.log(`Usage: node scripts/awFactoringCustomerPaid.mjs [--report <file.md>] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`); return; }
  const gate = await facPaidGate(values);
  let suffix;
  if (gate) suffix = gate.suffix; else { suffix = values.suffix ?? DEV_SUFFIX; if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate'); }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const items = [];
  for (const exp of EXPECTED) { const r = await doc.send(new GetCommand({ TableName: `FactoringItem-${suffix}`, Key: { id: exp.pro } })); if (r.Item) items.push(r.Item); }
  const invoices = await scanAll(doc, `Invoice-${suffix}`, ['id', 'number', 'status', 'paidCents', 'balanceCents', 'paidAt']);
  const payments = await scanAll(doc, `ArPayment-${suffix}`, ['id', 'kind', 'receivedAt', 'reference', 'amountCents', 'invoiceId', 'applications']);
  const plan = planCustomerPaid({ items, invoices, payments });
  const report = buildReport({ plan, today: localDate(new Date()) });
  const path = values.report ?? '/private/tmp/facpaid-report.md';
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${report}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  console.log(report);
  const ready = plan.filter((r) => r.status === 'READY');
  if (!apply) { console.log(`DRY RUN: nothing written. ${ready.length} of ${plan.length} rows would get a customer-paid date.`); return; }
  if (ready.length !== plan.length) throw new Error('Refusing to apply: not every row matches what was expected (see the report). Nothing written.');
  const out = { written: 0, lost: 0 };
  for (const row of ready) { const x = await applyOne({ doc, suffix, row }); out.written += x.written; out.lost += x.lost; }
  console.log('APPLIED', JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
