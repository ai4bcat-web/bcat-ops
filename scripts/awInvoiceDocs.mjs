#!/usr/bin/env node
/**
 * Invoice documents on their shipments (Ryne 2026-11-12): every issued invoice with a stored PDF should show on its shipment as an
 * INVOICE document (`ShipmentDocument` id `inv:<invoiceId>`, the same row `ATTACH_INVOICE_DOC` writes). Invoices issued before that
 * existed, or whose filing failed, have no such row. Dry by default, prod-gated apply. ADDS MISSING ROWS ONLY; an existing row is
 * never touched and no invoice, PDF or e-mail is read back or sent.
 *
 *   dry run (read-only; counts on stdout, report in --report):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awInvoiceDocs.mjs --target prod --i-mean-production
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awInvoiceDocs --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-invoicedocs node scripts/awInvoiceDocs.mjs <same args> \
 *       --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Writes ONLY ShipmentDocument rows, each conditional on `attribute_not_exists(id)`.
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { scanAll } from './awCustomerEmail.mjs';

export const SCRIPT = 'awInvoiceDocs';
export const AUDIT_USER = 'system:awInvoiceDocs';

export async function invoiceDocsGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awInvoiceDocs.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-invoicedocs`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
  }
  return gate;
}

/** The document row `ATTACH_INVOICE_DOC` would write for this invoice (same id, type, audience and name). */
export function documentRowFor(invoice) {
  const at = invoice.issuedAt ?? invoice.createdAt ?? new Date().toISOString();
  return {
    id: `inv:${invoice.id}`,
    __typename: 'ShipmentDocument',
    shipmentId: invoice.shipmentId,
    ...(invoice.orderId ? { orderId: invoice.orderId } : {}),
    type: 'INVOICE',
    name: `Invoice ${invoice.number ?? invoice.id}.pdf`.slice(0, 200),
    s3Key: invoice.pdfKey,
    contentType: 'application/pdf',
    sizeBytes: invoice.pdfSizeBytes ?? 0,
    source: 'GENERATED',
    sourceRef: invoice.id,
    audience: 'CUSTOMER',
    status: 'ACTIVE',
    version: 1,
    uploadedBy: AUDIT_USER,
    uploadedAt: at,
    createdBy: AUDIT_USER,
    createdAt: at,
    updatedAt: at,
  };
}

/** Which invoices need a row. Void invoices and invoices with no stored PDF are counted, never filed. */
export function planInvoiceDocs(invoices, documents) {
  const have = new Set(documents.filter((d) => String(d.id).startsWith('inv:')).map((d) => d.id));
  const plan = { total: invoices.length, alreadyFiled: 0, void: 0, noPdf: 0, noShipment: 0, missing: [] };
  for (const invoice of invoices) {
    if (invoice.status === 'VOID') { plan.void += 1; continue; }
    if (!invoice.pdfKey) { plan.noPdf += 1; continue; }
    if (!invoice.shipmentId) { plan.noShipment += 1; continue; }
    if (have.has(`inv:${invoice.id}`)) { plan.alreadyFiled += 1; continue; }
    plan.missing.push(invoice);
  }
  return plan;
}

export async function applyOne({ doc, suffix, invoice }) {
  assertWritableSuffix(suffix, 'invoice document backfill');
  try {
    await doc.send(new PutCommand({ TableName: `ShipmentDocument-${suffix}`, Item: documentRowFor(invoice), ConditionExpression: 'attribute_not_exists(id)' }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: 1 };
    throw err;
  }
  return { written: 1, lost: 0 };
}

export function buildReport({ plan, today }) {
  const L = [`# Invoice documents on shipments (dry run ${today})`, '',
    `- Invoices read: ${plan.total}; already filed on their shipment ${plan.alreadyFiled}; void (skipped) ${plan.void}; no stored PDF (skipped) ${plan.noPdf}; no shipment (skipped) ${plan.noShipment}`,
    `- WOULD FILE: ${plan.missing.length}`, '',
    `## Would file (${plan.missing.length})`,
    ...(plan.missing.length ? plan.missing.map((i) => `- ${[i.number ?? i.id, i.shipmentId, i.pdfKey].join(' | ')}`) : ['(none)']), ''];
  return L.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { report: { type: 'string' }, apply: { type: 'boolean' }, limit: { type: 'string' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS }, allowPositionals: false });
  if (values.help) { console.log(`Usage: node scripts/awInvoiceDocs.mjs [--report <file.md>] [--limit N] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`); return; }
  const gate = await invoiceDocsGate(values);
  let suffix;
  if (gate) suffix = gate.suffix; else { suffix = values.suffix ?? DEV_SUFFIX; if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate'); }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const invoices = await scanAll(doc, `Invoice-${suffix}`, ['id', 'number', 'status', 'shipmentId', 'orderId', 'pdfKey', 'pdfSizeBytes', 'issuedAt', 'createdAt']);
  const documents = await scanAll(doc, `ShipmentDocument-${suffix}`, ['id']);
  const plan = planInvoiceDocs(invoices, documents);
  const report = buildReport({ plan, today: localDate(new Date()) });
  const path = values.report ?? '/private/tmp/invoicedocs-report.md';
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${report}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  console.log(report.split('\n').filter((l) => l.startsWith('- ')).join('\n'));
  console.log(`report: ${path} (mode 0600)`);
  if (!apply) { console.log(`DRY RUN: nothing written. ${plan.missing.length} invoice(s) would be filed on their shipments.`); return; }
  const limit = values.limit ? Number(values.limit) : Infinity;
  const out = { written: 0, lost: 0 }; let n = 0;
  for (const invoice of plan.missing) { if (n >= limit) break; n += 1; const x = await applyOne({ doc, suffix, invoice }); out.written += x.written; out.lost += x.lost; }
  console.log('APPLIED', JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
