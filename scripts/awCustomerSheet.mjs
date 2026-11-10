#!/usr/bin/env node
/**
 * Customer list sheet -> billing method, invoice e-mail and address (Ryne 2026-11-10). Dry by default, prod-gated apply.
 * Rules: scripts/lib/customerSheetPlan.mjs. The sheet is first turned into ~/aljex-export/customer-sheet-2026-11-10.json (Name, address, e-mails).
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awCustomerSheet.mjs --target prod --i-mean-production --sheet ~/aljex-export/customer-sheet-2026-11-10.json
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awCustomerSheet --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-customersheet node scripts/awCustomerSheet.mjs <same args> --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Writes ONLY Customer.billingMethod / apEmail / billingAddress (address only while the customer has none), one conditional UpdateItem per
 * customer (billingMethod and apEmail must still hold what the plan read) + one AuditLog row with the previous values. Sends nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { planSheet } from './lib/customerSheetPlan.mjs';

export const SCRIPT = 'awCustomerSheet';
export const AUDIT_ACTION = 'AW_CUSTOMER_SHEET';
export const WRITABLE = ['billingMethod', 'apEmail', 'billingAddress'];

export async function sheetGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models, deps });
  if (gate?.apply && !gate.rehearsal && (deps.env ?? process.env).AW_PROD_CONFIRM !== `${localDate(deps.now ?? new Date())}-customersheet`) {
    throw new Error('AW_PROD_CONFIRM must be <today>-customersheet');
  }
  return gate;
}

async function scanAll(doc, table, projection) {
  const items = []; let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: table, ConsistentRead: true, ExclusiveStartKey: key,
      ProjectionExpression: projection.map((_, i) => `#p${i}`).join(','),
      ExpressionAttributeNames: Object.fromEntries(projection.map((p, i) => [`#p${i}`, p])),
    }));
    items.push(...(r.Items ?? [])); key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

const jsonOf = (v) => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return null; } };
const csv = (cells) => cells.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',');

export async function applyEntry({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'customer sheet');
  const names = {};
  const values = { ':now': now.toISOString() };
  const sets = ['updatedAt = :now'];
  const conds = ['attribute_exists(id)'];
  const emptyCond = (f) => `(attribute_not_exists(#${f}) OR #${f} = :blank OR attribute_type(#${f}, :nul))`;
  let needsEmptyConsts = false;
  for (const field of Object.keys(entry.set)) {
    if (!WRITABLE.includes(field)) throw new Error(`refusing to write Customer.${field}`);
    names[`#${field}`] = field;
    values[`:${field}`] = entry.set[field];
    sets.push(`#${field} = :${field}`);
    if (field === 'billingAddress') {
      conds.push(`(attribute_not_exists(#${field}) OR attribute_type(#${field}, :nul))`);
      values[':nul'] = 'NULL';
    } else {
      const was = entry.customer[field];
      if (was == null || was === '') { conds.push(emptyCond(field)); needsEmptyConsts = true; }
      else { conds.push(`#${field} = :was_${field}`); values[`:was_${field}`] = was; }
    }
  }
  if (needsEmptyConsts) { values[':blank'] = ''; values[':nul'] = 'NULL'; }
  try {
    await doc.send(new UpdateCommand({
      TableName: `Customer-${suffix}`, Key: { id: entry.customer.id }, UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: conds.join(' AND '), ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: 1 };
    throw err;
  }
  await doc.send(new PutCommand({
    TableName: `AuditLog-${suffix}`,
    Item: {
      id: randomUUID(), __typename: 'AuditLog', entityType: 'CUSTOMER', entityId: entry.customer.id, action: AUDIT_ACTION, user: `system:${SCRIPT}`,
      changes: JSON.stringify({ kind: entry.kind, how: entry.how, previous: { billingMethod: entry.customer.billingMethod ?? null, apEmail: entry.customer.apEmail ?? null, billingAddress: entry.customer.billingAddress ?? null }, next: entry.set }),
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    },
  }));
  return { written: 1, lost: 0 };
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, sheet: { type: 'string' }, 'report-dir': { type: 'string' }, ...PROD_GATE_OPTIONS } });
  if (!values.sheet) throw new Error('--sheet <customer-sheet.json> is required');
  const gate = await sheetGate(values);
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const sheet = JSON.parse(readFileSync(values.sheet.replace(/^~/, homedir()), 'utf8'));
  const customers = (await scanAll(doc, `Customer-${suffix}`, ['id', 'name', 'billingMethod', 'apEmail', 'billingAddress', 'mergedIntoId'])).map((c) => ({ ...c, billingAddress: jsonOf(c.billingAddress) }));
  const plan = planSheet(sheet, customers);
  const tally = {}; for (const e of plan.entries) tally[e.kind] = (tally[e.kind] ?? 0) + 1;
  const addr = plan.entries.filter((e) => e.set.billingAddress).length;
  console.log(`sheet rows ${sheet.length}; customers ${customers.length}; to update ${plan.entries.length} ${JSON.stringify(tally)} (address filled on ${addr}); unmatched ${plan.unmatched.length}; ambiguous ${plan.ambiguous.length}; blank e-mail left for Ryne ${plan.blankKept.length}`);
  const dir = (values['report-dir'] ?? join(homedir(), 'aljex-export', 'reports')).replace(/^~/, homedir());
  mkdirSync(dir, { recursive: true });
  const day = localDate(new Date());
  const out = (name, lines) => { const p = join(dir, `${name}-${day}.csv`); writeFileSync(p, `${lines.join('\n')}\n`, { mode: 0o600 }); chmodSync(p, 0o600); return p; };
  out('customersheet-to-apply', ['customer,kind,how,billingMethod,apEmail,address'].concat(plan.entries.map((e) => csv([e.customer.name, e.kind, e.how, e.set.billingMethod ?? '', e.set.apEmail ?? '', e.set.billingAddress ? 'yes' : '']))));
  out('customersheet-unmatched', ['sheet name,e-billing e-mail'].concat([...plan.unmatched, ...plan.ambiguous].map((r) => csv([r.name, (r.emails ?? []).join('; ')]))));
  out('customersheet-blank-email', ['customer,current method'].concat(plan.blankKept.map((b) => csv([b.customer.name, b.customer.billingMethod ?? '']))));
  console.log(`reports in ${dir}`);
  if (!apply) return console.log('DRY RUN: nothing written.');
  let written = 0; let lost = 0;
  for (const entry of plan.entries) { const r = await applyEntry({ doc, suffix, entry }); written += r.written; lost += r.lost; }
  console.log(`APPLIED ${written} customer(s); lost races ${lost}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
