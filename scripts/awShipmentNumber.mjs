#!/usr/bin/env node
/**
 * Shipment numbering reset: new shipments start at 20000 (Ryne 2026-11-09, queue 53). Dry by default, prod-gated apply.
 *
 * Production's TmsSettings.nextShipmentNumber was seeded at 99001, so the first shipments created after the cutover got
 * 99002, 99003... This (1) renumbers every shipment created with a counter number >= 99002 (the cutover test load 99001 is
 * left alone) to 20000, 20001... in creation order, everywhere the number is stored (the same fields awRenumberL moves:
 * Shipment.number/searchKey, Load.loadNumber, and every table in awRenumberL FIELDS that carries the number), and
 * (2) sets TmsSettings.nextShipmentNumber to the LAST number issued (the atomic ADD returns the value it creates, so the
 * next new PRO is counter + 1), conditional on the counter still being what the dry run read.
 *
 * It reuses awRenumberL's verified export (rollback file), conditional transactional writes and audit rows, so
 *   node scripts/awRenumberL.mjs --rollback <export dir> --target prod ...      undoes the renumber (the counter is separate: below).
 *
 *   dry run (read-only; prints the plan, no names/PII):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awShipmentNumber.mjs --target prod --i-mean-production
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awShipmentNumber --target prod --i-mean-production --apply
 *   apply (typed token <date>-shipnumber):
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-shipnumber node scripts/awShipmentNumber.mjs \
 *       --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Run it when nobody is creating a shipment (it takes seconds); it re-reads everything at apply time, and a shipment created
 * after the apply simply gets the next counter number (20001...).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, DEV_SUFFIX, REGION, requireProd, localDate, isProductionSuffix } from './lib/prodGate.mjs';
import { FIELDS, MODELS, READ_MODELS, exportPlan, verifyExport, applyEntry } from './awRenumberL.mjs';

export const SCRIPT = 'awShipmentNumber';
export const START = 20000;
export const FIRST_COUNTER_NUMBER = 99002;
export const SETTINGS_MODELS = [...MODELS, 'TmsSettings'];

const isNumeric = (v) => /^\d+$/.test(String(v ?? '').trim());

/** Pure: which shipments get which new number, and the writes for each (same shape as awRenumberL entries). */
export function planNumbers(tables, { start = START, firstCounterNumber = FIRST_COUNTER_NUMBER } = {}) {
  const shipments = tables.Shipment ?? [];
  const taken = new Set(shipments.map((s) => String(s.number ?? '').trim()));
  for (const claim of tables.ProClaim ?? []) taken.add(String(claim.id ?? '').trim());
  const candidates = shipments
    .filter((s) => isNumeric(s.number) && Number(String(s.number).trim()) >= firstCounterNumber)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || Number(a.number) - Number(b.number));
  const entries = [];
  const counts = Object.fromEntries(READ_MODELS.map((m) => [m, 0]));
  let next = start;
  for (const s of candidates) {
    while (taken.has(String(next))) next += 1;
    const to = String(next);
    taken.add(to);
    next += 1;
    const from = String(s.number);
    const writes = [];
    for (const [model, fields] of Object.entries(FIELDS)) {
      for (const row of tables[model] ?? []) {
        if (model === 'Shipment' ? row.id !== s.id : row.shipmentId !== s.id) continue;
        const before = {};
        const after = {};
        for (const field of fields) {
          const old = row[field];
          if (typeof old !== 'string') continue;
          let value = old;
          if (model === 'Shipment' && field === 'number') value = to;
          else if (field === 'searchKey') value = old.split(from.toLowerCase()).join(to);
          else if (old === from || old.trim() === from.trim()) value = to;
          else if (field === 'loadNumber' && old.startsWith(`${from}-`)) value = to + old.slice(from.length);
          if (value !== old) { before[field] = old; after[field] = value; }
        }
        if (Object.keys(after).length) { writes.push({ model, id: row.id, row, before, after }); counts[model] += 1; }
      }
    }
    entries.push({ id: s.id, old: from, next: to, writes });
  }
  const lastIssued = entries.length ? Number(entries[entries.length - 1].next) : start - 1;
  return { entries, summary: { shipments: entries.length, start, assigned: entries.map((e) => `${e.old}->${e.next}`), counterAfter: lastIssued, counts } };
}

export async function numberGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: SETTINGS_MODELS, deps });
  if (gate?.apply && (deps.env ?? process.env).AW_PROD_CONFIRM !== `${localDate(deps.now ?? new Date())}-shipnumber`) {
    throw new Error('AW_PROD_CONFIRM must be <today>-shipnumber');
  }
  return gate;
}

async function scan(doc, table) {
  const rows = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, ConsistentRead: true }));
    rows.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return rows;
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, suffix: { type: 'string' }, 'export-dir': { type: 'string' }, ...PROD_GATE_OPTIONS } });
  const gate = await numberGate(values);
  const suffix = gate?.suffix ?? values.suffix ?? DEV_SUFFIX;
  if (!gate && isProductionSuffix(suffix)) throw new Error('Production requires --target prod');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const tables = {};
  for (const model of [...READ_MODELS, 'ProClaim']) tables[model] = await scan(doc, `${model}-${suffix}`);
  const settings = (await doc.send(new GetCommand({ TableName: `TmsSettings-${suffix}`, Key: { id: 'default' }, ConsistentRead: true }))).Item;
  const counterNow = Number(settings?.nextShipmentNumber ?? 0);
  const plan = planNumbers(tables);
  console.log(`counter now ${counterNow}; shipments to renumber ${plan.summary.shipments}: ${plan.summary.assigned.join(', ') || '(none)'}`);
  console.log(`rows changed per table ${JSON.stringify(plan.summary.counts)}`);
  console.log(`counter after ${plan.summary.counterAfter} (the next new shipment gets ${plan.summary.counterAfter + 1})`);
  if (counterNow < FIRST_COUNTER_NUMBER - 1 && plan.summary.shipments === 0) console.log('Counter is already below the 99xxx range: nothing to do.');
  if (!values.apply) return console.log('DRY RUN: nothing written.');
  const dir = values['export-dir'] ?? join(homedir(), 'bcat-ops-backups', `pre-shipment-number-${localDate(new Date())}`);
  if (plan.entries.length) {
    const saved = exportPlan(dir, plan, suffix);
    for (const entry of verifyExport(dir, suffix).entries) await applyEntry(doc, suffix, entry, false);
    console.log(`RENUMBERED ${saved.entries.length} shipment(s); export (rollback) in ${dir}`);
  }
  if (counterNow !== plan.summary.counterAfter) {
    await doc.send(new UpdateCommand({
      TableName: `TmsSettings-${suffix}`,
      Key: { id: 'default' },
      UpdateExpression: 'SET nextShipmentNumber = :n, updatedAt = :now, updatedBy = :by',
      ConditionExpression: 'nextShipmentNumber = :old',
      ExpressionAttributeValues: { ':n': plan.summary.counterAfter, ':old': counterNow, ':now': new Date().toISOString(), ':by': 'system:awShipmentNumber' },
    }));
  }
  console.log(`COUNTER set to ${plan.summary.counterAfter}: the next new shipment gets ${plan.summary.counterAfter + 1}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
