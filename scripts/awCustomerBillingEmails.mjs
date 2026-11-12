#!/usr/bin/env node
/**
 * Customer AP e-mail fill from the OTR billing-emails list (Ryne 2026-11-12). Dry by default, prod-gated apply. FILL BLANKS ONLY.
 * Rules: scripts/lib/billingEmailsPlan.mjs (MC number then exact normalized name; apEmail only; never overwrites; FACTOR customers,
 * @bcatcorp.com addresses, conflicting rows and ambiguous matches are listed, not written).
 *
 *   dry run (read-only; counts on stdout, report in --report):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awCustomerBillingEmails.mjs --target prod --i-mean-production --csv <BILLING_EMAILS_LIST_FROM_OTR.csv>
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awCustomerBillingEmails --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-billingemails node scripts/awCustomerBillingEmails.mjs <same args> \
 *       --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Writes ONLY Customer.apEmail (conditional: still empty and billingMethod not FACTOR) and Customer.noaEmail (notice-of-assignment
 * addresses; conditional: still empty), each with one AuditLog row per customer. Never sends anything.
 */
import { createReadStream, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { createCsvParser } from './lib/csvStream.mjs';
import { scanAll } from './awCustomerEmail.mjs';
import { planBillingEmails, prepareRows } from './lib/billingEmailsPlan.mjs';

export const SCRIPT = 'awCustomerBillingEmails';
export const AUDIT_ACTION = 'AW_CUSTOMER_BILLING_EMAILS';
export const AUDIT_USER = 'system:awCustomerBillingEmails';

export async function billingEmailsGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awCustomerBillingEmails.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-billingemails`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
  }
  return gate;
}

export async function readCsv(path) {
  const rows = []; let head = null;
  const parser = createCsvParser((r) => {
    if (!head) { head = r.map((h) => h.trim()); return; }
    rows.push(Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
  });
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) parser.write(chunk);
  parser.end();
  return rows;
}

export async function applyNoa({ doc, suffix, customer, email, now = new Date() }) {
  assertWritableSuffix(suffix, 'customer notice-of-assignment e-mail fill');
  const nowIso = now.toISOString();
  try {
    await doc.send(new UpdateCommand({
      TableName: `Customer-${suffix}`, Key: { id: customer.id }, UpdateExpression: 'SET noaEmail = :v',
      ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(noaEmail) OR attribute_type(noaEmail, :nul) OR noaEmail = :blank)',
      ExpressionAttributeValues: { ':v': email, ':nul': 'NULL', ':blank': '' },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: 1 };
    throw err;
  }
  await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'CUSTOMER', entityId: customer.id, action: AUDIT_ACTION, user: AUDIT_USER, changes: JSON.stringify({ previous: { noaEmail: null }, next: { noaEmail: email }, source: 'OTR billing emails list (notice of assignment)' }), createdAt: nowIso, updatedAt: nowIso } }));
  return { written: 1, lost: 0 };
}

export async function applyOne({ doc, suffix, customer, email, now = new Date() }) {
  assertWritableSuffix(suffix, 'customer billing e-mail fill');
  const nowIso = now.toISOString();
  try {
    await doc.send(new UpdateCommand({
      TableName: `Customer-${suffix}`, Key: { id: customer.id }, UpdateExpression: 'SET apEmail = :v',
      ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(apEmail) OR attribute_type(apEmail, :nul) OR apEmail = :blank) AND (attribute_not_exists(billingMethod) OR attribute_type(billingMethod, :nul) OR billingMethod <> :factor)',
      ExpressionAttributeValues: { ':v': email, ':nul': 'NULL', ':blank': '', ':factor': 'FACTOR' },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: 1 };
    throw err;
  }
  await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'CUSTOMER', entityId: customer.id, action: AUDIT_ACTION, user: AUDIT_USER, changes: JSON.stringify({ previous: { apEmail: null }, next: { apEmail: email }, source: 'OTR billing emails list' }), createdAt: nowIso, updatedAt: nowIso } }));
  return { written: 1, lost: 0 };
}

const tally = (results) => results.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {});
const line = (...c) => c.join(' | ');

export function buildReport({ prepared, plan, rowCount, today }) {
  const t = tally(plan.results);
  const by = (s) => plan.results.filter((r) => r.status === s);
  const noaRows = plan.results.filter((r) => r.customer && r.company.noa.length);
  const noaAddrs = noaRows.reduce((n, r) => n + r.company.noa.length, 0);
  const L = [`# OTR billing emails -> Customer.apEmail (dry run ${today})`, '',
    `- CSV rows ${rowCount}; blank-email rows ${prepared.blankRows}; skipped by name ${prepared.skipped.length} (${prepared.skipped.join(', ') || 'none'}); rows with a usable address ${prepared.rows.length}`,
    `- Unique companies after merging name/MC variants: ${plan.companies.length}; live production customers ${plan.liveCount}`,
    `- MATCHED to a customer: ${plan.results.length - (t.UNMATCHED ?? 0) - (t.AMBIGUOUS ?? 0)}; unmatched companies ${t.UNMATCHED ?? 0}; ambiguous ${t.AMBIGUOUS ?? 0}`,
    `- WOULD FILL apEmail (blank today): ${t.FILL ?? 0} (billing method unset ${by('FILL').filter((r) => r.flags.includes('BILLING_METHOD_UNSET')).length})`,
    `- WOULD WRITE Customer.noaEmail (blank today, one notice address): ${plan.noaWrites.length}; NOA left alone (already set / several addresses / ambiguous): ${plan.noaOther.length}`,
    `- NOTICE-OF-ASSIGNMENT addresses (go to noaEmail, never apEmail): ${noaRows.length} matched customers, ${noaAddrs} addresses; of those ${noaRows.filter((r) => r.status === 'NOA_ONLY').length} have ONLY a notice address (AP e-mail left blank); by billing method ${JSON.stringify(noaRows.reduce((m, r) => { const k = r.customer.billingMethod ?? 'NOT_SET'; m[k] = (m[k] ?? 0) + 1; return m; }, {}))}; customers already holding the address in apEmail ${noaRows.filter((r) => r.customer.apEmail && r.company.noa.some((a) => a === String(r.customer.apEmail).trim().toLowerCase())).length}`,
    `- Already had an e-mail: ${(t.SAME_EMAIL ?? 0) + (t.DIFFERS ?? 0)} (same address ${t.SAME_EMAIL ?? 0}; DIFFERS ${t.DIFFERS ?? 0}); FACTOR customers (not written) ${t.FACTOR_CUSTOMER ?? 0}; conflicting rows (not written) ${t.CONFLICT ?? 0}`, ''];
  const sect = (title, items) => { L.push(`## ${title} (${items.length})`, ...(items.length ? items : ['(none)']), ''); };
  sect('Would fill apEmail', by('FILL').map((r) => `- ${line(r.customer.name, r.email, r.flags.join(','))}`));
  sect('Would write noaEmail (customer | notice address)', plan.noaWrites.map((w) => `- ${line(w.customer.name, w.noa)}`));
  sect('NOA left alone (customer | why | existing | OTR list)', plan.noaOther.map((r) => `- ${line(r.customer.name ?? r.company.names.join(' / '), r.why, r.existing ?? '', r.noa ?? r.company.noa.join(', '))}`));
  sect('NOTICE-OF-ASSIGNMENT addresses in the list (customer | billing method | existing apEmail | notice address(es) | AP-only?)', noaRows.map((r) => `- ${line(r.customer.name, r.customer.billingMethod ?? 'NOT_SET', r.customer.apEmail ?? '', r.company.noa.join(', '), r.status === 'NOA_ONLY' ? 'NOA only' : 'also has AP')}`));
  sect('Differs from what the customer already has (NOT overwritten): customer | existing | OTR list', by('DIFFERS').map((r) => `- ${line(r.customer.name, r.existing, r.email)}`));
  sect('FACTOR customers (no AP e-mail by design, not written): customer | OTR address', by('FACTOR_CUSTOMER').map((r) => `- ${line(r.customer.name, r.email)}`));
  sect('Conflicting addresses for one company (not written)', by('CONFLICT').map((r) => `- ${line(r.customer.name, r.company.emails.join(' / '))}`));
  sect('Ambiguous (more than one customer / two companies on one customer; not written)', by('AMBIGUOUS').map((r) => `- ${line(r.company.names.join(' / '), (r.matches ?? []).map((c) => c.name).join(' / '), r.flags.join(','))}`));
  sect('Unmatched companies (no customer by MC or exact name)', by('UNMATCHED').map((r) => `- ${line(r.company.names.join(' / '), r.company.emails.join(' / '))}`));
  sect('Rows with an @bcatcorp.com address (dropped)', prepared.bcatInternal.map((n) => `- ${n}`));
  return L.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { csv: { type: 'string' }, report: { type: 'string' }, apply: { type: 'boolean' }, limit: { type: 'string' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS }, allowPositionals: false });
  if (values.help || !values.csv) { console.log(`Usage: node scripts/awCustomerBillingEmails.mjs --csv <file> [--report <file.md>] [--limit N] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`); return; }
  const gate = await billingEmailsGate(values);
  let suffix;
  if (gate) suffix = gate.suffix; else { suffix = values.suffix ?? DEV_SUFFIX; if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate'); }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const csvRows = await readCsv(values.csv);
  const prepared = prepareRows(csvRows);
  const customers = await scanAll(doc, `Customer-${suffix}`, ['id', 'name', 'mcNumber', 'billingMethod', 'mergedIntoId', 'active', 'apEmail', 'noaEmail']);
  const plan = planBillingEmails(customers, prepared);
  const report = buildReport({ prepared, plan, rowCount: csvRows.length, today: localDate(new Date()) });
  const path = values.report ?? '/private/tmp/billmail-report.md';
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${report}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  console.log(report.split('\n').filter((l) => l.startsWith('- ')).slice(0, 6).join('\n'));
  console.log(`report: ${path} (mode 0600)`);
  const toApply = plan.results.filter((r) => r.status === 'FILL');
  if (!apply) { console.log(`DRY RUN: nothing written. ${toApply.length} customer(s) would get an apEmail; ${plan.noaWrites.length} would get a noaEmail.`); return; }
  const limit = values.limit ? Number(values.limit) : Infinity;
  const out = { written: 0, lost: 0 }; let n = 0;
  for (const r of toApply) { if (n >= limit) break; n += 1; const x = await applyOne({ doc, suffix, customer: r.customer, email: r.email }); out.written += x.written; out.lost += x.lost; }
  const noaOut = { written: 0, lost: 0 }; let m = 0;
  for (const w of plan.noaWrites) { if (m >= limit) break; m += 1; const x = await applyNoa({ doc, suffix, customer: w.customer, email: w.noa }); noaOut.written += x.written; noaOut.lost += x.lost; }
  console.log('APPLIED apEmail', JSON.stringify(out), 'noaEmail', JSON.stringify(noaOut));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
