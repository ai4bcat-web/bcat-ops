#!/usr/bin/env node
/**
 * Equipment + sales rep backfill for migrated Aljex shipments (dry by default, prod-gated apply). ENRICH ONLY.
 *
 *   dry run (read-only, prints counts, writes review CSVs mode 0600 into --report-dir):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awEquipRep.mjs --target prod --i-mean-production \
 *       --export ~/aljex-export/aljex-full-export-2026-11-07.csv \
 *       --files ~/aljex-export/shipments-with-equipment-2026-11-08.csv --dir ~/aljex-export/shipments-eq
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awEquipRep --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-equiprep node scripts/awEquipRep.mjs <same args> \
 *       --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *
 * Scope: shipments whose Ship Date in the full export (joined by PRO; `L<pro>` originals match their numeric PRO) is >= 2025-01-01.
 * Writes ONLY, each only while the target is still empty (conditional update; never overwrites): Load.equipmentType,
 * Order.equipmentType, Shipment.salesRepCode, plus one AuditLog row per changed shipment with the previous values. Never a money
 * or status field, never a notice / e-mail / message. ZAK (a driver name) and any code outside EQUIPMENT_MAP are
 * never written; division group names (IVAN CARTAGE CO / BCAT / OWNER OPERATORS) are compared with Shipment.revDivision and reported only.
 * Re-runnable and idempotent; progress is checkpointed to ~/bcat-ops-backups/aw-equip-rep-<suffix>.checkpoint.json.
 * PII: names only go into the 0600 CSVs, stdout carries aggregated counts (and distinct rep names with counts).
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { createCsvParser } from './lib/csvStream.mjs';
import { csvCell } from './lib/releaseClassify.mjs';
import {
  DIVISION_NAMES, DRIVER_CODES, EQUIPMENT_MAP, NO_APP_VALUE, SCOPE_FROM,
  buildIdMapping, histogram, indexExport, indexSources, inScope, missingFromSources, normCode, parseAlsoMap, planAll, proKey,
} from './lib/equipRepPlan.mjs';

export const SCRIPT = 'awEquipRep';
export const AUDIT_ACTION = 'AW_EQUIP_REP_BACKFILL';
export const AUDIT_USER = 'system:awEquipRep';
const FIELDS = { Load: ['equipmentType'], Order: ['equipmentType'], Shipment: ['salesRepCode'] };

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function equipRepGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awEquipRep.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-equiprep`;
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

/** Stream a CSV into header-keyed row objects via `pick(headerRow) -> (row) => object`. */
async function readCsv(path, pick) {
  const rows = [];
  let map = null;
  const parser = createCsvParser((r) => {
    if (!map) { map = pick(r, path); return; }
    rows.push(map(r));
  });
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) parser.write(chunk);
  parser.end();
  return rows;
}

const colIndex = (header, name, path) => {
  const i = header.findIndex((h) => h.trim().toLowerCase() === name);
  if (i < 0) throw new Error(`${path}: column "${name}" missing`);
  return i;
};

export const readSourceFile = (path) => readCsv(path, (h) => {
  const c = { pro: colIndex(h, 'shipment_pro', path), eq: colIndex(h, 'shipment_equipment_type_code', path), rep: colIndex(h, 'sales rep name', path), cust: h.findIndex((x) => x.trim().toLowerCase() === 'customer name') };
  return (r) => ({ pro: r[c.pro] ?? '', equipment: r[c.eq] ?? '', rep: r[c.rep] ?? '', customer: c.cust >= 0 ? (r[c.cust] ?? '') : '', file: path });
});

export const readFullExport = (path) => readCsv(path, (h) => {
  const c = { pro: colIndex(h, 'pro #', path), ship: colIndex(h, 'ship date', path), rep: colIndex(h, 'salesrep id', path) };
  return (r) => ({ pro: r[c.pro] ?? '', shipDate: r[c.ship] ?? '', repId: r[c.rep] ?? '' });
});

/** `--files a,b` and/or `--dir d` (every *.csv in it, sorted) -> unique absolute paths. */
export function sourcePaths({ files, dir }) {
  const out = [];
  for (const f of String(files ?? '').split(',').map((s) => s.trim()).filter(Boolean)) out.push(resolve(f));
  if (dir) for (const f of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv')).sort()) out.push(resolve(dir, f));
  return [...new Set(out)];
}

export const writeCsv = (path, head, lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${[head.join(','), ...lines.map((l) => l.map(csvCell).join(','))].join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

const month = (d) => d.slice(0, 7);
const proRange = (pro) => { const n = Math.floor(Number(pro) / 500) * 500; return `${n}-${n + 499}`; };

/** One shipment: conditional enrich of each empty target + one AuditLog row. Returns {written, lost} counts of fields. */
export async function applyOne({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'equipment / sales rep enrich');
  const nowIso = now.toISOString();
  const done = [];
  let lost = 0;
  for (const w of entry.writes) {
    if (!FIELDS[w.table]?.includes(w.field)) throw new Error(`refusing to write ${w.table}.${w.field}`);
    try {
      await doc.send(new UpdateCommand({
        TableName: `${w.table}-${suffix}`,
        Key: { id: w.id },
        UpdateExpression: 'SET #f = :v',
        ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(#f) OR attribute_type(#f, :nul) OR #f = :blank)',
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
        id: randomUUID(),
        __typename: 'AuditLog',
        entityType: 'SHIPMENT',
        entityId: entry.shipment.id,
        action: AUDIT_ACTION,
        user: AUDIT_USER,
        changes: JSON.stringify({
          pro: entry.pro,
          shipDate: entry.shipDate,
          source: { equipment: entry.equipment.code ?? null, rep: entry.rep.source ?? null },
          previous: done.map((w) => ({ table: w.table, id: w.id, field: w.field, value: null })),
          next: done.map((w) => ({ table: w.table, id: w.id, field: w.field, value: w.value })),
        }),
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    }));
  }
  return { written: done.length, lost };
}

const checkpointPath = (suffix) => join(homedir(), 'bcat-ops-backups', `aw-equip-rep-${suffix}.checkpoint.json`);
const loadCheckpoint = (path) => (existsSync(path) ? new Set(JSON.parse(readFileSync(path, 'utf8')).done ?? []) : new Set());
const saveCheckpoint = (path, done) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }), { mode: 0o600 });
};

async function main() {
  const { values } = parseArgs({
    options: {
      export: { type: 'string' }, files: { type: 'string' }, dir: { type: 'string' }, 'report-dir': { type: 'string' },
      'also-map': { type: 'string' }, apply: { type: 'boolean' }, limit: { type: 'string' }, suffix: { type: 'string' },
      help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS,
    },
    allowPositionals: false,
  });
  const paths = sourcePaths({ files: values.files, dir: values.dir });
  if (values.help || !values.export || paths.length === 0) {
    console.log(`Usage: node scripts/awEquipRep.mjs --export <aljex-full-export.csv> (--files a.csv,b.csv | --dir <dir>) [--report-dir <dir>] [--also-map FTL=Full Truckload,...] [--limit N] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply. Scope: Ship Date >= ${SCOPE_FROM}.`);
    return;
  }
  const alsoMap = parseAlsoMap(values['also-map']);
  const gate = await equipRepGate(values);
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
  const sourceRows = sourceFiles.flat();
  const [shipments, loads, orders, claims] = await Promise.all([
    scanAll(doc, T('Shipment'), ['id', 'number', 'status', 'voidedAt', 'salesRepCode', 'revDivision', 'revSubdivision']),
    scanAll(doc, T('Load'), ['id', 'shipmentId', 'aljexId', 'equipmentType']),
    scanAll(doc, T('Order'), ['id', 'shipmentId', 'equipmentType']),
    scanAll(doc, T('ProClaim'), ['id', 'shipmentId']),
  ]);

  const exportByPro = indexExport(exportRows);
  const { byPro: sources, unusable } = indexSources(sourceRows);
  const idMapAll = buildIdMapping(exportByPro, sources);
  const idMapScope = buildIdMapping(exportByPro, sources, { filter: (ex) => inScope(ex.shipDate) });
  const results = planAll({ shipments, loads, orders, claims, sources, exportByPro, idMap: idMapAll, alsoMap });
  const scoped = results.filter((r) => r.scope === 'IN_SCOPE');
  const prodPros = new Set(results.map((r) => r.pro).filter(Boolean));

  // ── counts (stdout: aggregates only)
  const srcOlder = [...sources.keys()].filter((p) => exportByPro.has(p) && exportByPro.get(p).shipDate && !inScope(exportByPro.get(p).shipDate)).length;
  const srcNoDate = [...sources.keys()].filter((p) => exportByPro.has(p) && !exportByPro.get(p).shipDate).length;
  const srcNoExport = [...sources.keys()].filter((p) => !exportByPro.has(p)).length;
  console.log(`source files ${paths.length}; rows ${sourceRows.length} (unusable PRO ${unusable}); distinct PROs ${sources.size}; export PROs ${exportByPro.size}`);
  console.log(`SOURCE PROs: in scope (ship >= ${SCOPE_FROM}) ${sources.size - srcOlder - srcNoDate - srcNoExport}; EXCLUDED older ${srcOlder}; no ship date ${srcNoDate}; not in full export ${srcNoExport}`);
  console.log(`PRODUCTION shipments ${shipments.length}: in scope ${scoped.length}; EXCLUDED older ${results.filter((r) => r.scope === 'OLDER').length}; no ship date ${results.filter((r) => r.scope === 'NO_SHIP_DATE').length}; not in full export ${results.filter((r) => r.scope === 'NOT_IN_EXPORT').length}; voided ${results.filter((r) => r.scope === 'VOIDED').length}`);
  console.log('EQUIPMENT (in scope) by status', JSON.stringify(histogram(scoped, (r) => r.equipment.status)));
  console.log('EQUIPMENT to set per app value', JSON.stringify(histogram(scoped.filter((r) => r.equipment.status === 'TO_SET'), (r) => `${r.equipment.code}->${r.equipment.value}`)));
  console.log('EQUIPMENT already set (skipped) per code', JSON.stringify(histogram(scoped.filter((r) => r.equipment.status === 'ALREADY_SET'), (r) => `${r.equipment.code}->${r.equipment.value}`)));
  console.log('EQUIPMENT would write per code/table (empty fields only)', JSON.stringify(histogram(scoped.filter((r) => r.equipment.status === 'TO_SET').flatMap((r) => r.writes.filter((w) => w.field === 'equipmentType').map((w) => ({ code: r.equipment.code, table: w.table }))), (x) => `${x.code}->${EQUIPMENT_MAP[x.code]} ${x.table}`)));
  console.log('EQUIPMENT no Load/Order target (not written) per code', JSON.stringify(histogram(scoped.filter((r) => r.equipment.status === 'NO_TARGET'), (r) => r.equipment.code)));
  console.log(`ZAK (driver, never equipment) ${scoped.filter((r) => r.equipment.status === 'DRIVER').length}`);
  console.log('no app equipment value (left blank) by code', JSON.stringify(histogram(scoped.filter((r) => r.equipment.status === 'NO_APP_VALUE'), (r) => r.equipment.code)));
  console.log('unknown codes (left blank) by code', JSON.stringify(histogram(scoped.filter((r) => r.equipment.status === 'UNKNOWN_CODE'), (r) => r.equipment.code)));
  console.log('SALES REP (in scope) by status', JSON.stringify(histogram(scoped, (r) => r.rep.status)));
  console.log('SALES REP to set per person', JSON.stringify(histogram(scoped.filter((r) => r.rep.status === 'TO_SET'), (r) => r.rep.name)));
  console.log('SALES REP to set by source', JSON.stringify(histogram(scoped.filter((r) => r.rep.status === 'TO_SET'), (r) => r.rep.source)));
  const divs = scoped.filter((r) => r.rep.kind === 'DIVISION');
  console.log('DIVISION rows (report only, never written) by group/status', JSON.stringify(histogram(divs, (r) => `${r.rep.name} ${r.rep.status}`)));
  const fmt = (m) => m.map((x) => ({ id: x.id || '(blank)', n: x.total, dominant: x.dominant, purity: `${(x.purity * 100).toFixed(1)}%`, ambiguous: x.ambiguous, ...(x.tie ? { tie: true } : {}) }));
  for (const x of fmt(idMapAll)) console.log('ID MAP (all PROs in both sources)', JSON.stringify(x));
  for (const x of fmt(idMapScope)) console.log('ID MAP (ship >= scope only)', JSON.stringify(x));
  const toApply = scoped.filter((r) => r.writes.length > 0);
  const fieldWrites = histogram(toApply.flatMap((r) => r.writes), (w) => `${w.table}.${w.field}`);
  console.log(`TO APPLY: ${toApply.length} shipments; field writes ${JSON.stringify(fieldWrites)}`);

  // ── review CSVs (PII allowed: 0600)
  const missing = missingFromSources(exportByPro, sources, prodPros);
  const f = (name) => join(reportDir, `${name}-${today}.csv`);
  writeCsv(f('equipment-review'), ['PRO', 'ship date', 'kind', 'code', 'proposal', 'sales rep name', 'customer name'],
    scoped.filter((r) => ['DRIVER', 'UNKNOWN_CODE', 'NO_APP_VALUE', 'CONFLICT'].includes(r.equipment.status)).map((r) => {
      const s = sources.get(r.pro);
      const cust = sourceRows.find((x) => proKey(x.pro) === r.pro)?.customer ?? '';
      const code = r.equipment.code ?? (r.equipment.codes ?? []).join('|');
      const proposal = r.equipment.status === 'DRIVER' ? `set driver "${code}" (not applied)` : r.equipment.status === 'NO_APP_VALUE' ? `Aljex: ${NO_APP_VALUE[code]}; no app value, left blank` : 'left blank, needs review';
      return [r.pro, r.shipDate, r.equipment.status, code, proposal, s?.salesRep ?? '', cust];
    }));
  writeCsv(f('salesrep-review'), ['PRO', 'ship date', 'status', 'detail', 'aljex salesrep id', 'customer name'],
    [
      ...scoped.filter((r) => ['CONFLICT', 'ID_AMBIGUOUS', 'NO_SOURCE', 'DIVISION_DISAGREES', 'DIVISION_NEEDS_REVIEW'].includes(r.rep.status)).map((r) => [
        r.pro, r.shipDate, r.rep.status,
        r.rep.status === 'CONFLICT' ? r.rep.names.join('|') : r.rep.kind === 'DIVISION' ? `${r.rep.name}: app has ${r.shipment.revDivision ?? ''}/${r.shipment.revSubdivision ?? ''}` : '',
        exportByPro.get(r.pro)?.repId ?? '', sourceRows.find((x) => proKey(x.pro) === r.pro)?.customer ?? '',
      ]),
      ...results.filter((r) => r.scope === 'NO_SHIP_DATE' || r.scope === 'NOT_IN_EXPORT').map((r) => [r.shipment.number, r.shipDate ?? '', `OUT_OF_SCOPE_${r.scope}`, '', '', '']),
    ]);
  writeCsv(f('equiprep-to-apply'), ['PRO', 'ship date', 'table', 'field', 'value (equipment value or rep name)', 'source'],
    toApply.flatMap((r) => r.writes.map((w) => [r.pro, r.shipDate, w.table, w.field, w.value, w.field === 'salesRepCode' ? r.rep.source : `code ${r.equipment.code}`])));
  writeCsv(f('equiprep-needs-export'), ['PRO', 'ship date', 'in production'], missing.map((m) => [m.pro, m.shipDate, m.inProd ? 'yes' : 'no']));
  chmodSync(f('equiprep-needs-export'), 0o600);
  console.log(`NEEDS EXPORT (ship >= ${SCOPE_FROM}, no equipment-export row): ${missing.length} PROs (in production ${missing.filter((m) => m.inProd).length}); by month ${JSON.stringify(histogram(missing, (m) => month(m.shipDate)))}`);
  console.log(`NEEDS EXPORT by PRO range ${JSON.stringify(histogram(missing, (m) => proRange(m.pro)))}`);
  console.log(`reports written to ${reportDir} (mode 0600): equipment-review, salesrep-review, equiprep-to-apply, equiprep-needs-export (${today})`);

  if (!apply) {
    console.log(`DRY RUN: nothing written. ${toApply.length} shipment(s) would be enriched.`);
    return;
  }
  const limit = values.limit ? Number(values.limit) : Infinity;
  const cpPath = checkpointPath(suffix);
  const done = loadCheckpoint(cpPath);
  const out = { shipments: 0, fieldsWritten: 0, fieldsAlreadyFilled: 0, skippedDone: 0 };
  let n = 0;
  for (const entry of toApply) {
    if (n >= limit) break;
    if (done.has(entry.shipment.id)) { out.skippedDone += 1; continue; }
    n += 1;
    const r = await applyOne({ doc, suffix, entry });
    out.shipments += r.written ? 1 : 0;
    out.fieldsWritten += r.written;
    out.fieldsAlreadyFilled += r.lost;
    done.add(entry.shipment.id);
    if (n % 25 === 0) saveCheckpoint(cpPath, done);
  }
  saveCheckpoint(cpPath, done);
  console.log('APPLIED', JSON.stringify(out));
}

export { EQUIPMENT_MAP, DRIVER_CODES, DIVISION_NAMES, normCode };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
