#!/usr/bin/env node
// Dry by default. --apply and --rollback use the same production gate and verified export.
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, TransactWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, requireProd, localDate, isProductionSuffix, assertWritableSuffix } from './lib/prodGate.mjs';
export const FIELDS = { Shipment: ['number', 'searchKey'], Load: ['loadNumber'], Invoice: ['shipmentNumber'], CarrierBill: ['shipmentNumber', 'loadNumber'], SpotRequest: ['shipmentNumber'], WorkflowRun: ['shipmentNumber'], IntakeLoad: ['shipmentNumber'], TrackingLink: ['shipmentNumber'], Quote: ['shipmentNumber', 'loadNumber'], LaneRateSample: ['shipmentNumber'], Commission: ['shipmentNumber'] };

import { register } from 'node:module';
register('./lib/tsExtensionlessHooks.mjs', import.meta.url);
const { parseLegacyShipmentNumber, digitsOnlyPro } = await import('../src/lib/legacyShipmentNumber.ts');
export const MODELS = [...Object.keys(FIELDS), 'AuditLog'];
export const READ_MODELS = [...Object.keys(FIELDS), 'Order', 'ProClaim', 'LegacyAljexRow', 'LoadCarrier', 'LoadCharge', 'ArPayment', 'ApPayment', 'ShipmentDocument', 'ShipmentMessage'];
const hash = (s) => createHash('sha256').update(s).digest('hex');
const encode = (v) => JSON.stringify(v, (_k, x) => x instanceof Set ? { __set: [...x] } : x);
const decode = (s) => JSON.parse(s, (_k, x) => x && Object.keys(x).length === 1 && Array.isArray(x.__set) ? new Set(x.__set) : x);

export function planRenumber(tables) {
  const entries = []; const kinds = {}; let collisions = 0; let duplicates = 0;
  const shipments = tables.Shipment ?? [];
  const selected = shipments.map((s) => ({ s, parsed: parseLegacyShipmentNumber(s.number) })).filter((x) => x.parsed);
  const counts = Object.fromEntries(READ_MODELS.map((m) => [m, 0]));
  for (const { s, parsed } of selected) {
    kinds[parsed.kind] = (kinds[parsed.kind] ?? 0) + 1;
    const loads = (tables.Load ?? []).filter((l) => l.shipmentId === s.id);
    if (!loads.length || !loads.some((l) => digitsOnlyPro(l.aljexId) === parsed.digits)) throw new Error('Shipment/Load PRO identity mismatch');
    if (shipments.some((other) => other.id !== s.id && String(other.number).trim() === parsed.digits)) collisions++;
    if (selected.some((other) => other.s.id !== s.id && other.parsed.digits === parsed.digits)) duplicates++;
    for (const claim of tables.ProClaim ?? []) {
      if (claim.shipmentId === s.id && parseLegacyShipmentNumber(claim.id)) throw new Error('ProClaim primary key needs re-key; STOP');
      if (claim.id === parsed.digits && claim.shipmentId && claim.shipmentId !== s.id) throw new Error('PRO claim belongs to another shipment');
    }
    const writes = [];
    for (const [model, fields] of Object.entries(FIELDS)) {
      for (const row of tables[model] ?? []) {
        if (model === 'Shipment' ? row.id !== s.id : row.shipmentId !== s.id) continue;
        const before = {}; const after = {};
        for (const field of fields) {
          const old = row[field]; if (typeof old !== 'string') continue;
          let value = old;
          if (model === 'Shipment' && field === 'number') value = parsed.digits;
          else if (field === 'searchKey') value = old.split(s.number.toLowerCase()).join(parsed.digits);
          else if (old === s.number || old.trim() === s.number.trim()) value = parsed.digits;
          else if (field === 'loadNumber' && old.startsWith(`${s.number}-`)) value = parsed.digits + old.slice(s.number.length);
          if (value !== old) { before[field] = old; after[field] = value; }
        }
        if (Object.keys(after).length) { writes.push({ model, id: row.id, row, before, after }); counts[model]++; }
      }
    }
    if (writes.length > 99) throw new Error('Shipment exceeds atomic transaction limit; refusing');
    entries.push({ id: s.id, old: s.number, next: parsed.digits, writes });
  }
  return { entries, summary: { shipments: entries.length, kinds, collisions, duplicates, counts } };
}

export function verifyExport(dir, suffix) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.script !== 'awRenumberL' || manifest.suffix !== suffix) throw new Error('Wrong export script/target');
  const entries = [];
  for (const [name, meta] of Object.entries(manifest.files)) {
    if (name !== 'before.jsonl') throw new Error('Unexpected manifest path');
    const text = readFileSync(join(dir, name), 'utf8');
    if (hash(text) !== meta.sha256) throw new Error('Export checksum mismatch');
    const rows = text.trim() ? text.trimEnd().split('\n').map(decode) : [];
    if (rows.length !== meta.count) throw new Error('Export count mismatch');
    entries.push(...rows);
  }
  if (!manifest.files['before.jsonl']) throw new Error('Missing export');
  for (const e of entries) for (const w of e.writes) {
    if (!FIELDS[w.model] || !w.id || w.row.id !== w.id || Object.keys(w.after).some((f) => !FIELDS[w.model].includes(f) || w.before[f] !== w.row[f])) throw new Error('Invalid export write');
  }
  return { entries, manifest };
}

export function exportPlan(dir, plan, suffix) {
  if (existsSync(join(dir, 'manifest.json'))) throw new Error('Export exists: use --resume <dir>');
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  if (readdirSync(dir).length) throw new Error('Export directory is not empty');
  const text = plan.entries.map(encode).join('\n') + (plan.entries.length ? '\n' : '');
  writeFileSync(join(dir, 'before.jsonl'), text, { mode: 0o600 });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ script: 'awRenumberL', suffix, createdAt: new Date().toISOString(), summary: plan.summary, files: { 'before.jsonl': { count: plan.entries.length, sha256: hash(text) } } }), { mode: 0o600 });
  return verifyExport(dir, suffix);
}

export async function applyEntry(doc, suffix, entry, rollback = false) {
  assertWritableSuffix(suffix, 'renumber');
  const direction = rollback ? 'ROLLBACK' : 'APPLY';
  const auditId = `awRenumberL:${direction}:${hash(encode([entry.id, entry.old, entry.next])).slice(0, 32)}`;
  const auditTable = `AuditLog-${suffix}`;
  if ((await doc.send(new GetCommand({ TableName: auditTable, Key: { id: auditId }, ConsistentRead: true }))).Item) {
    for (const w of entry.writes) {
      const row = (await doc.send(new GetCommand({ TableName: `${w.model}-${suffix}`, Key: { id: w.id }, ConsistentRead: true }))).Item;
      if (Object.entries(rollback ? w.before : w.after).some(([f, value]) => row?.[f] !== value)) throw new Error('Completed migration has since changed or rolled back; refusing stale resume');
    }
    return 'already-done';
  }
  const tx = entry.writes.map((w) => {
    const from = rollback ? w.after : w.before; const to = rollback ? w.before : w.after;
    const fields = Object.keys(to); const names = {}; const values = {};
    fields.forEach((f, i) => { names[`#f${i}`] = f; values[`:old${i}`] = from[f]; values[`:new${i}`] = to[f]; });
    return { Update: { TableName: `${w.model}-${suffix}`, Key: { id: w.id }, UpdateExpression: `SET ${fields.map((_, i) => `#f${i} = :new${i}`).join(', ')}`, ConditionExpression: `attribute_exists(id) AND ${fields.map((_, i) => `#f${i} = :old${i}`).join(' AND ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values } };
  });
  const at = new Date().toISOString();
  tx.push({ Put: { TableName: auditTable, Item: { id: auditId, __typename: 'AuditLog', entityType: 'SHIPMENT', entityId: entry.id, action: `AW_RENUMBER_L_${direction}`, user: 'system:awRenumberL', changes: JSON.stringify({ old: rollback ? entry.next : entry.old, next: rollback ? entry.old : entry.next }), createdAt: at, updatedAt: at }, ConditionExpression: 'attribute_not_exists(id)' } });
  await doc.send(new TransactWriteCommand({ TransactItems: tx }));
  return 'written';
}

export async function renumberGate(values, deps = {}) {
  const gate = await requireProd({ script: 'awRenumberL', values, tables: MODELS, deps });
  if (gate?.apply && (deps.env ?? process.env).AW_PROD_CONFIRM !== `${localDate(deps.now ?? new Date())}-renumber`) throw new Error('AW_PROD_CONFIRM must be <today>-renumber');
  return gate;
}
async function scan(doc, table) {
  const rows = []; let key;
  do { const r = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ConsistentRead: true })); rows.push(...(r.Items ?? [])); key = r.LastEvaluatedKey; } while (key);
  return rows;
}
async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, rollback: { type: 'string' }, resume: { type: 'string' }, 'export-dir': { type: 'string' }, suffix: { type: 'string' }, ...PROD_GATE_OPTIONS } });
  if (values.rollback && values.resume) throw new Error('Choose rollback or resume');
  const gate = await renumberGate(values); const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const raw = new DynamoDBClient({ region: REGION }); const doc = DynamoDBDocumentClient.from(raw);
  // GSI keys may change in place; primary keys may not. Check the deployed tables, not just the schema source.
  for (const model of MODELS) {
    const r = await raw.send(new DescribeTableCommand({ TableName: `${model}-${suffix}` }));
    if (r.Table.KeySchema.length !== 1 || r.Table.KeySchema[0].AttributeName !== 'id') throw new Error(`${model} primary key is not id: STOP`);
  }
  let dir = values.rollback ?? values.resume ?? values['export-dir'] ?? join(homedir(), 'bcat-ops-backups', 'pre-renumber-L');
  let saved;
  if (values.rollback || values.resume) saved = verifyExport(dir, suffix);
  else {
    const tables = {};
    for (const model of READ_MODELS) tables[model] = await scan(doc, `${model}-${suffix}`);
    const plan = planRenumber(tables); console.log(JSON.stringify(plan.summary));
    if (plan.summary.collisions || plan.summary.duplicates) throw new Error('Collision/duplicate: no writes allowed');
    if (!values.apply) return console.log('DRY RUN: no writes, no export of PII');
    saved = exportPlan(dir, plan, suffix);
  }
  console.log(`${values.rollback ? 'ROLLBACK' : 'RENUMBER'}: ${saved.entries.length} shipments`);
  if (!values.apply) return console.log('DRY RUN: no writes');
  const checkpoint = join(dir, values.rollback ? 'rollback.checkpoint.json' : 'apply.checkpoint.json');
  // Audit rows are the atomic checkpoint; this local checkpoint is a resumable progress record, not authority.
  const done = [];
  for (const entry of verifyExport(dir, suffix).entries) {
    await applyEntry(doc, suffix, entry, Boolean(values.rollback)); done.push(entry.id);
    writeFileSync(checkpoint, JSON.stringify({ done }), { mode: 0o600 });
  }
  console.log(`Completed ${done.length} shipments`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
