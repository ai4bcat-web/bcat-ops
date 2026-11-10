#!/usr/bin/env node
/**
 * Make every DORMANT customer ACTIVE, except possible duplicates (Ryne 2026-11-10). Dry by default, prod-gated apply. Writes ONLY
 * Customer.status (+ updatedAt/updatedBy) for rows whose stored status is DORMANT, and one AuditLog row each. A customer that shares a
 * normalised name with a customer of a DIFFERENT Aljex account (the app's "Possible duplicate" rule, src/lib/customerDuplicates.ts) is left
 * DORMANT and listed, so nothing that is about to be merged is switched on. Merged-away customers are never touched.
 *
 *   dry run:  BCAT_ALLOW_PROD=$(date +%F) node scripts/awCustomersActivate.mjs --target prod --i-mean-production
 *   backup:   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awCustomersActivate --target prod --i-mean-production --apply
 *   apply:    BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-customersactivate node scripts/awCustomersActivate.mjs --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';

export const SCRIPT = 'awCustomersActivate';

const SUFFIX_TOKENS = new Set(['inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company', 'plc']);

/** Same rule as normalizeCustomerName in src/lib/customerDuplicates.ts (keep in step). */
export function normalizeName(name) {
  const base = String(name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[.']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = base.split(' ').filter(Boolean);
  if (tokens[0] === 'the' && tokens.length > 1) tokens.shift();
  while (tokens.length > 1 && SUFFIX_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

const accountKey = (c) => (String(c.aljexCode ?? '').trim() ? `acct:${String(c.aljexCode).trim()}` : `id:${c.id}`);

/** Ids of customers that share a normalised name with a customer of a different account. Merged-away rows are ignored. */
export function duplicateIds(customers) {
  const groups = new Map();
  for (const c of customers) {
    if (c.mergedIntoId) continue;
    const key = normalizeName(c.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = new Set();
  for (const members of groups.values()) {
    if (members.length < 2 || new Set(members.map(accountKey)).size < 2) continue;
    for (const m of members) out.add(m.id);
  }
  return out;
}

/** Pure: who to activate and who to leave (stored DORMANT only; duplicates and merged-away rows stay as they are). */
export function planActivation(customers) {
  const dup = duplicateIds(customers);
  const dormant = customers.filter((c) => c.status === 'DORMANT' && !c.mergedIntoId);
  return { activate: dormant.filter((c) => !dup.has(c.id)), keptAsDuplicate: dormant.filter((c) => dup.has(c.id)) };
}

export async function activateGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models, deps });
  if (gate?.apply && !gate.rehearsal && (deps.env ?? process.env).AW_PROD_CONFIRM !== `${localDate(deps.now ?? new Date())}-customersactivate`) {
    throw new Error('AW_PROD_CONFIRM must be <today>-customersactivate');
  }
  return gate;
}

async function scanAll(doc, table) {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: key }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, ...PROD_GATE_OPTIONS } });
  const gate = await activateGate(values);
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const apply = values.apply === true && (gate ? gate.apply : true);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const customers = await scanAll(doc, `Customer-${suffix}`);
  const { activate, keptAsDuplicate } = planActivation(customers);
  console.log(`customers ${customers.length}; stored DORMANT ${activate.length + keptAsDuplicate.length}`);
  console.log(`to activate: ${activate.length}`);
  console.log(`left DORMANT as possible duplicates: ${keptAsDuplicate.length}${keptAsDuplicate.length ? `\n  ${keptAsDuplicate.map((c) => `${c.name} (${c.aljexCode ?? c.id})`).join('\n  ')}` : ''}`);
  if (!apply) return console.log('DRY RUN: nothing written.');
  assertWritableSuffix(suffix, 'customers');
  const now = new Date().toISOString();
  let done = 0;
  for (const c of activate) {
    try {
      await doc.send(new UpdateCommand({
        TableName: `Customer-${suffix}`, Key: { id: c.id },
        UpdateExpression: 'SET #s = :a, updatedAt = :now, updatedBy = :by',
        ConditionExpression: '#s = :d',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':a': 'ACTIVE', ':d': 'DORMANT', ':now': now, ':by': `system:${SCRIPT}` },
      }));
      await doc.send(new PutCommand({ TableName: `AuditLog-${suffix}`, Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'CUSTOMER', entityId: c.id, action: 'AW_CUSTOMERS_ACTIVATE', user: `system:${SCRIPT}`, changes: JSON.stringify({ status: { from: 'DORMANT', to: 'ACTIVE' } }), createdAt: now, updatedAt: now } }));
      done += 1;
    } catch (e) {
      if (e?.name !== 'ConditionalCheckFailedException') throw e;
    }
  }
  console.log(`ACTIVATED ${done} of ${activate.length} (the rest changed status while the script ran)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
