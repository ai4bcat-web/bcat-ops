#!/usr/bin/env node
/**
 * Carrier cleanup after the Aljex migration (subcommands, each dry by default, prod-gated apply):
 *   activate   every carrier USED on a load shipped on/after 2025-01-01 -> Carrier.status ACTIVE (NOT part of the 2026-11-09 cleanup: MCP decides ACTIVE)
 *   billing    enrich-only billing info for the ACTIVE carriers from the Aljex carriers export
 *   inactivate every REFERENCED carrier that MyCarrierPackets never synced (no mcpSyncedAt) -> Carrier.status INACTIVE (kept, never deleted)
 *   delete     every carrier nothing retained references and that was not used since the cutoff, WITH its CarrierContact / CarrierPaymentMethod /
 *              CarrierDocument rows and its CarrierTaxVault row. Class A = never MCP-synced, class B = MCP-synced (filled in) but unused.
 *   restore    put-if-absent of the Carrier + child rows of one delete export (vault: from the backup)
 * Run order (Ryne 2026-11-09): backup, inactivate, delete; `delete` only AFTER awPreDelete (the apply refuses a carrier that anything live still references).
 *
 *   dry run (read-only, prints counts, writes review CSVs mode 0600 into --report-dir; --target prod reads production):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awCarriers.mjs <sub> --target prod --i-mean-production \
 *       --export ~/aljex-export/aljex-full-export-2026-11-07.csv --carriers ~/aljex-export/aljex-carriers-2026-11-08.csv
 *   backup (once, < 6 h before the apply; one set covers all subcommands incl. the child tables and the CarrierTaxVault table):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awCarriers --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-carriers-<sub> node scripts/awCarriers.mjs <sub> <same args> \
 *       --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *   restore (a delete export): awCarriers.mjs restore --from ~/bcat-ops-backups/pre-delete-carriers/<stamp> --apply ... (token <date>-carriers-restore)
 *
 * Writes (each conditional, idempotent, checkpointed to ~/bcat-ops-backups/aw-carriers-<sub>-<suffix>.checkpoint.json,
 * one AuditLog row per changed carrier, never money, never a notice / e-mail):
 *   activate:   Carrier.status (only while still the previous status), statusChangedAt/By, updatedAt/By.
 *   inactivate: Carrier.status INACTIVE (only while still the previous status and never DO_NOT_USE), statusReason OTHER + statusNote, statusChangedAt/By, updatedAt/By.
 *   billing:    Carrier.address / phone / dispatcherName / paymentTermsDays / quickPayEligible / defaultQuickPayDays, each only while empty,
 *               and one CarrierPaymentMethod (CHECK, payee + remit-to) per carrier that has none.
 *               NOT written (no safe app field): 1099 flag, Quick Pay %, Factor Id, Bank Account, Routing #. Bank/routing/tax ids are never read
 *               into a variable of this script and never printed: the app's vault holds tax ids only (already loaded), and CarrierPaymentMethod
 *               refuses full account numbers by design.
 *   delete:     Carrier, CarrierContact, CarrierPaymentMethod, CarrierDocument (index rows only; S3 objects under carrier-docs/<id>/ are left) and
 *               CarrierTaxVault rows. Exports the Carrier + child rows first (no tax / bank / account / routing attributes) to
 *               ~/bcat-ops-backups/pre-delete-carriers/<stamp>/. A carrier is refused when ANY row still references it at apply time, or when a
 *               child row appeared after the scan, or when the carrier changed since the scan.
 *   restore:    Carrier + child rows from the export, put-if-absent, one AuditLog row per carrier.
 * PII: stdout carries counts only; CSV reports carry carrier ids + names + field NAMES, never values.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { register } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd, tableName } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { createCsvParser } from './lib/csvStream.mjs';
import { csvCell } from './lib/releaseClassify.mjs';
import {
  AUDIT_USER, BILLING_CARRIER_FIELDS, CHILD_FILES, CHILD_TABLES, CUTOFF, buildExport, carrierIdsInJson, classifyShipments, deletedByPreDelete,
  indexShipDates, isMcpSynced, matchMasters, planBilling, planCarriers, referenceMap, refusalFor, sha256, verifyExport,
} from './lib/carrierPlan.mjs';

// The app's own parser (counts the sensitive columns, never copies them); Node strips the types at run time.
register('./lib/tsExtensionlessHooks.mjs', import.meta.url);
const { parseCarrierRows } = await import('../src/lib/aljex/layouts/carriers.ts');

export const SCRIPT = 'awCarriers';
export const SUBCOMMANDS = ['activate', 'billing', 'inactivate', 'delete', 'restore'];
export const AUDIT_ACTIONS = { activate: 'AW_CARRIER_ACTIVATE', billing: 'AW_CARRIER_BILLING', inactivate: 'AW_CARRIER_INACTIVATE', delete: 'AW_CARRIER_DELETE', restore: 'AW_CARRIER_RESTORE' };
/** Tables each subcommand writes (backup coverage the gate demands); the union is PROD_WRITE_SETS.awCarriers. */
export const SUB_MODELS = {
  activate: ['Carrier', 'AuditLog'],
  billing: ['Carrier', 'CarrierPaymentMethod', 'AuditLog'],
  inactivate: ['Carrier', 'AuditLog'],
  delete: ['Carrier', 'CarrierContact', 'CarrierPaymentMethod', 'CarrierDocument', 'CarrierTaxVault', 'AuditLog'],
  restore: ['Carrier', 'CarrierContact', 'CarrierPaymentMethod', 'CarrierDocument', 'AuditLog'],
};
export const EXPORT_DIR_NAME = 'pre-delete-carriers';
export const defaultExportDir = () => join(homedir(), 'bcat-ops-backups', EXPORT_DIR_NAME);

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function carriersGate(sub, values, deps = {}) {
  if (!SUBCOMMANDS.includes(sub)) throw new Error(`unknown subcommand "${sub}" (activate | billing | inactivate | delete | restore)`);
  const apply = values.apply === true;
  const gate = await requireProd({ script: SCRIPT, values, tables: SUB_MODELS[sub], readOnly: !apply, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-carriers-${sub}`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) {
      throw new Error(`Production gate closed for ${SCRIPT} ${sub}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
    }
  }
  return gate;
}

async function scanAll(doc, table, projection) {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: table,
      ...(projection ? {
        ProjectionExpression: projection.map((_, i) => `#p${i}`).join(','),
        ExpressionAttributeNames: Object.fromEntries(projection.map((p, i) => [`#p${i}`, p])),
      } : {}),
      ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

async function readCsvRows(path) {
  const rows = [];
  const parser = createCsvParser((r) => { rows.push(r); });
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) parser.write(chunk);
  parser.end();
  return rows;
}

/** The full export's PRO + Ship Date columns (the only two read). */
export async function readShipDates(path) {
  const [header, ...rows] = await readCsvRows(path);
  const ix = (name) => {
    const i = header.findIndex((h) => h.trim().toLowerCase() === name);
    if (i < 0) throw new Error(`${path}: column "${name}" missing`);
    return i;
  };
  const pro = ix('pro #');
  const ship = ix('ship date');
  return rows.map((r) => ({ pro: r[pro] ?? '', shipDate: r[ship] ?? '' }));
}

/** The carriers export through the app's parser. Also counts the non-field columns (1099, quick-pay %) from non-sensitive columns only. */
export async function readCarrierMasters(path) {
  const [header, ...rows] = await readCsvRows(path);
  const parsed = parseCarrierRows(header, rows);
  const col = header.findIndex((h) => h.trim().toLowerCase() === '1099 y/n');
  const idCol = header.findIndex((h) => h.trim().toLowerCase() === 'aljex carrier id');
  const flag1099 = new Map(rows.map((r) => [String(r[idCol] ?? '').trim(), String(r[col] ?? '').trim().toUpperCase()]));
  return { parsed, flag1099 };
}

const digits = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');

/** The report's MC / DOT columns -> key sets (counts only ever leave this function). */
export async function readNotInMcp(path) {
  const rows = await readCsvRows(path);
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const mcI = head.indexOf('mc'); const dotI = head.indexOf('dot');
  const mc = new Set(); const dot = new Set();
  for (const r of rows.slice(1)) { if (mcI >= 0 && digits(r[mcI])) mc.add(digits(r[mcI])); if (dotI >= 0 && digits(r[dotI])) dot.add(digits(r[dotI])); }
  return { mc, dot, rows: rows.length - 1 };
}

const writeCsv = (path, head, lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${[head.join(','), ...lines.map((l) => l.map(csvCell).join(','))].join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

const histogram = (items, f) => {
  const out = {};
  for (const x of items) { const k = f(x); out[k] = (out[k] ?? 0) + 1; }
  return out;
};

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (k) (m.get(k) ?? m.set(k, []).get(k)).push(r); }
  return m;
};

/** Everything the three subcommands read, in one pass. */
export async function loadData(doc, suffix) {
  const T = (m) => tableName(m, suffix);
  const [carriers, shipments, loads, loadCarriers, bills, apPayments, customers, settings, vault] = await Promise.all([
    scanAll(doc, T('Carrier')),
    scanAll(doc, T('Shipment'), ['id', 'number', 'legacyImported', 'pickupAppt', 'voidedAt']),
    scanAll(doc, T('Load'), ['id', 'shipmentId', 'aljexId']),
    scanAll(doc, T('LoadCarrier'), ['id', 'loadId', 'shipmentId', 'carrierId', 'status']),
    scanAll(doc, T('CarrierBill'), ['id', 'loadCarrierId', 'loadId', 'shipmentId', 'carrierId', 'status', 'balanceCents']),
    scanAll(doc, T('ApPayment'), ['id', 'carrierId', 'applications', 'creditApplications', 'unappliedCents']),
    scanAll(doc, T('Customer'), ['id', 'quotingDefaults']),
    scanAll(doc, T('TmsSettings'), ['id', 'customerPortalDefaults']),
    scanAll(doc, T('CarrierTaxVault'), ['carrierId']),
  ]);
  const others = {};
  for (const t of ['Quote', 'LaneRateSample', 'Commission']) others[t] = await scanAll(doc, T(t), ['id', 'carrierId']);
  const children = {};
  for (const t of CHILD_TABLES) children[t] = groupBy(await scanAll(doc, T(t)), 'carrierId');
  return { carriers, shipments, loads, loadCarriers, bills, apPayments, customers, settings, vaultIds: vault.map((v) => v.carrierId), others, children };
}

const openApCents = (bills) => bills.filter((b) => b.status !== 'PAID' && b.status !== 'VOID').reduce((a, b) => a + (typeof b.balanceCents === 'number' ? b.balanceCents : 0), 0);

/** The pure analysis: shipments -> deleted-by-PreDelete -> references -> activate/delete/keep. */
export function analyze(data, { shipDateRows, undatedUsed = true, keepDoNotUse = true, protectLastLoad = true, cutoff = CUTOFF }) {
  const shipDates = indexShipDates(shipDateRows);
  const shipmentInfo = classifyShipments({ shipments: data.shipments, shipDates, cutoff });
  const deleted = deletedByPreDelete({ shipmentInfo, loads: data.loads, loadCarriers: data.loadCarriers, bills: data.bills, apPayments: data.apPayments });
  const jsonRefs = [
    ...data.customers.flatMap((c) => carrierIdsInJson(c.quotingDefaults).map((carrierId) => ({ table: 'Customer.quotingDefaults', carrierId }))),
    ...data.settings.flatMap((s) => carrierIdsInJson(s.customerPortalDefaults).map((carrierId) => ({ table: 'TmsSettings.customerPortalDefaults', carrierId }))),
  ];
  const rows = { LoadCarrier: data.loadCarriers, CarrierBill: data.bills, ApPayment: data.apPayments, ...data.others };
  const refs = referenceMap({ carriers: data.carriers, rows, shipmentInfo, loads: data.loads, deleted, jsonRefs, cutoff });
  const plan = planCarriers({ carriers: data.carriers, refs: refs.byCarrier, children: data.children, undatedUsed, keepDoNotUse, protectLastLoad });
  return { shipDates, shipmentInfo, deleted, refs, plan };
}

/** Before/after proof (pure): deleting the planned carriers leaves every retained reference resolvable and open AP unchanged. */
export function conservation(data, analysis, deleteIds) {
  const gone = new Set(deleteIds);
  const after = data.carriers.filter((c) => !gone.has(c.id));
  const ids = new Set(after.map((c) => c.id));
  const beforeIds = new Set(data.carriers.map((c) => c.id));
  const retained = {
    LoadCarrier: data.loadCarriers.filter((r) => !analysis.deleted.deletedLoadCarriers.has(r.id)),
    CarrierBill: data.bills.filter((r) => !analysis.deleted.deletedBills.has(r.id)),
    ApPayment: data.apPayments.filter((r) => !analysis.deleted.deletedApPayments.has(r.id)),
  };
  const resolves = (rows) => rows.filter((r) => r.carrierId && ids.has(r.carrierId)).length;
  const had = (rows) => rows.filter((r) => r.carrierId && beforeIds.has(r.carrierId)).length;
  const out = { carriersBefore: data.carriers.length, carriersAfter: after.length, vaultRowsBefore: data.vaultIds.length, vaultRowsAfter: data.vaultIds.filter((id) => !gone.has(id)).length, rows: {} };
  for (const [t, rows] of Object.entries(retained)) out.rows[t] = { retained: rows.length, resolvedBefore: had(rows), resolvedAfter: resolves(rows) };
  out.openApCentsRetained = openApCents(retained.CarrierBill);
  out.ok = Object.values(out.rows).every((r) => r.resolvedAfter === r.resolvedBefore);
  return out;
}

const nameOf = (carriers) => new Map(carriers.map((c) => [c.id, c.name ?? '']));

// ── apply ────────────────────────────────────────────────────────────────────────────────────────────────

const auditItem = ({ suffix, carrierId, action, changes, now }) => ({
  TableName: tableName('AuditLog', suffix),
  Item: { id: randomUUID(), __typename: 'AuditLog', entityType: 'CARRIER', entityId: carrierId, action, user: AUDIT_USER, changes: JSON.stringify(changes), createdAt: now.toISOString(), updatedAt: now.toISOString() },
});

/** One carrier -> ACTIVE, only while it still has the status the plan saw. Returns true when written. */
export async function applyActivate({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'carrier activate');
  const at = now.toISOString();
  try {
    await doc.send(new UpdateCommand({
      TableName: tableName('Carrier', suffix),
      Key: { id: entry.id },
      UpdateExpression: 'SET #s = :active, statusChangedAt = :at, statusChangedBy = :by, updatedAt = :at, updatedBy = :by REMOVE statusReason, statusNote',
      ConditionExpression: 'attribute_exists(id) AND #s = :prev AND #s <> :dnu',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':active': 'ACTIVE', ':prev': entry.previousStatus, ':dnu': 'DO_NOT_USE', ':at': at, ':by': AUDIT_USER },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
  await doc.send(new PutCommand(auditItem({
    suffix, carrierId: entry.id, action: AUDIT_ACTIONS.activate, now,
    changes: { previousStatus: entry.previousStatus, previousStatusReason: entry.previousReason, nextStatus: 'ACTIVE', basis: `used on a load shipped on/after ${CUTOFF}` },
  })));
  return true;
}

const EMPTY = 'attribute_not_exists(#f) OR attribute_type(#f, :nul)';

/** One carrier's billing enrich: each field only while empty; one payment method only while absent. */
export async function applyBilling({ doc, suffix, carrier, plan, now = new Date() }) {
  assertWritableSuffix(suffix, 'carrier billing enrich');
  const at = now.toISOString();
  const done = [];
  let lost = 0;
  for (const [field, value] of Object.entries(plan.patch)) {
    if (!BILLING_CARRIER_FIELDS.includes(field)) throw new Error(`refusing to write Carrier.${field}`);
    try {
      await doc.send(new UpdateCommand({
        TableName: tableName('Carrier', suffix),
        Key: { id: carrier.id },
        UpdateExpression: 'SET #f = :v, updatedAt = :at, updatedBy = :by',
        ConditionExpression: `attribute_exists(id) AND (${EMPTY})`,
        ExpressionAttributeNames: { '#f': field },
        ExpressionAttributeValues: { ':v': value, ':nul': 'NULL', ':at': at, ':by': AUDIT_USER },
      }));
      done.push(field);
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') { lost += 1; continue; }
      throw err;
    }
  }
  let methodWritten = false;
  if (plan.method) {
    try {
      await doc.send(new PutCommand({ TableName: tableName('CarrierPaymentMethod', suffix), Item: plan.method, ConditionExpression: 'attribute_not_exists(id)' }));
      methodWritten = true;
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      lost += 1;
    }
  }
  if (done.length || methodWritten) {
    await doc.send(new PutCommand(auditItem({
      suffix, carrierId: carrier.id, action: AUDIT_ACTIONS.billing, now,
      changes: { fieldsFilled: done, paymentMethodCreated: methodWritten, previous: 'empty', source: 'Aljex carriers export' },
    })));
  }
  return { fields: done.length, method: methodWritten ? 1 : 0, lost };
}

const LIVE_REF_QUERIES = [
  ['LoadCarrier', 'loadCarriersByCarrierId'],
  ['CarrierBill', 'carrierBillsByCarrierIdAndRecordedAt'],
  ['ApPayment', 'apPaymentsByCarrierIdAndPaidAt'],
];

/** Right-before-delete live reference check for one carrier (one Limit-1 index query per money table). Returns {table: n}. */
export async function liveReferences({ doc, suffix, carrierId }) {
  const out = {};
  for (const [table, index] of LIVE_REF_QUERIES) {
    const r = await doc.send(new QueryCommand({
      TableName: tableName(table, suffix), IndexName: index, KeyConditionExpression: 'carrierId = :c', ExpressionAttributeValues: { ':c': carrierId }, Limit: 1, Select: 'COUNT',
    }));
    if ((r.Count ?? 0) > 0) out[table] = r.Count;
  }
  return out;
}

const CHILD_INDEX = { CarrierContact: 'carrierContactsByCarrierId', CarrierPaymentMethod: 'carrierPaymentMethodsByCarrierId', CarrierDocument: 'carrierDocumentsByCarrierIdAndType' };
const TX_LIMIT = 100;

/** Every child row id one carrier has right now, per table (paged index queries). */
export async function liveChildIds({ doc, suffix, carrierId }) {
  const out = {};
  for (const t of CHILD_TABLES) {
    out[t] = [];
    let key;
    do {
      const r = await doc.send(new QueryCommand({
        TableName: tableName(t, suffix), IndexName: CHILD_INDEX[t], KeyConditionExpression: 'carrierId = :c', ExpressionAttributeValues: { ':c': carrierId }, ProjectionExpression: 'id', ExclusiveStartKey: key,
      }));
      out[t].push(...(r.Items ?? []).map((i) => i.id));
      key = r.LastEvaluatedKey;
    } while (key);
  }
  return out;
}

/**
 * Delete one carrier WITH its child rows and its vault row, in ONE transaction (all or nothing), after the live checks.
 * Refuses (returns {refused}) when anything still references the carrier, when a child row exists that the export does not hold
 * (created after the scan), when the carrier changed since the scan, or when the carrier has too many rows for one transaction.
 * `children`: the scanned child rows per table (what the export holds).
 */
export async function applyDelete({ doc, suffix, entry, carrier, children = {}, hasVault, exportName, now = new Date() }) {
  assertWritableSuffix(suffix, 'carrier delete');
  const live = await liveReferences({ doc, suffix, carrierId: entry.id });
  const refusal = refusalFor(live);
  if (refusal) return { refused: refusal };
  const kids = await liveChildIds({ doc, suffix, carrierId: entry.id });
  const exported = new Set(CHILD_TABLES.flatMap((t) => (children[t] ?? []).map((r) => `${t}:${r.id}`)));
  if (CHILD_TABLES.some((t) => kids[t].some((id) => !exported.has(`${t}:${id}`)))) return { refused: 'child rows appeared since the scan (not in the export)' };
  const childCounts = Object.fromEntries(CHILD_TABLES.map((t) => [t, kids[t].length]));
  const items = [
    { Delete: {
      TableName: tableName('Carrier', suffix), Key: { id: entry.id },
      ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(updatedAt) OR updatedAt = :u) AND #s <> :dnu',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':u': carrier.updatedAt ?? '', ':dnu': 'DO_NOT_USE' },
    } },
    ...CHILD_TABLES.flatMap((t) => kids[t].map((id) => ({ Delete: { TableName: tableName(t, suffix), Key: { id } } }))),
    ...(hasVault ? [{ Delete: { TableName: tableName('CarrierTaxVault', suffix), Key: { carrierId: entry.id } } }] : []),
    { Put: auditItem({
      suffix, carrierId: entry.id, action: AUDIT_ACTIONS.delete, now,
      changes: { name: carrier.name ?? null, class: entry.cls ?? null, previousStatus: entry.status, aljexCode: carrier.aljexCode ?? null, mcpSynced: isMcpSynced(carrier), children: childCounts, vaultRowDeleted: !!hasVault, export: exportName },
    }) },
  ];
  if (items.length > TX_LIMIT) return { refused: `too many rows for one transaction (${items.length})` };
  try {
    await doc.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (err) {
    if (err?.name === 'TransactionCanceledException' || err?.name === 'ConditionalCheckFailedException') return { refused: 'changed since the scan (or already gone)' };
    throw err;
  }
  return { deleted: true, children: childCounts };
}

/** One carrier -> INACTIVE (never synced by MCP, still referenced), only while it still has the status the plan saw. Returns true when written. */
export async function applyInactivate({ doc, suffix, entry, now = new Date() }) {
  assertWritableSuffix(suffix, 'carrier inactivate');
  const at = now.toISOString();
  try {
    await doc.send(new UpdateCommand({
      TableName: tableName('Carrier', suffix),
      Key: { id: entry.id },
      UpdateExpression: 'SET #s = :inactive, statusReason = :why, statusNote = :note, statusChangedAt = :at, statusChangedBy = :by, updatedAt = :at, updatedBy = :by',
      ConditionExpression: 'attribute_exists(id) AND #s = :prev AND #s <> :dnu AND attribute_not_exists(mcpSyncedAt)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':inactive': 'INACTIVE', ':prev': entry.previousStatus, ':dnu': 'DO_NOT_USE', ':why': 'OTHER', ':note': 'Aljex carrier never synced from MyCarrierPackets; kept because loads/bills still reference it.', ':at': at, ':by': AUDIT_USER },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
  await doc.send(new PutCommand(auditItem({
    suffix, carrierId: entry.id, action: AUDIT_ACTIONS.inactivate, now,
    changes: { previousStatus: entry.previousStatus, previousStatusReason: entry.previousReason, nextStatus: 'INACTIVE', basis: 'referenced by retained rows, never MCP-synced (no mcpSyncedAt)' },
  })));
  return true;
}

const checkpointPath = (sub, suffix) => join(homedir(), 'bcat-ops-backups', `aw-carriers-${sub}-${suffix}.checkpoint.json`);
const loadCheckpoint = (path) => (existsSync(path) ? new Set(JSON.parse(readFileSync(path, 'utf8')).done ?? []) : new Set());
const saveCheckpoint = (path, done) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }), { mode: 0o600 });
};

/** Write the restore copy (dir 0700, files 0600) and read it back against the manifest. */
export function writeExport({ dir, carriers, children = {}, vaultCarrierIds, suffix, now = new Date() }) {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  const target = join(dir, stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const { files, manifest } = buildExport({ carriers, children, vaultCarrierIds, suffix, now });
  for (const [name, text] of Object.entries(files)) { writeFileSync(join(target, name), text, { mode: 0o600 }); chmodSync(join(target, name), 0o600); }
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600 });
  chmodSync(join(target, 'manifest.json'), 0o600);
  if (!verifyExport(manifest, (n) => readFileSync(join(target, n), 'utf8'))) throw new Error('export did not read back against its manifest sha256');
  return { target, manifest };
}

/** Read one delete export back (manifest sha256 verified): { carriers, children: {table: rows[]}, vaultCarrierIds, manifest }. */
export function readExport(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (!verifyExport(manifest, (n) => readFileSync(join(dir, n), 'utf8'))) throw new Error(`export ${dir} does not match its manifest sha256`);
  const jsonl = (name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    manifest, carriers: jsonl('carriers.jsonl'),
    children: Object.fromEntries(CHILD_TABLES.map((t) => [t, jsonl(CHILD_FILES[t])])),
    vaultCarrierIds: JSON.parse(readFileSync(join(dir, 'vault-carrier-ids.json'), 'utf8')),
  };
}

/** Put-if-absent of one exported carrier and its child rows, then one audit row. The tax-id mirror and the vault row come back only from the backup. */
export async function applyRestore({ doc, suffix, carrier, children, exportName, now = new Date() }) {
  assertWritableSuffix(suffix, 'carrier restore');
  const put = async (table, item) => {
    try { await doc.send(new PutCommand({ TableName: tableName(table, suffix), Item: item, ConditionExpression: 'attribute_not_exists(id)' })); return 1; }
    catch (err) { if (err?.name === 'ConditionalCheckFailedException') return 0; throw err; }
  };
  const out = { carrier: await put('Carrier', carrier), CarrierContact: 0, CarrierPaymentMethod: 0, CarrierDocument: 0 };
  for (const t of CHILD_TABLES) for (const row of children[t] ?? []) out[t] += await put(t, row);
  if (out.carrier || CHILD_TABLES.some((t) => out[t])) {
    await doc.send(new PutCommand(auditItem({ suffix, carrierId: carrier.id, action: AUDIT_ACTIONS.restore, now, changes: { restored: out, export: exportName, vault: 'not restored by this script (CarrierTaxVault backup)' } })));
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      export: { type: 'string' }, from: { type: 'string' }, 'not-in-mcp': { type: 'string' }, carriers: { type: 'string' }, 'report-dir': { type: 'string' }, 'export-dir': { type: 'string' },
      apply: { type: 'boolean' }, limit: { type: 'string' }, suffix: { type: 'string' }, undated: { type: 'string' }, 'include-do-not-use': { type: 'boolean' }, 'ignore-lastloadat': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS,
    },
    allowPositionals: true,
  });
  const sub = positionals[0];
  if (values.help || !SUBCOMMANDS.includes(sub) || (sub === 'restore' ? !values.from : !values.export) || (sub === 'billing' && !values.carriers)) {
    console.log(`Usage: node scripts/awCarriers.mjs <activate|billing|inactivate|delete> --export <aljex-full-export.csv> [--carriers <aljex-carriers.csv> (billing)] [--report-dir <dir>] [--export-dir <dir>] [--undated used|skip] [--include-do-not-use] [--ignore-lastloadat] [--not-in-mcp <report csv> (cross-check, counts only)] [--limit N] [--apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply. Cutoff: ship date >= ${CUTOFF}. Order: inactivate, delete (after awPreDelete). Restore: awCarriers.mjs restore --from <pre-delete-carriers/stamp dir> [--apply].`);
    return;
  }
  const undatedUsed = (values.undated ?? 'used') !== 'skip';
  const gate = await carriersGate(sub, values);
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
  const f = (name) => join(reportDir, `${name}-${today}.csv`);
  const limit = values.limit ? Number(values.limit) : Infinity;

  if (sub === 'restore') {
    const exp = readExport(values.from);
    const have = (t) => exp.children[t].length;
    console.log(`RESTORE from ${values.from}: carriers ${exp.carriers.length}, contacts ${have('CarrierContact')}, payment methods ${have('CarrierPaymentMethod')}, documents ${have('CarrierDocument')}; vault rows ${exp.vaultCarrierIds.length} (restore from the CarrierTaxVault backup, not from this export); manifest sha256 verified`);
    if (!apply) return console.log('DRY RUN: nothing written (put-if-absent: rows that exist are left alone).');
    const byCarrier = (t) => groupBy(exp.children[t], 'carrierId');
    const kids = Object.fromEntries(CHILD_TABLES.map((t) => [t, byCarrier(t)]));
    const total = { carrier: 0, CarrierContact: 0, CarrierPaymentMethod: 0, CarrierDocument: 0 };
    let n = 0;
    for (const c of exp.carriers) {
      if (n >= limit) break;
      n += 1;
      const r = await applyRestore({ doc, suffix, carrier: c, children: Object.fromEntries(CHILD_TABLES.map((t) => [t, kids[t].get(c.id) ?? []])), exportName: values.from.split('/').filter(Boolean).pop() });
      for (const k of Object.keys(total)) total[k] += r[k];
    }
    console.log('RESTORED', JSON.stringify(total));
    return;
  }

  const [shipDateRows, data] = await Promise.all([readShipDates(values.export), loadData(doc, suffix)]);
  const analysis = analyze(data, { shipDateRows, undatedUsed, keepDoNotUse: values['include-do-not-use'] !== true, protectLastLoad: values['ignore-lastloadat'] !== true });
  const { plan, refs, deleted, shipmentInfo } = analysis;
  const names = nameOf(data.carriers);
  const byId = new Map(data.carriers.map((c) => [c.id, c]));
  const status = (id) => byId.get(id)?.status ?? '';

  // ── counts common to every subcommand
  const sCount = (pred) => [...shipmentInfo.values()].filter(pred).length;
  console.log(`carriers ${data.carriers.length} (by status ${JSON.stringify(histogram(data.carriers, (c) => c.status ?? 'NONE'))}); vault rows ${data.vaultIds.length}`);
  console.log(`shipments ${data.shipments.length}: deleted by awPreDelete ${sCount((x) => x.deleted)}; retained dated >= ${CUTOFF} ${sCount((x) => !x.deleted && x.date >= CUTOFF)}; retained dated < ${CUTOFF} ${sCount((x) => !x.deleted && x.date && x.date < CUTOFF)}; retained undated ${sCount((x) => !x.deleted && !x.date)}`);
  console.log(`rows awPreDelete removes: LoadCarrier ${deleted.deletedLoadCarriers.size}, CarrierBill ${deleted.deletedBills.size}, ApPayment ${deleted.deletedApPayments.size}; dangling carrier refs (name no carrier row) ${JSON.stringify(refs.dangling)}`);
  const used = plan.usedIds;
  console.log(`USED since ${CUTOFF} (own computation): ${used.size} carriers (undated retained refs counted as used: ${undatedUsed}); carriers with lastLoadAt >= ${CUTOFF}: ${plan.lastLoadAt.both.length + plan.lastLoadAt.onlyLastLoadAt.length}`);
  console.log(`lastLoadAt vs computed: both ${plan.lastLoadAt.both.length}; used but lastLoadAt older/empty ${plan.lastLoadAt.onlyUsed.length}; lastLoadAt >= cutoff but not used ${plan.lastLoadAt.onlyLastLoadAt.length}`);

  if (sub === 'activate') {
    console.log(`ACTIVATE: ${plan.activate.length} (previous status ${JSON.stringify(histogram(plan.activate, (a) => a.previousStatus ?? 'NONE'))}); already ACTIVE ${plan.alreadyActive.length}; used but DO_NOT_USE (never activated) ${plan.doNotUseUsed.length}`);
    const undated = data.carriers.filter((c) => (refs.byCarrier.get(c.id)?.used ?? 0) === 0 && (refs.byCarrier.get(c.id)?.undated ?? 0) > 0);
    console.log(`  of the used: only via undated retained rows ${undated.filter((c) => used.has(c.id)).length}`);
    writeCsv(f('carriers-activate'), ['carrier id', 'name', 'previous status', 'retained used refs', 'undated refs'], plan.activate.map((a) => [a.id, names.get(a.id), a.previousStatus, refs.byCarrier.get(a.id)?.used ?? 0, refs.byCarrier.get(a.id)?.undated ?? 0]));
    writeCsv(f('carriers-lastloadat-diff'), ['carrier id', 'name', 'status', 'lastLoadAt', 'case'], [
      ...plan.lastLoadAt.onlyUsed.map((id) => [id, names.get(id), status(id), byId.get(id)?.lastLoadAt ?? '', 'used by our computation, lastLoadAt older or empty']),
      ...plan.lastLoadAt.onlyLastLoadAt.map((id) => [id, names.get(id), status(id), byId.get(id)?.lastLoadAt ?? '', 'lastLoadAt >= cutoff, no retained dated use']),
    ]);
    writeCsv(f('carriers-activate-conflicts'), ['carrier id', 'name', 'status', 'issue'], plan.doNotUseUsed.map((id) => [id, names.get(id), status(id), 'used since cutoff but DO_NOT_USE: not activated']));
    console.log(`reports (0600) in ${reportDir}: carriers-activate, carriers-lastloadat-diff, carriers-activate-conflicts (${today})`);
    if (!apply) return console.log(`DRY RUN: nothing written. ${plan.activate.length} carrier(s) would be activated.`);
    const cp = checkpointPath(sub, suffix);
    const done = loadCheckpoint(cp);
    const out = { activated: 0, changedSincePlan: 0, skippedDone: 0 };
    let n = 0;
    for (const entry of plan.activate) {
      if (n >= limit) break;
      if (done.has(entry.id)) { out.skippedDone += 1; continue; }
      n += 1;
      if (await applyActivate({ doc, suffix, entry })) out.activated += 1; else out.changedSincePlan += 1;
      done.add(entry.id);
      if (n % 25 === 0) saveCheckpoint(cp, done);
    }
    saveCheckpoint(cp, done);
    console.log('APPLIED', JSON.stringify(out));
    return;
  }

  if (sub === 'billing') {
    const { parsed, flag1099 } = await readCarrierMasters(values.carriers);
    const activeIds = new Set([...data.carriers.filter((c) => c.status === 'ACTIVE').map((c) => c.id), ...plan.activate.map((a) => a.id)]);
    const deleteIds = new Set(plan.delete.map((d) => d.id));
    const targets = data.carriers.filter((c) => activeIds.has(c.id) && !deleteIds.has(c.id));
    const match = matchMasters(targets, parsed.carriers);
    const matchAll = matchMasters(data.carriers, parsed.carriers);
    console.log(`BILLING: ACTIVE carriers (current ${data.carriers.filter((c) => c.status === 'ACTIVE').length} + to activate ${plan.activate.length}); CSV carriers ${parsed.carriers.length} (rows ${parsed.counts.rows}, merged groups ${parsed.counts.mergeGroups}); matched to a target carrier ${match.matched.size}; CSV carriers matching ANY production carrier ${matchAll.matched.size}; unmatched in production ${matchAll.unmatched.length}; MC/DOT splits ${matchAll.conflicts.length}`);
    const plans = [];
    for (const c of targets) {
      const hit = match.matched.get(c.id);
      if (!hit) continue;
      const p = planBilling(c, hit.master, data.children.CarrierPaymentMethod.get(c.id)?.length ?? 0);
      plans.push({ carrier: c, master: hit.master, plan: p });
    }
    const fieldCounts = {};
    for (const x of plans) for (const k of Object.keys(x.plan.patch)) fieldCounts[k] = (fieldCounts[k] ?? 0) + 1;
    const methods = plans.filter((x) => x.plan.method).length;
    console.log(`  Carrier fields to fill (only where empty): ${JSON.stringify(fieldCounts)}`);
    console.log(`  CarrierPaymentMethod rows to create (payee + remit-to, CHECK, none exist today): ${methods}`);
    console.log(`  existing value differs from Aljex (left alone): ${JSON.stringify(histogram(plans.flatMap((x) => x.plan.differs), (d) => d))}`);
    const tm = plans.filter((x) => match.matched.has(x.carrier.id));
    console.log(`  NO app field, not written (counts of matched target carriers): 1099=Y ${tm.filter((x) => flag1099.get(x.master.id) === 'Y').length}; Quick Pay % ${tm.filter((x) => x.master.quickPay.pct).length}; Factor Id ${tm.filter((x) => x.master.factorId).length} (export has the factor's id only, no factor name/address: CarrierPaymentMethod FACTOR requires factorName); Phone Accounting ${tm.filter((x) => x.master.phoneAccounting).length}; Fax ${tm.filter((x) => x.master.fax).length}`);
    console.log(`  BANK ACCOUNT / ROUTING: no safe store, STOPPED (export rows with bank account ${parsed.counts.sensitiveRows.bankAccount}, routing ${parsed.counts.sensitiveRows.routing}; none read, none written). CarrierTaxVault holds tax ids only (rows today ${data.vaultIds.length}); CarrierPaymentMethod stores last 4 + an S3 document key and refuses full numbers.`);
    console.log('  INSURANCE: the Aljex carriers export (and every other file in ~/aljex-export) has no carrier insurance / policy / expiry column: it stays blank until MyCarrierPackets invites fill it.');
    writeCsv(f('carriers-billing-plan'), ['carrier id', 'name', 'fields to fill', 'payment method', 'differs (left alone)'], plans.filter((x) => Object.keys(x.plan.patch).length || x.plan.method || x.plan.differs.length).map((x) => [x.carrier.id, x.carrier.name, Object.keys(x.plan.patch).join('|'), x.plan.method ? 'CHECK payee + remit-to' : '', x.plan.differs.join('|')]));
    writeCsv(f('carriers-billing-unmatched'), ['aljex carrier id', 'name', 'reason'], [
      ...matchAll.unmatched.map((id) => { const m = parsed.carriers.find((x) => x.id === id); return [id, m?.name ?? '', 'no production carrier by MC/DOT/Aljex id']; }),
      ...matchAll.conflicts.map((id) => { const m = parsed.carriers.find((x) => x.id === id); return [id, m?.name ?? '', 'MC and DOT resolve to different production carriers']; }),
      ...targets.filter((c) => !match.matched.has(c.id)).map((c) => [c.aljexCode ?? '', c.name, 'ACTIVE target carrier with no Aljex carriers-export row']),
    ]);
    console.log(`reports (0600) in ${reportDir}: carriers-billing-plan, carriers-billing-unmatched (${today})`);
    if (!apply) return console.log(`DRY RUN: nothing written. ${plans.filter((x) => Object.keys(x.plan.patch).length || x.plan.method).length} carrier(s) would be enriched.`);
    const cp = checkpointPath(sub, suffix);
    const done = loadCheckpoint(cp);
    const out = { carriers: 0, fields: 0, methods: 0, alreadyFilled: 0, skippedDone: 0 };
    let n = 0;
    for (const x of plans) {
      if (!Object.keys(x.plan.patch).length && !x.plan.method) continue;
      if (n >= limit) break;
      if (done.has(x.carrier.id)) { out.skippedDone += 1; continue; }
      n += 1;
      const r = await applyBilling({ doc, suffix, carrier: x.carrier, plan: x.plan });
      out.carriers += r.fields || r.method ? 1 : 0;
      out.fields += r.fields; out.methods += r.method; out.alreadyFilled += r.lost;
      done.add(x.carrier.id);
      if (n % 25 === 0) saveCheckpoint(cp, done);
    }
    saveCheckpoint(cp, done);
    console.log('APPLIED', JSON.stringify(out));
    return;
  }

  const vaultSet = new Set(data.vaultIds);
  const sumKids = (ids, t) => ids.reduce((n, id) => n + (data.children[t].get(id)?.length ?? 0), 0);
  const synced = (id) => isMcpSynced(byId.get(id));

  if (sub === 'inactivate') {
    const never = plan.neverSyncedReferenced;
    console.log(`INACTIVATE: referenced + never MCP-synced carriers ${never.length} (by status ${JSON.stringify(histogram(never.map((id) => byId.get(id)), (c) => c.status ?? 'NONE'))}); to set INACTIVE ${plan.inactivate.length}; already INACTIVE ${never.length - plan.inactivate.length}`);
    writeCsv(f('carriers-inactivate'), ['carrier id', 'name', 'previous status', 'retained refs (table:count)'], plan.inactivate.map((a) => [a.id, names.get(a.id), a.previousStatus, Object.entries(refs.byCarrier.get(a.id)?.retained ?? {}).map(([t, n]) => `${t}:${n}`).join(' | ')]));
    console.log(`reports (0600) in ${reportDir}: carriers-inactivate (${today})`);
    if (!apply) return console.log(`DRY RUN: nothing written. ${plan.inactivate.length} carrier(s) would be set INACTIVE.`);
    const cp = checkpointPath(sub, suffix);
    const done = loadCheckpoint(cp);
    const out = { inactivated: 0, changedSincePlan: 0, skippedDone: 0 };
    let n = 0;
    for (const entry of plan.inactivate) {
      if (n >= limit) break;
      if (done.has(entry.id)) { out.skippedDone += 1; continue; }
      n += 1;
      if (await applyInactivate({ doc, suffix, entry })) out.inactivated += 1; else out.changedSincePlan += 1;
      done.add(entry.id);
      if (n % 25 === 0) saveCheckpoint(cp, done);
    }
    saveCheckpoint(cp, done);
    console.log('APPLIED', JSON.stringify(out));
    return;
  }

  // ── delete
  const refTotals = {};
  for (const k of plan.keep) for (const r of k.reasons) refTotals[r.table] = (refTotals[r.table] ?? 0) + 1;
  const carrierIds = new Set(data.carriers.map((c) => c.id));
  const orphanVault = data.vaultIds.filter((id) => !carrierIds.has(id));
  const delNow = plan.delete.filter((d) => !d.blockedNow);
  const delAfter = plan.delete.filter((d) => d.blockedNow);
  const clsA = plan.delete.filter((d) => d.cls === 'A');
  const clsB = plan.delete.filter((d) => d.cls === 'B');
  const delIds = plan.delete.map((d) => d.id);
  console.log(`MCP-synced carriers (mcpSyncedAt/mcpSyncRunId set) ${data.carriers.filter(isMcpSynced).length}; never synced ${data.carriers.filter((c) => !isMcpSynced(c)).length}`);
  console.log(`DELETE A (never MCP-synced, unreferenced): ${clsA.length} (by status ${JSON.stringify(histogram(clsA, (d) => d.status ?? 'NONE'))})`);
  console.log(`DELETE B (MCP-synced, unused, unreferenced): ${clsB.length} (by status ${JSON.stringify(histogram(clsB, (d) => d.status ?? 'NONE'))})`);
  console.log(`DELETE total ${plan.delete.length}; deletable today ${delNow.length}; only after awPreDelete (still referenced by rows it deletes) ${delAfter.length}`);
  console.log(`  child rows that go with them: ${CHILD_TABLES.map((t) => `${t} ${sumKids(delIds, t)}`).join(', ')}; vault rows ${plan.delete.filter((d) => vaultSet.has(d.id)).length}; orphan vault rows (no carrier row) ${orphanVault.length}`);
  console.log(`  of the deletes, carriers with the most child rows in one transaction: ${Math.max(0, ...plan.delete.map((d) => 3 + Object.values(d.children).reduce((a, b) => a + b, 0)))} items`);
  const lastLoadKept = plan.keep.filter((k) => k.reasons.some((r) => r.table === 'Carrier.lastLoadAt'));
  console.log(`KEPT (not used, not deleted): ${plan.keep.length}; by reason ${JSON.stringify(refTotals)}; kept ONLY for lastLoadAt >= ${CUTOFF} (would be class B/A with --ignore-lastloadat): ${lastLoadKept.filter((k) => k.reasons.length === 1).length} (synced ${lastLoadKept.filter((k) => k.reasons.length === 1 && synced(k.id)).length})`);
  console.log(`KEPT referenced + never synced -> INACTIVE (separate subcommand): ${plan.neverSyncedReferenced.length} (to set ${plan.inactivate.length}, by status ${JSON.stringify(histogram(plan.inactivate, (a) => a.previousStatus ?? 'NONE'))}; already INACTIVE ${plan.neverSyncedReferenced.length - plan.inactivate.length})`);
  console.log(`KEPT used since ${CUTOFF} (never deleted, status untouched here): ${used.size}; of which never MCP-synced ${[...used].filter((id) => !synced(id)).length}`);
  const proof = conservation(data, analysis, delIds);
  console.log(`CONSERVATION: carriers ${proof.carriersBefore} -> ${proof.carriersAfter} (-${plan.delete.length}); vault rows ${proof.vaultRowsBefore} -> ${proof.vaultRowsAfter}; retained references ${JSON.stringify(proof.rows)}; retained open AP ${proof.openApCentsRetained} cents before = after (no bill is written); ok ${proof.ok}`);
  if (values['not-in-mcp']) {
    const keys = await readNotInMcp(values['not-in-mcp']);
    const inList = (id) => { const c = byId.get(id); const mc = digits(c.mcNumber); const dot = digits(c.dotNumber); return (mc && keys.mc.has(mc)) || (dot && keys.dot.has(dot)); };
    console.log(`CROSS-CHECK vs the not-in-MCP list (${keys.rows} rows): delete A in that list ${clsA.filter((d) => inList(d.id)).length}/${clsA.length}; delete B in that list ${clsB.filter((d) => inList(d.id)).length}/${clsB.length}; to-INACTIVE in that list ${plan.inactivate.filter((a) => inList(a.id)).length}/${plan.inactivate.length}. Deleted carriers NOT in that list are in Ryne's MCP monitored list (a full pull would re-create them).`);
  }
  writeCsv(f('carriers-delete'), ['carrier id', 'name', 'class', 'status', 'timing', 'vault row', 'contacts', 'payment methods', 'documents'], plan.delete.map((d) => [d.id, names.get(d.id), d.cls, d.status, d.blockedNow ? 'only after awPreDelete' : 'now', vaultSet.has(d.id) ? 'yes' : 'no', d.children.CarrierContact ?? 0, d.children.CarrierPaymentMethod ?? 0, d.children.CarrierDocument ?? 0]));
  writeCsv(f('carriers-kept-referenced'), ['carrier id', 'name', 'status', 'kept because (table:count)'], plan.keep.map((k) => [k.id, names.get(k.id), k.status, k.reasons.map((r) => `${r.table}:${r.count}${r.why ? ` (${r.why})` : ''}`).join(' | ')]));
  console.log(`reports (0600) in ${reportDir}: carriers-delete, carriers-kept-referenced (${today})`);
  if (!apply) return console.log(`DRY RUN: nothing written. ${plan.delete.length} carrier(s) would be deleted with their child rows (${delAfter.length} of them only once awPreDelete has run). Carrier rows after: ${proof.carriersAfter}.`);

  const toDelete = delNow.slice(0, Number.isFinite(limit) ? limit : undefined);
  if (delAfter.length) console.log(`REFUSED ${delAfter.length} carrier(s) still referenced by rows awPreDelete has not deleted yet: run awPreDelete first, then re-run this.`);
  const rows = toDelete.map((d) => byId.get(d.id));
  const ids = new Set(toDelete.map((d) => d.id));
  const kidRows = Object.fromEntries(CHILD_TABLES.map((t) => [t, [...ids].flatMap((id) => data.children[t].get(id) ?? [])]));
  const { target, manifest } = writeExport({ dir: values['export-dir'] ?? defaultExportDir(), carriers: rows, children: kidRows, vaultCarrierIds: toDelete.filter((d) => vaultSet.has(d.id)).map((d) => d.id), suffix });
  console.log(`exported ${manifest.counts.carriers} carrier rows (inactive ${manifest.counts.inactive}, vault ids ${manifest.counts.vaultRows}, ${CHILD_TABLES.map((t) => `${t} ${manifest.counts[t]}`).join(', ')}) to ${target} (dir 0700, files 0600, manifest sha256 verified)`);
  const cp = checkpointPath(sub, suffix);
  const done = loadCheckpoint(cp);
  const out = { deleted: 0, vaultDeleted: 0, childrenDeleted: 0, refused: 0, skippedDone: 0 };
  const refusals = {};
  let n = 0;
  for (const entry of toDelete) {
    if (done.has(entry.id)) { out.skippedDone += 1; continue; }
    n += 1;
    const r = await applyDelete({ doc, suffix, entry, carrier: byId.get(entry.id), children: Object.fromEntries(CHILD_TABLES.map((t) => [t, data.children[t].get(entry.id) ?? []])), hasVault: vaultSet.has(entry.id), exportName: target.split('/').pop() });
    if (r.deleted) { out.deleted += 1; out.childrenDeleted += Object.values(r.children).reduce((a, b) => a + b, 0); if (vaultSet.has(entry.id)) out.vaultDeleted += 1; } else { out.refused += 1; refusals[r.refused] = (refusals[r.refused] ?? 0) + 1; }
    done.add(entry.id);
    if (n % 25 === 0) saveCheckpoint(cp, done);
  }
  for (const id of orphanVault) {
    await doc.send(new DeleteCommand({ TableName: tableName('CarrierTaxVault', suffix), Key: { carrierId: id } }));
    out.vaultDeleted += 1;
  }
  saveCheckpoint(cp, done);
  console.log('APPLIED', JSON.stringify(out), JSON.stringify(refusals));
  // Post-apply proof from live tables: every retained reference still resolves its carrier.
  const after = await loadData(doc, suffix);
  const afterIds = new Set(after.carriers.map((c) => c.id));
  const dangling = (rs) => rs.filter((r) => r.carrierId && !afterIds.has(r.carrierId)).length;
  const danglingBefore = (rs) => rs.filter((r) => r.carrierId && !carrierIds.has(r.carrierId)).length;
  const orphanKids = CHILD_TABLES.map((t) => `${t} ${[...after.children[t].keys()].filter((id) => !afterIds.has(id)).length}`).join(', ');
  console.log(`PROOF (live): carriers ${data.carriers.length} -> ${after.carriers.length}; vault rows ${data.vaultIds.length} -> ${after.vaultIds.length}; dangling carrier refs LoadCarrier ${danglingBefore(data.loadCarriers)} -> ${dangling(after.loadCarriers)}, CarrierBill ${danglingBefore(data.bills)} -> ${dangling(after.bills)}, ApPayment ${danglingBefore(data.apPayments)} -> ${dangling(after.apPayments)}; open AP ${openApCents(data.bills)} -> ${openApCents(after.bills)} cents; child rows left without a carrier: ${orphanKids}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
