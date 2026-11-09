#!/usr/bin/env node
/**
 * Customer billing method, AP e-mail and payment terms (Ryne 2026-11-09). Dry by default, prod-gated apply.
 * Rules: scripts/lib/customerBillingPlan.mjs (factor address in the Aljex E-Billing Email -> FACTOR and no e-mail; a real
 * address -> apEmail (+ MANUAL while the method is unset); every customer Net 30 while terms are empty, Danisco 120).
 *
 *   dry run (read-only; counts on stdout, 0600 review CSVs in --report-dir):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awCustomerBilling.mjs --target prod --i-mean-production \
 *       --export ~/aljex-export/customers-invoice-email-2026-11-09.csv
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awCustomerBilling --target prod --i-mean-production --apply
 *   apply (typed token <date>-customerbilling):
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-customerbilling node scripts/awCustomerBilling.mjs <same args> \
 *       --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Writes ONLY Customer.billingMethod / apEmail / paymentTermsDays, one conditional UpdateItem per customer (every field must
 * still hold the value the plan read) + one AuditLog row with the previous values. Never sends anything.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { createCsvParser } from './lib/csvStream.mjs';
import { csvCell } from './lib/releaseClassify.mjs';
import { WRITABLE_FIELDS, planAll } from './lib/customerBillingPlan.mjs';

export const SCRIPT = 'awCustomerBilling';
export const AUDIT_ACTION = 'AW_CUSTOMER_BILLING_ENRICH';
export const AUDIT_USER = 'system:awCustomerBilling';

export async function billingGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: ['Customer', 'AuditLog'], deps });
  if (gate?.apply && !gate.rehearsal && (deps.env ?? process.env).AW_PROD_CONFIRM !== `${localDate(deps.now ?? new Date())}-customerbilling`) {
    throw new Error('Production gate closed for awCustomerBilling:\n  - (e) env AW_PROD_CONFIRM must equal <today>-customerbilling');
  }
  return gate;
}

async function scanAll(doc, table, projection) {
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

async function readExport(path) {
  const rows = [];
  let ix = null;
  const parser = createCsvParser((r) => {
    if (!ix) {
      const header = r.map((h) => h.trim().toLowerCase());
      ix = { name: header.indexOf('name'), eBilling: header.indexOf('e-billing email') };
      if (ix.name < 0 || ix.eBilling < 0) throw new Error(`${path}: needs the columns Name and E-Billing Email`);
      return;
    }
    rows.push({ name: (r[ix.name] ?? '').trim(), eBilling: (r[ix.eBilling] ?? '').trim() });
  });
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) parser.write(chunk);
  parser.end();
  return rows;
}

const writeCsv = (path, head, lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${[head.join(','), ...lines.map((l) => l.map(csvCell).join(','))].join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};
const count = (list, fn) => list.reduce((m, x) => { const k = fn(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});

/** One customer: a single conditional UpdateItem (each field must still hold its planned previous value) + one AuditLog row. */
export async function applyOne({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'customer billing enrich');
  const names = {};
  const values = { ':nul': 'NULL' };
  const sets = [];
  const conds = ['attribute_exists(id)'];
  entry.writes.forEach((w, i) => {
    if (!WRITABLE_FIELDS.includes(w.field)) throw new Error(`refusing to write Customer.${w.field}`);
    names[`#f${i}`] = w.field;
    values[`:n${i}`] = w.to;
    sets.push(`#f${i} = :n${i}`);
    if (w.from == null || w.from === '') conds.push(`(attribute_not_exists(#f${i}) OR attribute_type(#f${i}, :nul) OR #f${i} = :blank)`);
    else { values[`:o${i}`] = w.from; conds.push(`#f${i} = :o${i}`); }
  });
  if (conds.some((c) => c.includes(':blank'))) values[':blank'] = '';
  try {
    await doc.send(new UpdateCommand({
      TableName: `Customer-${suffix}`,
      Key: { id: entry.customer.id },
      UpdateExpression: `SET ${sets.join(', ')}, updatedAt = :now, updatedBy = :by`,
      ConditionExpression: conds.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ...values, ':now': now.toISOString(), ':by': AUDIT_USER },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: 1 };
    throw err;
  }
  await doc.send(new PutCommand({
    TableName: `AuditLog-${suffix}`,
    Item: {
      id: randomUUID(), __typename: 'AuditLog', entityType: 'CUSTOMER', entityId: entry.customer.id, action: AUDIT_ACTION, user: AUDIT_USER,
      changes: JSON.stringify({ aljexCode: entry.customer.aljexCode ?? null, previous: Object.fromEntries(entry.writes.map((w) => [w.field, w.from ?? null])), next: Object.fromEntries(entry.writes.map((w) => [w.field, w.to])), reasons: entry.writes.map((w) => w.reason) }),
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    },
  }));
  return { written: 1, lost: 0 };
}

const checkpointPath = (suffix) => join(homedir(), 'bcat-ops-backups', `aw-customer-billing-${suffix}.checkpoint.json`);
const loadCheckpoint = (p) => (existsSync(p) ? new Set(JSON.parse(readFileSync(p, 'utf8')).done ?? []) : new Set());
const saveCheckpoint = (p, done) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }), { mode: 0o600 }); };

async function main() {
  const { values } = parseArgs({ options: { export: { type: 'string' }, 'report-dir': { type: 'string' }, apply: { type: 'boolean' }, suffix: { type: 'string' }, ...PROD_GATE_OPTIONS } });
  if (!values.export) throw new Error('Usage: node scripts/awCustomerBilling.mjs --export <customers-invoice-email.csv> [--apply] [--target prod --i-mean-production ...]');
  const gate = await billingGate(values);
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const reportDir = values['report-dir'] ?? join(homedir(), 'aljex-export', 'reports');
  const today = localDate(new Date());

  const rows = await readExport(values.export);
  const customers = await scanAll(doc, `Customer-${suffix}`, ['id', 'name', 'aljexCode', 'billingMethod', 'apEmail', 'paymentTermsDays', 'active', 'mergedIntoId']);
  const { plans, live, toApply } = planAll(customers, rows);
  const fieldCount = count(toApply.flatMap((p) => p.writes), (w) => `${w.field}:${w.reason}`);
  console.log(`export rows ${rows.length}; production customers ${customers.length} (live ${live.length}); matched by name ${plans.filter((p) => p.inFile).length}`);
  console.log(`TO APPLY: ${toApply.length} customers; writes ${JSON.stringify(fieldCount)}`);
  console.log(`notes ${JSON.stringify(count(plans.flatMap((p) => p.notes.map((n) => n.split(':')[0])), (n) => n))}`);
  const stillUnset = live.filter((c) => !c.billingMethod && !toApply.find((p) => p.customer.id === c.id)?.writes.some((w) => w.field === 'billingMethod'));
  console.log(`customers STILL without a billing method after this run: ${stillUnset.length}`);

  const f = (name) => join(reportDir, `${name}-${today}.csv`);
  writeCsv(f('customer-billing-to-apply'), ['customer', 'aljexCode', 'field', 'from', 'to', 'reason'], toApply.flatMap((p) => p.writes.map((w) => [p.customer.name ?? '', p.customer.aljexCode ?? '', w.field, w.from ?? '', w.to, w.reason])));
  writeCsv(f('customer-billing-notes'), ['customer', 'aljexCode', 'note'], plans.flatMap((p) => p.notes.map((n) => [p.customer.name ?? '', p.customer.aljexCode ?? '', n])));
  writeCsv(f('customer-billing-still-unset'), ['customer', 'aljexCode', 'in export file'], stillUnset.map((c) => [c.name ?? '', c.aljexCode ?? '', plans.find((p) => p.customer.id === c.id)?.inFile ? 'yes' : 'no']));
  console.log(`reports written to ${reportDir} (0600): customer-billing-to-apply, customer-billing-notes, customer-billing-still-unset (${today})`);

  if (!apply) return console.log(`DRY RUN: nothing written. ${toApply.length} customer(s) would change.`);
  const cp = checkpointPath(suffix);
  const done = loadCheckpoint(cp);
  const out = { customers: 0, lost: 0, skippedDone: 0 };
  let n = 0;
  for (const entry of toApply) {
    if (done.has(entry.customer.id)) { out.skippedDone += 1; continue; }
    const r = await applyOne({ doc, suffix, entry });
    out.customers += r.written; out.lost += r.lost;
    done.add(entry.customer.id);
    if (++n % 25 === 0) saveCheckpoint(cp, done);
  }
  saveCheckpoint(cp, done);
  console.log('APPLIED', JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
