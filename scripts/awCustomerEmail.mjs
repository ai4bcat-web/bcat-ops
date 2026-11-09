#!/usr/bin/env node
/**
 * Customer invoice / AP e-mail enrich from the Aljex customers export (dry by default, prod-gated apply). ENRICH ONLY.
 *
 *   dry run (read-only, prints counts, writes 0600 review CSVs into --report-dir):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awCustomerEmail.mjs --target prod --i-mean-production \
 *       --export ~/aljex-export/aljex-customers-2026-11-08.csv
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awCustomerEmail --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-customeremail node scripts/awCustomerEmail.mjs <same args> \
 *       --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Matches Customer.aljexCode to the export's `Account #`. Writes ONLY e-mail fields, each only while still empty
 * (conditional update, never overwrites): apEmail (invoice "To"), invoiceCopyEmails (invoice "cc"), contactEmail; plus one
 * AuditLog row per changed customer with the previous values. Rules: scripts/lib/customerEmailPlan.mjs.
 * Reads (projection): id, name, aljexCode, billingMethod, mergedIntoId, active + the e-mail fields; Invoice customerId/status/
 * balanceCents/invoiceDate for the missing-e-mail report. Never sends anything.
 * PII: addresses and names only go into the 0600 CSVs; stdout carries counts.
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
import { csvCell } from './lib/releaseClassify.mjs';
import { EMAIL_FIELDS, apAfter, indexByAccount, matchCustomers, planCustomerEmail } from './lib/customerEmailPlan.mjs';

export const SCRIPT = 'awCustomerEmail';
export const AUDIT_ACTION = 'AW_CUSTOMER_EMAIL_ENRICH';
export const AUDIT_USER = 'system:awCustomerEmail';

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function customerEmailGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awCustomerEmail.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-customeremail`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) {
      throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
    }
  }
  return gate;
}

export async function scanAll(doc, table, projection) {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: table,
      ProjectionExpression: projection.map((_, i) => `#p${i}`).join(','),
      ExpressionAttributeNames: Object.fromEntries(projection.map((p, i) => [`#p${i}`, p])),
      ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

const COLUMNS = { account: 'account #', name: 'name', eBilling: 'e-billing email', contactEmail: 'contact email', contact2Email: 'contact 2 email' };

/** Stream the Aljex customers export into {account, name, eBilling, contactEmail, contact2Email} rows. */
export async function readCustomersExport(path) {
  const rows = [];
  let ix = null;
  const parser = createCsvParser((r) => {
    if (!ix) {
      const header = r.map((h) => h.trim().toLowerCase());
      ix = Object.fromEntries(Object.entries(COLUMNS).map(([k, name]) => {
        const i = header.indexOf(name);
        if (i < 0) throw new Error(`${path}: column "${name}" missing`);
        return [k, i];
      }));
      return;
    }
    rows.push(Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, (r[ix[k]] ?? '').trim()])));
  });
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) parser.write(chunk);
  parser.end();
  return rows;
}

export const writeCsv = (path, head, lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${[head.join(','), ...lines.map((l) => l.map(csvCell).join(','))].join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

/** One customer: conditional enrich of each empty e-mail target + one AuditLog row. Returns {written, lost} counts of fields. */
export async function applyOne({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'customer e-mail enrich');
  const nowIso = now.toISOString();
  const done = [];
  let lost = 0;
  for (const w of entry.writes) {
    if (!EMAIL_FIELDS.includes(w.field)) throw new Error(`refusing to write Customer.${w.field}`);
    const empty = w.field === 'invoiceCopyEmails'
      ? 'attribute_not_exists(#f) OR attribute_type(#f, :nul) OR size(#f) = :zero'
      : 'attribute_not_exists(#f) OR attribute_type(#f, :nul) OR #f = :blank';
    try {
      await doc.send(new UpdateCommand({
        TableName: `Customer-${suffix}`,
        Key: { id: entry.customer.id },
        UpdateExpression: 'SET #f = :v',
        ConditionExpression: `attribute_exists(id) AND (${empty})`,
        ExpressionAttributeNames: { '#f': w.field },
        ExpressionAttributeValues: { ':v': w.value, ':nul': 'NULL', ...(w.field === 'invoiceCopyEmails' ? { ':zero': 0 } : { ':blank': '' }) },
      }));
      done.push(w);
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') { lost += 1; continue; }
      throw err;
    }
  }
  if (done.length) {
    await doc.send(new PutCommand({
      TableName: `AuditLog-${suffix}`,
      Item: {
        id: randomUUID(),
        __typename: 'AuditLog',
        entityType: 'CUSTOMER',
        entityId: entry.customer.id,
        action: AUDIT_ACTION,
        user: AUDIT_USER,
        changes: JSON.stringify({
          aljexCode: entry.customer.aljexCode ?? null,
          previous: Object.fromEntries(done.map((w) => [w.field, null])),
          next: Object.fromEntries(done.map((w) => [w.field, w.value])),
        }),
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    }));
  }
  return { written: done.length, lost };
}

const checkpointPath = (suffix) => join(homedir(), 'bcat-ops-backups', `aw-customer-email-${suffix}.checkpoint.json`);
const loadCheckpoint = (path) => (existsSync(path) ? new Set(JSON.parse(readFileSync(path, 'utf8')).done ?? []) : new Set());
const saveCheckpoint = (path, done) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }), { mode: 0o600 });
};

const count = (list, fn) => list.reduce((m, x) => { const k = fn(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});

async function main() {
  const { values } = parseArgs({
    options: {
      export: { type: 'string' }, 'report-dir': { type: 'string' }, apply: { type: 'boolean' }, limit: { type: 'string' },
      suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS,
    },
    allowPositionals: false,
  });
  if (values.help || !values.export) {
    console.log(`Usage: node scripts/awCustomerEmail.mjs --export <aljex-customers.csv> [--report-dir <dir>] [--limit N] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`);
    return;
  }
  const gate = await customerEmailGate(values);
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const today = localDate(new Date());
  const reportDir = values['report-dir'] ?? join(homedir(), 'aljex-export', 'reports');

  const exportRows = await readCustomersExport(values.export);
  const [customers, invoices] = await Promise.all([
    scanAll(doc, `Customer-${suffix}`, ['id', 'name', 'aljexCode', 'billingMethod', 'mergedIntoId', 'active', 'apEmail', 'invoiceCopyEmails', 'contactEmail', 'billingEmail']),
    scanAll(doc, `Invoice-${suffix}`, ['customerId', 'status', 'balanceCents', 'invoiceDate']),
  ]);
  const { byAccount, duplicates } = indexByAccount(exportRows);
  const { matched, ambiguous, unmatchedRows, live } = matchCustomers(customers, byAccount);
  const plans = matched.map(({ row, customer }) => ({ row, customer, plan: planCustomerEmail(row, customer) }));
  const toApply = plans.filter((p) => p.plan.writes.length > 0).map((p) => ({ customer: p.customer, writes: p.plan.writes }));
  const wc = (field) => plans.filter((p) => p.plan.writes.some((w) => w.field === field)).length;
  const sk = (reason) => plans.filter((p) => p.plan.skipped.includes(reason)).length;
  const withBefore = (fn) => live.filter(fn).length;
  const hasAny = (c) => [c.apEmail, c.contactEmail].some((v) => String(v ?? '').trim()) || (c.invoiceCopyEmails ?? []).length > 0;

  console.log(`export rows ${exportRows.length} (distinct Account # ${byAccount.size}, repeated ${duplicates.length}); production customers ${customers.length} (live ${live.length}); with any AP/contact e-mail before ${withBefore(hasAny)}`);
  console.log(`MATCHED customers ${matched.length}; ambiguous aljexCode (never written) ${ambiguous.length}; export rows with NO matching customer ${unmatchedRows.length}`);
  console.log(`apEmail to set ${wc('apEmail')}; contactEmail to set ${wc('contactEmail')}; invoiceCopyEmails to set ${wc('invoiceCopyEmails')} (extra addresses ${plans.reduce((n, p) => n + p.plan.extras.length, 0)})`);
  console.log(`already set (skipped): apEmail ${sk('AP_ALREADY_SET')}, contactEmail ${sk('CONTACT_ALREADY_SET')}, copy list ${sk('COPY_LIST_ALREADY_SET')}; FACTOR customers with an external e-billing address (not written) ${sk('FACTOR_CUSTOMER')}`);
  console.log(`internal @bcatcorp.com e-billing addresses (never written; factor bridge / own mailbox) rows ${plans.filter((p) => p.plan.internal.length).length}; by address-count ${JSON.stringify(count(plans.filter((p) => p.plan.internal.length), (p) => p.plan.internal.length))}`);
  const malformed = plans.flatMap((p) => p.plan.malformed.map((m) => ({ ...p, bad: m })));
  console.log(`MALFORMED addresses ${malformed.length} (listed in file); Contact 2 e-mails seen (not written, no field) ${plans.reduce((n, p) => n + p.plan.contact2, 0)}`);
  console.log(`TO APPLY: ${toApply.length} customers; field writes ${JSON.stringify(count(toApply.flatMap((e) => e.writes), (w) => w.field))}`);

  // Customers still without an AP e-mail after the enrich (what actually blocks a MANUAL invoice send).
  const planBy = new Map(plans.map((p) => [p.customer.id, p.plan]));
  const inv = new Map();
  for (const i of invoices) {
    const e = inv.get(i.customerId) ?? { open: 0, last: '' };
    if (i.status === 'ISSUED' || i.status === 'PARTIAL') e.open += Number(i.balanceCents ?? 0);
    if (i.status !== 'VOID' && String(i.invoiceDate ?? '') > e.last) e.last = String(i.invoiceDate);
    inv.set(i.customerId, e);
  }
  const missing = live.filter((c) => !apAfter(c, planBy.get(c.id)));
  const money = (cents) => (cents / 100).toFixed(2);
  const missingPath = join(reportDir, 'customers-missing-invoice-email-2026-11-09.csv');
  writeCsv(missingPath, ['name', 'aljexCode', 'billing method', 'open AR $', 'last invoice date'],
    missing.sort((a, b) => (inv.get(b.id)?.open ?? 0) - (inv.get(a.id)?.open ?? 0)).map((c) => [c.name ?? '', c.aljexCode ?? '', c.billingMethod ?? '(not set)', money(inv.get(c.id)?.open ?? 0), inv.get(c.id)?.last ?? '']));
  console.log(`STILL WITHOUT AP e-mail after enrich: ${missing.length} customers (method ${JSON.stringify(count(missing, (c) => c.billingMethod ?? 'NOT_SET'))}; with open AR ${missing.filter((c) => (inv.get(c.id)?.open ?? 0) > 0).length}; open AR $ ${money(missing.reduce((n, c) => n + (inv.get(c.id)?.open ?? 0), 0))}) -> ${missingPath}`);

  const f = (name) => join(reportDir, `${name}-${today}.csv`);
  writeCsv(f('customer-email-to-apply'), ['aljexCode', 'customer', 'field', 'value'],
    toApply.flatMap((e) => e.writes.map((w) => [e.customer.aljexCode ?? '', e.customer.name ?? '', w.field, Array.isArray(w.value) ? w.value.join(';') : w.value])));
  writeCsv(f('customer-email-malformed'), ['aljexCode', 'customer', 'malformed address'], malformed.map((m) => [m.customer.aljexCode ?? '', m.customer.name ?? '', m.bad]));
  writeCsv(f('customer-email-no-customer'), ['Account #', 'export name', 'has e-billing', 'has contact email'],
    unmatchedRows.map((r) => [r.account, r.name, r.eBilling ? 'yes' : 'no', r.contactEmail ? 'yes' : 'no']));
  console.log(`reports written to ${reportDir} (mode 0600): customer-email-to-apply, customer-email-malformed, customer-email-no-customer (${today}), customers-missing-invoice-email-2026-11-09`);

  if (!apply) {
    console.log(`DRY RUN: nothing written. ${toApply.length} customer(s) would be enriched.`);
    return;
  }
  const limit = values.limit ? Number(values.limit) : Infinity;
  const cpPath = checkpointPath(suffix);
  const done = loadCheckpoint(cpPath);
  const out = { customers: 0, fieldsWritten: 0, fieldsAlreadyFilled: 0, skippedDone: 0 };
  let n = 0;
  for (const entry of toApply) {
    if (n >= limit) break;
    if (done.has(entry.customer.id)) { out.skippedDone += 1; continue; }
    n += 1;
    const r = await applyOne({ doc, suffix, entry });
    out.customers += r.written ? 1 : 0;
    out.fieldsWritten += r.written;
    out.fieldsAlreadyFilled += r.lost;
    done.add(entry.customer.id);
    if (n % 25 === 0) saveCheckpoint(cpPath, done);
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
