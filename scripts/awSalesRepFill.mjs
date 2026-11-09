#!/usr/bin/env node
/**
 * Sales rep on EVERY shipment that still has none (dry by default, prod-gated apply). ENRICH ONLY, last in the chain.
 *
 * After the file-based mapping (awEquipRep: Shipment.salesRepCode, awRepProfiles + awSalesRepId: profile ids) a shipment can
 * still carry neither salesRepCode nor salesRepId. This fills those from the Aljex "Salesrep ID" of the PRO
 * (aljex-full-export) with Ryne's id map (scripts/lib/salesRepFillPlan.mjs ID_MAP): 001 Ryne, 002 Ruben (2025+), 003 BCAT
 * (text only: there is no BCAT profile), 004 Jessy, 005 Ivan Cartage group, 007 Dillon, 008 Perla, 009 Brandon, 010 Jamey,
 * '10' Owner Operators group. Profile ids only for Ryne, Ruben and the two groups; everyone else stays TEXT in salesRepCode.
 * An id whose equipment-export evidence (Ship Date >= 2025) is < 95% pure, or whose dominant name differs, is NOT applied.
 * A PRO the equipment export names a rep for takes THAT name first (this is also what covers BCAT, which has no profile);
 * the id map is the fallback for PROs with no file row. Needs --export and --dir.
 *
 * Order of the gated chain (each its own backup + typed confirm):
 *   1 backfillUserProfiles   2 awRepProfiles   3 awEquipRep   4 awSalesRepId --export --dir   5 awSalesRepFill
 *
 *   dry run (read-only; counts on stdout, review CSVs mode 0600 in --report-dir):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awSalesRepFill.mjs --target prod --i-mean-production \
 *       --export ~/aljex-export/aljex-full-export-2026-11-07.csv --dir ~/aljex-export/shipments-eq
 *   PREVIEW before the profiles exist (ids from the backfill plan + the two group ids, labelled PREVIEW; never with --apply):
 *     ... --assume-profiles ~/aljex-export/reports/userprofiles-plan-2026-11-09.json
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awSalesRepFill --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-salesrepfill node scripts/awSalesRepFill.mjs \
 *       --target prod --i-mean-production --export <csv> --dir <dir> --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Writes ONLY while the shipment still has no salesRepCode AND no salesRepId and is not voided (one conditional UpdateItem
 * per shipment), Order.customerRepId only while empty, plus one AuditLog row per shipment with the previous (null) values.
 * Never a money/status field, notice or e-mail. Idempotent; checkpointed to ~/bcat-ops-backups/aw-sales-rep-fill-<suffix>.checkpoint.json.
 * PII: stdout carries counts and rep names only; ids go into the 0600 CSVs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { readFullExport, readSourceFile, scanAll, sourcePaths, writeCsv } from './awEquipRep.mjs';
import { indexExport, indexSources, inScope, shipmentKeys } from './lib/equipRepPlan.mjs';
import { profilesFromPlan } from './lib/salesRepPlan.mjs';
import { GROUP_IDS, ID_MAP, WRITABLE, countWrites, idEvidence, planSalesRepFill, tallyEntries, verifyIdMap } from './lib/salesRepFillPlan.mjs';

export const SCRIPT = 'awSalesRepFill';
export const AUDIT_ACTION = 'AW_SALES_REP_FILL';
export const AUDIT_USER = 'system:awSalesRepFill';

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function salesRepFillGate(values, deps = {}) {
  if (values.apply === true && values['assume-profiles']) {
    throw new Error(`${SCRIPT}: --assume-profiles is a PREVIEW (profile ids from a plan, not the table) and cannot be combined with --apply`);
  }
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awSalesRepFill.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-salesrepfill`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) {
      throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
    }
  }
  return gate;
}

const EMPTY = '(attribute_not_exists(#f) OR attribute_type(#f, :nul) OR #f = :blank)';

/** One shipment: ONE conditional Shipment update (both rep fields still empty, not voided), each Order only while empty, one AuditLog row. */
export async function applyOne({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'sales rep fill');
  const nowIso = now.toISOString();
  for (const w of entry.writes) if (!WRITABLE[w.table]?.includes(w.field)) throw new Error(`refusing to write ${w.table}.${w.field}`);
  const done = [];
  let lost = 0;
  const shipWrites = entry.writes.filter((w) => w.table === 'Shipment');
  if (shipWrites.length) {
    try {
      await doc.send(new UpdateCommand({
        TableName: `Shipment-${suffix}`,
        Key: { id: entry.shipment.id },
        UpdateExpression: `SET ${shipWrites.map((w) => `#${w.field} = :${w.field}`).join(', ')}`,
        ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(voidedAt) AND (attribute_not_exists(salesRepCode) OR attribute_type(salesRepCode, :nul) OR salesRepCode = :blank) AND (attribute_not_exists(salesRepId) OR attribute_type(salesRepId, :nul) OR salesRepId = :blank)',
        ExpressionAttributeNames: Object.fromEntries(shipWrites.map((w) => [`#${w.field}`, w.field])),
        ExpressionAttributeValues: { ':nul': 'NULL', ':blank': '', ...Object.fromEntries(shipWrites.map((w) => [`:${w.field}`, w.value])) },
      }));
      done.push(...shipWrites);
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') return { written: 0, lost: shipWrites.length }; // the shipment got a rep meanwhile: its orders are left alone too
      throw err;
    }
  }
  for (const w of entry.writes.filter((x) => x.table === 'Order')) {
    try {
      await doc.send(new UpdateCommand({
        TableName: `Order-${suffix}`,
        Key: { id: w.id },
        UpdateExpression: 'SET #f = :v',
        ConditionExpression: `attribute_exists(id) AND ${EMPTY}`,
        ExpressionAttributeNames: { '#f': w.field },
        ExpressionAttributeValues: { ':v': w.value, ':nul': 'NULL', ':blank': '' },
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
        id: randomUUID(), __typename: 'AuditLog', entityType: 'SHIPMENT', entityId: entry.shipment.id, action: AUDIT_ACTION, user: AUDIT_USER,
        changes: JSON.stringify({
          pro: entry.pro, source: entry.source, aljexSalesRepId: entry.repId, viaName: entry.target.name,
          previous: done.map((w) => ({ table: w.table, id: w.id, field: w.field, value: null })),
          next: done.map((w) => ({ table: w.table, id: w.id, field: w.field, value: w.value })),
        }),
        createdAt: nowIso, updatedAt: nowIso,
      },
    }));
  }
  return { written: done.length, lost };
}

const checkpointPath = (suffix) => join(homedir(), 'bcat-ops-backups', `aw-sales-rep-fill-${suffix}.checkpoint.json`);
const loadCheckpoint = (path) => (existsSync(path) ? new Set(JSON.parse(readFileSync(path, 'utf8')).done ?? []) : new Set());
const saveCheckpoint = (path, done) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }), { mode: 0o600 });
};
const hist = (items, keyOf) => { const o = {}; for (const i of items) { const k = keyOf(i); o[k] = (o[k] ?? 0) + 1; } return o; };

async function main() {
  const { values } = parseArgs({
    options: {
      export: { type: 'string' }, files: { type: 'string' }, dir: { type: 'string' }, 'assume-profiles': { type: 'string' }, 'report-dir': { type: 'string' },
      apply: { type: 'boolean' }, limit: { type: 'string' }, suffix: { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS,
    },
    allowPositionals: false,
  });
  const paths = sourcePaths({ files: values.files, dir: values.dir });
  if (values.help || !values.export || paths.length === 0) {
    console.log(`Usage: node scripts/awSalesRepFill.mjs --export <aljex-full-export.csv> (--files a.csv,b.csv | --dir <dir>) [--assume-profiles <backfillUserProfiles plan.json>] [--report-dir <dir>] [--limit N] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply. --assume-profiles is a preview only (refused with --apply).`);
    return;
  }
  const gate = await salesRepFillGate(values);
  let suffix;
  if (gate) suffix = gate.suffix;
  else {
    suffix = values.suffix ?? DEV_SUFFIX;
    if (isProductionSuffix(suffix)) throw new Error('Refusing production without --target prod and every production gate');
  }
  const apply = values.apply === true && gate !== null ? gate.apply : values.apply === true;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const T = (m) => `${m}-${suffix}`;
  const today = localDate(new Date());
  const reportDir = values['report-dir'] ?? join(homedir(), 'aljex-export', 'reports');

  const [exportRows, ...sourceFiles] = await Promise.all([readFullExport(values.export), ...paths.map(readSourceFile)]);
  const [shipments, loads, orders, claims, tableProfiles] = await Promise.all([
    scanAll(doc, T('Shipment'), ['id', 'number', 'voidedAt', 'salesRepCode', 'salesRepId', 'revDivision', 'revSubdivision']),
    scanAll(doc, T('Load'), ['id', 'shipmentId', 'aljexId']),
    scanAll(doc, T('Order'), ['id', 'shipmentId', 'customerRepId']),
    scanAll(doc, T('ProClaim'), ['id', 'shipmentId']),
    scanAll(doc, T('UserProfile'), ['id', 'email', 'name', 'role', 'status']),
  ]);
  const preview = Boolean(values['assume-profiles']);
  const profiles = preview
    ? profilesFromPlan({ actions: [...JSON.parse(readFileSync(resolve(values['assume-profiles']), 'utf8')).actions,
      ...Object.values(GROUP_IDS).map((id) => ({ action: 'PUT_USER_PROFILE', item: { id, name: id, email: `${id.replace(/:/g, '-')}@groups.invalid`, role: 'NONE', status: 'ACTIVE' } }))] }, tableProfiles)
    : tableProfiles;

  const exportByPro = indexExport(exportRows);
  const { byPro: sources } = indexSources(sourceFiles.flat());
  const verdicts = verifyIdMap(idEvidence(exportByPro, sources, inScope));
  const fileRepByPro = new Map([...sources.values()].filter((e) => e.salesRep || e.repConflict).map((e) => [e.pro, { name: e.salesRep, conflict: e.repConflict }]));
  const loadsBy = new Map(); const claimsBy = new Map();
  for (const l of loads) (loadsBy.get(l.shipmentId) ?? loadsBy.set(l.shipmentId, []).get(l.shipmentId)).push(l);
  for (const c of claims) (claimsBy.get(c.shipmentId) ?? claimsBy.set(c.shipmentId, []).get(c.shipmentId)).push(c);
  const proOf = (s) => shipmentKeys(s, loadsBy.get(s.id) ?? [], claimsBy.get(s.id) ?? []).find((k) => exportByPro.has(k)) ?? shipmentKeys(s, loadsBy.get(s.id) ?? [], claimsBy.get(s.id) ?? [])[0] ?? null;
  const { entries, unresolved, skipped } = planSalesRepFill({ shipments, orders, proOf, exportByPro, verdicts, profiles, fileRepByPro });

  if (preview) console.log(`*** PREVIEW: profile ids come from the backfill plan + the two group ids (${profiles.filter((p) => p.planned).length} not in the table yet), NOT from ${T('UserProfile')}. Nothing here can be applied. ***`);
  console.log(`shipments ${shipments.length}; profiles in table ${tableProfiles.length}${preview ? ` (+${profiles.length - tableProfiles.length} planned)` : ''}; export PROs ${exportByPro.size}; equipment-export PROs naming a rep ${fileRepByPro.size}`);
  const noRep = shipments.filter((s) => !s.voidedAt && !s.salesRepCode && !s.salesRepId).length;
  console.log(`shipments with no salesRepCode and no salesRepId (live): ${noRep}; skipped ${JSON.stringify(skipped)}`);
  for (const [id, v] of verdicts) console.log(`  id ${id} -> ${ID_MAP[id].name}: evidence ${v.status}${v.total ? ` (${(v.purity * 100).toFixed(1)}% of ${v.total}, dominant ${v.dominant})` : ''}`);
  console.log(`TO APPLY${preview ? ' (PREVIEW)' : ''}: ${entries.length} shipments, by Aljex id ${JSON.stringify(tallyEntries(entries))}`);
  console.log(`  of which ship date before 2025 or unknown (no in-era evidence): ${entries.filter((e) => e.preEvidenceEra).length}; writes ${JSON.stringify(countWrites(entries))}`);
  console.log(`  by kind ${JSON.stringify(hist(entries, (e) => e.target.kind))}; by source ${JSON.stringify(hist(entries, (e) => e.source))}`);
  console.log(`STILL WITHOUT A REP after this run: ${unresolved.length}, by reason ${JSON.stringify(hist(unresolved, (u) => u.reason))}`);
  console.log(`  by Aljex id ${JSON.stringify(hist(unresolved, (u) => u.repId ?? '-'))}`);

  const f = (name) => join(reportDir, `${name}-${today}${preview ? '-preview' : ''}.csv`);
  writeCsv(f('salesrepfill-to-apply'), ['shipment id', 'PRO', 'ship date', 'aljex salesrep id', 'rep', 'kind', 'source', 'evidence', 'table', 'id', 'field', 'value'],
    entries.flatMap((e) => e.writes.map((w) => [e.shipment.id, e.pro, e.shipDate ?? '', e.repId, e.target.name, e.target.kind, e.source, e.verdict, w.table, w.id, w.field, w.value])));
  writeCsv(f('salesrepfill-still-without-rep'), ['shipment id', 'number', 'PRO', 'aljex salesrep id', 'reason', 'revDivision'],
    unresolved.map((u) => [u.shipment.id, u.shipment.number ?? '', u.pro ?? '', u.repId ?? '', u.reason, u.shipment.revDivision ?? '']));
  writeCsv(f('salesrepfill-bcat-text'), ['shipment id', 'PRO', 'revDivision', 'revSubdivision'],
    entries.filter((e) => e.target.kind === 'DIVISION_TEXT').map((e) => [e.shipment.id, e.pro, e.shipment.revDivision ?? '', e.shipment.revSubdivision ?? '']));
  console.log(`reports written to ${reportDir} (mode 0600): salesrepfill-to-apply, salesrepfill-still-without-rep, salesrepfill-bcat-text (${today}${preview ? ', preview' : ''})`);

  if (!apply) {
    console.log(`DRY RUN: nothing written. ${entries.length} shipment(s) would be enriched.`);
    return;
  }
  const limit = values.limit ? Number(values.limit) : Infinity;
  const cpPath = checkpointPath(suffix);
  const done = loadCheckpoint(cpPath);
  const out = { shipments: 0, fieldsWritten: 0, lost: 0, skippedDone: 0 };
  let n = 0;
  for (const entry of entries) {
    if (n >= limit) break;
    if (done.has(entry.shipment.id)) { out.skippedDone += 1; continue; }
    n += 1;
    const r = await applyOne({ doc, suffix, entry });
    out.shipments += r.written ? 1 : 0;
    out.fieldsWritten += r.written;
    out.lost += r.lost;
    done.add(entry.shipment.id);
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
