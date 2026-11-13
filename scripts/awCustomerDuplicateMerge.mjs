#!/usr/bin/env node
/**
 * Merge the customers the Customers page flags as "Possible duplicate" into one surviving account per name
 * (Ryne 2026-11-12). Dry run by default, prod-gated apply.
 *
 *   dry run (read-only; prints the plan and writes the markdown report, mode 0600):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awCustomerDuplicateMerge.mjs --target prod --i-mean-production [--report-file <md>]
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awCustomerDuplicateMerge --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-custmerge node scripts/awCustomerDuplicateMerge.mjs \
 *       --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Grouping and merging are the app's own code, bundled from TypeScript with esbuild:
 *   - src/lib/customerDuplicates.ts buildDuplicateIndex (the page's "Possible duplicates" filter, over active customers)
 *   - amplify/functions/tms-directory-actions/customerDelete.ts mergeCustomer (MERGE_CUSTOMER): every customerId pointer
 *     moves to the survivor (invoice/payment content untouched), addresses/contacts/aliases carried over, AuditLog
 *     MERGE_CUSTOMER_START snapshot of source + target before anything moves, the source deleted last.
 * Survivor and skip rules: scripts/lib/customerDupMergePlan.mjs. The merge is idempotent and resumable (mergedIntoId
 * marks a started merge; every repoint is conditional), so a re-run finishes whatever an interrupted run left.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { planDuplicateMerges } from './lib/customerDupMergePlan.mjs';

export const SCRIPT = 'awCustomerDuplicateMerge';
export const AUDIT_USER = 'system:awCustomerDuplicateMerge';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export async function bundleMergeCore() {
  const outDir = join(root, 'node_modules/.cache/aw-customer-merge');
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `core-${Date.now()}.mjs`);
  await build({ entryPoints: [join(here, 'lib/customerMergeEntry.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}

export async function customerMergeGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS[SCRIPT].models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-custmerge`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
  }
  return gate;
}

async function scanAll(doc, table) {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
    rows.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

async function queryAll(doc, table, index, key, value) {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await doc.send(new QueryCommand({ TableName: table, IndexName: index, KeyConditionExpression: '#k = :v', ExpressionAttributeNames: { '#k': key }, ExpressionAttributeValues: { ':v': value }, ExclusiveStartKey }));
    rows.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

/**
 * DeleteDeps for mergeCustomer, backed by DynamoDB. Full-table scans are cached per table and kept in step with
 * this run's own writes (the merge rescans the same tables for every customer); queries always go to the table.
 * `write=false` makes every write throw, so a dry run cannot write by accident.
 */
export function dynamoMergeDeps({ doc, suffix, write }) {
  const cache = new Map();
  const T = (m) => `${m}-${suffix}`;
  const guard = (what) => {
    if (!write) throw new Error(`dry run: refusing ${what}`);
    assertWritableSuffix(suffix, 'customer duplicate merge');
  };
  return {
    tableOf: T,
    get: async (table, id) => (await doc.send(new GetCommand({ TableName: table, Key: { id }, ConsistentRead: true }))).Item ?? null,
    queryIndex: (table, index, key, value) => queryAll(doc, table, index, key, value),
    scan: async (table) => {
      if (!cache.has(table)) cache.set(table, await scanAll(doc, table));
      return cache.get(table);
    },
    updateIf: async (table, id, set, field, expected) => {
      guard(`an update of ${table}`);
      const names = { '#cf': field };
      const values = {};
      const parts = Object.entries(set).map(([k, v], i) => {
        names[`#f${i}`] = k;
        values[`:v${i}`] = v === undefined ? null : v;
        return `#f${i} = :v${i}`;
      });
      let cond = 'attribute_exists(id) AND ';
      if (expected == null) { cond += '(attribute_not_exists(#cf) OR #cf = :nullv)'; values[':nullv'] = null; } else { cond += '#cf = :cv'; values[':cv'] = expected; }
      try {
        await doc.send(new UpdateCommand({ TableName: table, Key: { id }, UpdateExpression: `SET ${parts.join(', ')}`, ConditionExpression: cond, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
      const row = cache.get(table)?.find((r) => r.id === id);
      if (row) Object.assign(row, set);
      return true;
    },
    remove: async (table, id) => {
      guard(`a delete from ${table}`);
      await doc.send(new DeleteCommand({ TableName: table, Key: { id } }));
      const rows = cache.get(table);
      if (rows) cache.set(table, rows.filter((r) => r.id !== id));
    },
    audit: async (entityId, action, changes) => {
      guard('an AuditLog write');
      const now = new Date().toISOString();
      await doc.send(new PutCommand({ TableName: T('AuditLog'), Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'Customer', entityId, action, user: AUDIT_USER, changes: JSON.stringify(changes), createdAt: now, updatedAt: now } }));
    },
    now: () => new Date().toISOString(),
  };
}

const esc = (v) => String(v ?? '').replace(/\|/g, '\\|');

export function renderPlan({ plan, counts, suffix, today, results }) {
  const line = (c) => {
    const n = counts.get(c.id) ?? { shipments: 0, invoices: 0 };
    return `${esc(c.name)} \`${c.id}\` (Aljex ${esc(c.aljexCode || '—')}; ${c.status || 'no status'}; ${n.shipments} shipments, ${n.invoices} invoices)`;
  };
  const merges = plan.clusters.filter((c) => !c.skip);
  const skips = plan.clusters.filter((c) => c.skip);
  const out = [
    `# Customer duplicate merge — ${today}`,
    '',
    `Stack \`${suffix}\`. Customers flagged "Possible duplicate": **${plan.flaggedCount}** in **${plan.clusters.length}** name groups.`,
    `To merge: **${merges.length}** groups (${merges.reduce((n, c) => n + c.sources.length, 0)} customers merged away). Skipped for review: **${skips.length}** groups.`,
    '',
    '## Merges (survivor ← merged in)',
    '',
  ];
  for (const c of merges) {
    out.push(`- **${line(c.survivor)}**`);
    for (const s of c.sources) {
      const r = results?.get(s.id);
      out.push(`  - ← ${line(s)}${r ? ` — ${r}` : ''}`);
    }
  }
  out.push('', '## Skipped (left for a person)', '');
  if (!skips.length) out.push('_none_');
  for (const c of skips) {
    out.push(`- **${esc(c.key)}**: ${c.skip}`);
    for (const m of c.members) out.push(`  - ${line(m)}`);
  }
  return `${out.join('\n')}\n`;
}

function writePrivate(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function main() {
  const { values } = parseArgs({
    options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, 'report-file': { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Usage: node scripts/awCustomerDuplicateMerge.mjs [--report-file <md>] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply.`);
    return;
  }
  const gate = await customerMergeGate({ ...values, apply: values.apply });
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const core = await bundleMergeCore();
  const today = localDate(new Date());

  const customers = await scanAll(doc, `Customer-${suffix}`);
  const flaggedIds = new Set([...core.buildDuplicateIndex(customers.filter((c) => c.active !== false)).keys()]);
  const counts = new Map();
  for (const id of flaggedIds) {
    const shipments = (await queryAll(doc, `Shipment-${suffix}`, 'shipmentsByCustomerIdAndPickupAppt', 'customerId', id)).length;
    const invoices = (await queryAll(doc, `Invoice-${suffix}`, 'invoicesByCustomerIdAndIssuedAt', 'customerId', id)).length;
    counts.set(id, { shipments, invoices });
  }
  const plan = planDuplicateMerges({ customers, buildDuplicateIndex: core.buildDuplicateIndex, normalize: core.normalizeCustomerName, counts: (id) => counts.get(id) });
  const md = values['report-file'] ?? `/private/tmp/customer-merge-plan-${today}.md`;
  writePrivate(md, renderPlan({ plan, counts, suffix, today }));
  const merges = plan.clusters.filter((c) => !c.skip);
  console.log(`flagged ${plan.flaggedCount} in ${plan.clusters.length} groups; merge ${merges.length} groups (${merges.reduce((n, c) => n + c.sources.length, 0)} sources); skip ${plan.clusters.length - merges.length}; report ${md}`);
  if (!apply) { console.log('DRY RUN: nothing written.'); return; }

  const deps = dynamoMergeDeps({ doc, suffix, write: true });
  const results = new Map();
  for (const c of merges) {
    for (const s of c.sources) {
      let res;
      for (let attempt = 1; attempt <= 6; attempt++) {
        res = await core.mergeCustomer(deps, s.id, c.survivor.id, s.name);
        if (res.status === 'DONE') break;
        await new Promise((r) => setTimeout(r, 2000 * attempt)); // GSI catch-up before the "nothing left" check
      }
      const moved = Object.entries(res.moved).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing linked';
      results.set(s.id, `${res.status}: ${moved}`);
      console.log(`${res.status}  ${s.name} (${s.id}) -> ${c.survivor.name} (${c.survivor.id})  ${moved}`);
    }
  }
  writePrivate(md, renderPlan({ plan, counts, suffix, today, results }));
  console.log(`APPLIED. report ${md}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
}
