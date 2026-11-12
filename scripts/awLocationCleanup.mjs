#!/usr/bin/env node
/**
 * Location directory cleanup: archive address-less unreferenced Location rows and merge exact duplicates (dry by default, prod-gated apply).
 *
 *   dry run (read-only; prints the plan and writes the markdown report + review CSV, mode 0600):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awLocationCleanup.mjs --target prod --i-mean-production
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awLocationCleanup --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-locationcleanup node scripts/awLocationCleanup.mjs \
 *       --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *   rollback (reads this script's own AuditLog rows; reverses Loads, then survivors, then archived/frozen rows):
 *     the apply command with --rollback instead of --apply
 *
 * What it writes (Location, Load, AuditLog only; see lib/locationCleanupPlan.mjs for the classes):
 *   ARCHIVE   Location.active=false on a row with NO address that no load, customer, contact or note uses. Never a hard delete.
 *   MERGE     the way the app's MERGE_LOCATIONS does it: the survivor is first ENRICHED (blank fields filled, customerIds / aliases /
 *             contacts / driverNotes unioned; differing values are never overwritten), then each duplicate is FROZEN (mergedIntoId,
 *             mergeJobId, active=false), then every Load stop pointing at it is repointed to the survivor (stops[].locationId, and
 *             address.mergedFromLocationId = the old id, exactly as the app writes it).
 * Every write is conditional on the row still being what the plan read (updatedAt, and the stops value for a Load), so a row someone edited
 * meanwhile is skipped and reported, not clobbered; one AuditLog row per write carries the previous values (rollback reads them).
 * A re-run after an interruption first finishes the repoints of duplicates this script already froze.
 * The review classes (address-less but used, ambiguous folds, typo variants, same address under different names) are LISTED ONLY.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { loadStops, scanAll } from './awLocationRename.mjs';
import { cleanedCount, planCleanup } from './lib/locationCleanupPlan.mjs';

export const SCRIPT = 'awLocationCleanup';
export const AUDIT_ACTION = 'AW_LOCATION_CLEANUP';
export const AUDIT_USER = 'system:awLocationCleanup';
export const jobIdFor = (date) => `awLocationCleanup-${date}`;
const LOCATION_PROJECTION = [
  'id', 'name', 'street', 'city', 'state', 'zip', 'country', 'active', 'mergedIntoId', 'mergeJobId', 'createdAt', 'updatedAt',
  'customerIds', 'aliases', 'contacts', 'driverNotes', 'customerName', 'apptContactName', 'apptContactEmail', 'apptContactPhone', 'notes', 'hours',
  'apptRule', 'apptLeadTimeHours', 'dockNotes', 'lumperNotes', 'detentionNotes', 'facilityType', 'timezone', 'lat', 'lng', 'placeId', 'geohash6',
  'geocodedAt', 'geocodeExpiresAt',
];

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function locationCleanupGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awLocationCleanup.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-locationcleanup`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
  }
  return gate;
}

const isCondFail = (err) => err?.name === 'ConditionalCheckFailedException';
const audit = (doc, suffix, entityType, entityId, kind, payload, nowIso) => doc.send(new PutCommand({
  TableName: `AuditLog-${suffix}`,
  Item: { id: randomUUID(), __typename: 'AuditLog', entityType, entityId, action: AUDIT_ACTION, user: AUDIT_USER, changes: JSON.stringify({ kind, ...payload }), createdAt: nowIso, updatedAt: nowIso },
}));
const updatedAtCond = (row, names, values) => {
  names['#ou'] = 'updatedAt';
  if (row.updatedAt) { values[':ou'] = row.updatedAt; return '#ou = :ou'; }
  return 'attribute_not_exists(#ou)';
};

/** ARCHIVE one address-less unused Location. -> 'written' | 'lost' */
export async function applyArchive({ doc, suffix, row, now = new Date() }) {
  assertWritableSuffix(suffix, 'location cleanup');
  const nowIso = now.toISOString();
  const names = { '#act': 'active', '#mi': 'mergedIntoId', '#ua': 'updatedAt', '#ub': 'updatedBy' };
  const values = { ':f': false, ':ua': nowIso, ':ub': AUDIT_USER };
  const conds = ['attribute_exists(id)', 'attribute_not_exists(#mi)', '(attribute_not_exists(#act) OR #act <> :f)', updatedAtCond(row, names, values)];
  try {
    await doc.send(new UpdateCommand({
      TableName: `Location-${suffix}`, Key: { id: row.id }, UpdateExpression: 'SET #act = :f, #ua = :ua, #ub = :ub', ConditionExpression: conds.join(' AND '),
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
  } catch (err) { if (isCondFail(err)) return 'lost'; throw err; }
  await audit(doc, suffix, 'LOCATION', row.id, 'ARCHIVE', { previous: { active: row.active ?? null, updatedAt: row.updatedAt ?? null }, next: { active: false, updatedAt: nowIso }, name: row.name ?? null }, nowIso);
  return 'written';
}

/** ENRICH one survivor from its sources. -> 'written' | 'lost' | 'noop' */
export async function applyEnrich({ doc, suffix, row, set, sourceIds, now = new Date() }) {
  assertWritableSuffix(suffix, 'location cleanup');
  const fields = Object.keys(set);
  if (!fields.length) return 'noop';
  const nowIso = now.toISOString();
  const names = { '#ua': 'updatedAt', '#ub': 'updatedBy' };
  const values = { ':ua': nowIso, ':ub': AUDIT_USER };
  const sets = ['#ua = :ua', '#ub = :ub'];
  fields.forEach((f, i) => { names[`#f${i}`] = f; values[`:v${i}`] = set[f]; sets.push(`#f${i} = :v${i}`); });
  const conds = ['attribute_exists(id)', updatedAtCond(row, names, values)];
  try {
    await doc.send(new UpdateCommand({ TableName: `Location-${suffix}`, Key: { id: row.id }, UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: conds.join(' AND '), ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
  } catch (err) { if (isCondFail(err)) return 'lost'; throw err; }
  await audit(doc, suffix, 'LOCATION', row.id, 'ENRICH_SURVIVOR', {
    previous: Object.fromEntries(fields.map((f) => [f, row[f] ?? null])), next: set, sourceIds, previousUpdatedAt: row.updatedAt ?? null, updatedAt: nowIso,
  }, nowIso);
  return 'written';
}

/** FREEZE one duplicate the way MERGE_LOCATIONS does. -> 'written' | 'lost' */
export async function applyFreeze({ doc, suffix, row, targetId, jobId, now = new Date() }) {
  assertWritableSuffix(suffix, 'location cleanup');
  if (row.id === targetId) throw new Error('refusing to merge a location into itself');
  const nowIso = now.toISOString();
  const names = { '#mi': 'mergedIntoId', '#mj': 'mergeJobId', '#act': 'active', '#ua': 'updatedAt', '#ub': 'updatedBy' };
  const values = { ':t': targetId, ':j': jobId, ':f': false, ':ua': nowIso, ':ub': AUDIT_USER, ':nul': null };
  const conds = ['attribute_exists(id)', '(attribute_not_exists(#mi) OR #mi = :nul)', '(attribute_not_exists(#act) OR #act <> :f)', updatedAtCond(row, names, values)];
  try {
    await doc.send(new UpdateCommand({
      TableName: `Location-${suffix}`, Key: { id: row.id }, UpdateExpression: 'SET #mi = :t, #mj = :j, #act = :f, #ua = :ua, #ub = :ub', ConditionExpression: conds.join(' AND '),
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
  } catch (err) { if (isCondFail(err)) return 'lost'; throw err; }
  await audit(doc, suffix, 'LOCATION', row.id, 'MERGE_SOURCE', {
    previous: { active: row.active ?? null, mergedIntoId: row.mergedIntoId ?? null, mergeJobId: row.mergeJobId ?? null, updatedAt: row.updatedAt ?? null },
    next: { active: false, mergedIntoId: targetId, mergeJobId: jobId, updatedAt: nowIso }, targetId, name: row.name ?? null,
  }, nowIso);
  return 'written';
}

/** Stops with source -> target, in the stored representation. -> { stops (same representation), previous } or null when no stop points at source. */
export function repointedStops(load, sourceId, targetId) {
  let v = load.stops;
  const asString = typeof v === 'string';
  if (asString) { try { v = JSON.parse(v); } catch { return null; } }
  if (!Array.isArray(v) || !v.some((s) => s && typeof s === 'object' && s.locationId === sourceId)) return null;
  const next = v.map((s) => (s && typeof s === 'object' && s.locationId === sourceId ? { ...s, locationId: targetId, address: { ...(s.address ?? {}), mergedFromLocationId: sourceId } } : s));
  return asString ? JSON.stringify(next) : next;
}

/** REPOINT one Load's stops from source to target, retrying on a concurrent edit. -> 'written' | 'gone' | 'lost' */
export async function applyRepoint({ doc, suffix, load, sourceId, targetId, now = new Date(), attempts = 3 }) {
  assertWritableSuffix(suffix, 'location cleanup');
  let current = load;
  for (let i = 0; i < attempts; i += 1) {
    const nextStops = repointedStops(current, sourceId, targetId);
    if (nextStops === null) return 'gone';
    const nowIso = now.toISOString();
    const names = { '#st': 'stops', '#ua': 'updatedAt', '#ub': 'updatedBy' };
    const values = { ':ns': nextStops, ':os': current.stops, ':ua': nowIso, ':ub': AUDIT_USER };
    const conds = ['attribute_exists(id)', '#st = :os', updatedAtCond(current, names, values)];
    try {
      await doc.send(new UpdateCommand({
        TableName: `Load-${suffix}`, Key: { id: current.id }, UpdateExpression: 'SET #st = :ns, #ua = :ua, #ub = :ub', ConditionExpression: conds.join(' AND '),
        ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      }));
    } catch (err) {
      if (!isCondFail(err)) throw err;
      const fresh = (await doc.send(new GetCommand({ TableName: `Load-${suffix}`, Key: { id: current.id } }))).Item;
      if (!fresh) return 'gone';
      current = fresh;
      continue;
    }
    await audit(doc, suffix, 'LOAD', current.id, 'REPOINT_LOAD', { previous: { stops: current.stops, updatedAt: current.updatedAt ?? null }, next: { stops: nextStops, updatedAt: nowIso }, sourceId, targetId }, nowIso);
    return 'written';
  }
  return 'lost';
}

/** Duplicates this script already froze (mergeJobId from a previous run) whose Load stops still point at them. -> [{ sourceId, targetId, loadIds }] */
export function planResume(locations, loads) {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const frozen = locations.filter((l) => l.mergedIntoId && String(l.mergeJobId ?? '').startsWith('awLocationCleanup-'));
  const resolve = (id) => { let cur = byId.get(id); const seen = new Set(); while (cur?.mergedIntoId && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.mergedIntoId); } return cur; };
  return frozen.flatMap((f) => {
    const target = resolve(f.id);
    if (!target || target.id === f.id) return [];
    const loadIds = loads.filter((ld) => loadStops(ld).some((s) => s.locationId === f.id)).map((ld) => ld.id);
    return loadIds.length ? [{ sourceId: f.id, targetId: target.id, loadIds }] : [];
  });
}

// ── rollback from this script's own AuditLog rows ─────────────────────────────────────────────────────────────────────────────────
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Reverse every write of a previous apply: Loads first, then survivors, then frozen/archived rows. -> counts */
export async function rollbackAll({ doc, suffix, auditRows, now = new Date() }) {
  assertWritableSuffix(suffix, 'location cleanup rollback');
  const nowIso = now.toISOString();
  const rows = auditRows.map((r) => ({ ...r, c: JSON.parse(r.changes) })).filter((r) => r.user === AUDIT_USER && r.action === AUDIT_ACTION);
  const order = { REPOINT_LOAD: 0, ENRICH_SURVIVOR: 1, MERGE_SOURCE: 2, ARCHIVE: 2 };
  rows.sort((a, b) => (order[a.c.kind] ?? 9) - (order[b.c.kind] ?? 9) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const out = { restored: 0, skipped: 0 };
  for (const r of rows) {
    const { c } = r;
    try {
      if (c.kind === 'REPOINT_LOAD') {
        await doc.send(new UpdateCommand({
          TableName: `Load-${suffix}`, Key: { id: r.entityId }, UpdateExpression: 'SET #st = :p, #ua = :ua, #ub = :ub', ConditionExpression: '#st = :n',
          ExpressionAttributeNames: { '#st': 'stops', '#ua': 'updatedAt', '#ub': 'updatedBy' }, ExpressionAttributeValues: { ':p': c.previous.stops, ':n': c.next.stops, ':ua': nowIso, ':ub': AUDIT_USER },
        }));
      } else if (c.kind === 'ENRICH_SURVIVOR') {
        const names = { '#ua': 'updatedAt', '#ub': 'updatedBy' };
        const values = { ':ua': nowIso, ':ub': AUDIT_USER };
        const sets = ['#ua = :ua', '#ub = :ub']; const removes = []; const conds = [];
        Object.keys(c.next).forEach((f, i) => {
          names[`#f${i}`] = f; values[`:n${i}`] = c.next[f]; conds.push(`#f${i} = :n${i}`);
          if (c.previous[f] == null) removes.push(`#f${i}`); else { values[`:p${i}`] = c.previous[f]; sets.push(`#f${i} = :p${i}`); }
        });
        await doc.send(new UpdateCommand({
          TableName: `Location-${suffix}`, Key: { id: r.entityId }, UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`, ConditionExpression: conds.join(' AND '),
          ExpressionAttributeNames: names, ExpressionAttributeValues: values,
        }));
      } else if (c.kind === 'MERGE_SOURCE') {
        const names = { '#mi': 'mergedIntoId', '#mj': 'mergeJobId', '#act': 'active', '#ua': 'updatedAt', '#ub': 'updatedBy' };
        const values = { ':t': c.next.mergedIntoId, ':ua': nowIso, ':ub': AUDIT_USER, ':a': c.previous.active ?? true };
        await doc.send(new UpdateCommand({
          TableName: `Location-${suffix}`, Key: { id: r.entityId }, UpdateExpression: 'SET #act = :a, #ua = :ua, #ub = :ub REMOVE #mi, #mj', ConditionExpression: '#mi = :t',
          ExpressionAttributeNames: names, ExpressionAttributeValues: values,
        }));
      } else if (c.kind === 'ARCHIVE') {
        await doc.send(new UpdateCommand({
          TableName: `Location-${suffix}`, Key: { id: r.entityId }, UpdateExpression: 'SET #act = :a, #ua = :ua, #ub = :ub', ConditionExpression: '#act = :f',
          ExpressionAttributeNames: { '#act': 'active', '#ua': 'updatedAt', '#ub': 'updatedBy' }, ExpressionAttributeValues: { ':a': c.previous.active ?? true, ':f': false, ':ua': nowIso, ':ub': AUDIT_USER },
        }));
      } else { out.skipped += 1; continue; }
      out.restored += 1;
    } catch (err) {
      if (isCondFail(err)) { out.skipped += 1; continue; }
      throw err;
    }
  }
  return out;
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const blank = (v) => (v == null ? '' : String(v));
export function renderReport({ plan, resume, today, suffix, royal }) {
  const c = plan.counts;
  const L = [];
  L.push(`# Location cleanup: dry run ${today} (${suffix})`, '', 'Read-only. Nothing was written.', '');
  L.push('## Counts', '');
  L.push(`- Location rows: ${c.locationsTotal} (live ${c.live}; already archived or merged ${c.alreadyMergedOrArchived})`);
  L.push(`- No street address (a city or zip alone does not count): ${c.noAddress} (${c.noAddressWithCity} have a city)`);
  L.push(`  - unused (no load, contact or note) and archived: ${c.archive}`);
  L.push(`  - used by loads or carrying contacts/notes, so kept (review list below): ${c.noAddressKept}`);
  L.push(`- Same place listed more than once, merged into one: ${c.exactDuplicateRows + c.samePlaceRows} rows (${c.exactDuplicateRows} exact copies, ${c.samePlaceRows} spelling/truncation variants of the same street address), ${plan.survivors.filter((s) => plan.merges.some((m) => m.survivorId === s.id && m.kind !== 'FOLD')).length} survivors`);
  L.push(`- Street-less rows folded into the one address their name and city already has: ${c.foldRows}`);
  L.push(`- Loads whose stops would be repointed: ${c.loadsToRepoint}`);
  L.push(`- Review only (never written): ambiguous folds ${c.reviewAmbiguousFold}; likely the same place but the street differs ${c.reviewLikelySamePlace}; possible typo variants ${c.reviewPossibleTypo}; same address under different names ${c.reviewSameAddressDifferentName}`);
  L.push(`- Unfinished repoints from an earlier run: ${resume.length}`);
  L.push(`- Rows the autocomplete would list after cleanup: ${cleanedCount(plan)} (now ${c.live})`, '');
  const conflicts = plan.survivors.filter((s) => s.conflicts.length);
  L.push('## Survivors whose duplicate holds DIFFERENT data (nothing is overwritten; Ryne may want to look)', '');
  if (!conflicts.length) L.push('None.');
  for (const s of conflicts.slice(0, 40)) L.push(`- ${s.id} (${blank(plan.byId.get(s.id)?.name)}): ${s.conflicts.map((x) => `${x.field}: "${blank(x.survivor)}" vs "${blank(x.source)}" (${x.sourceId})`).join('; ')}`);
  L.push('', '## What gets copied onto survivors', '');
  const fill = {};
  for (const s of plan.survivors) for (const f of Object.keys(s.set)) fill[f] = (fill[f] ?? 0) + 1;
  L.push(Object.keys(fill).length ? Object.entries(fill).map(([f, n]) => `- ${f}: ${n} survivor(s)`).join('\n') : 'Nothing to copy.');
  if (royal.length) {
    L.push('', '## THE ROYAL GROUP (the autocomplete in the screenshot)', '');
    for (const r of royal) L.push(`- ${r.id} | ${r.name} | ${[r.street, r.city, r.state, r.zip].map(blank).filter(Boolean).join(', ') || '(no address)'} | loads by id ${r.loads} | plan: ${r.plan}`);
  }
  L.push('', '## Largest duplicate groups', '');
  const bySurvivor = new Map();
  for (const m of plan.merges) bySurvivor.set(m.survivorId, [...(bySurvivor.get(m.survivorId) ?? []), m]);
  for (const [sid, ms] of [...bySurvivor.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 25)) {
    const s = plan.byId.get(sid);
    L.push(`- ${blank(s?.name)} | ${[s?.street, s?.city, s?.state].map(blank).filter(Boolean).join(', ') || '(no street)'}: keep ${sid}, merge ${ms.length} (${ms.map((m) => m.kind).join(',')})`);
  }
  L.push('', '## Review only: likely the same place, street differs (same number and zip, or same street in another zip)', '');
  for (const p of plan.review.likelySamePlace.slice(0, 60)) L.push(`- ${p.a.name} | ${p.a.street} (${p.a.id}) / ${p.b.name} | ${p.b.street} (${p.b.id}) zip ${p.zip}`);
  L.push('', '## Review only: typo variants (same city)', '');
  for (const p of plan.review.possibleTypo.slice(0, 60)) L.push(`- ${p.a.name} (${p.a.id}) / ${p.b.name} (${p.b.id}) in ${p.city}`);
  L.push('', '## Review only: address-less but used', '');
  for (const p of plan.review.noAddressReferenced.slice(0, 60)) L.push(`- ${p.name} (${p.id}): ${p.stopLoads} load(s) by id, ${p.nameLoads} by name${p.hasData ? ', has linked data' : ''}`);
  return `${L.join('\n')}\n`;
}

const writePrivate = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, { mode: 0o600 }); chmodSync(path, 0o600); };
const checkpointPath = (suffix) => join(homedir(), 'bcat-ops-backups', `aw-location-cleanup-${suffix}.checkpoint.json`);
const loadCheckpoint = (p) => (existsSync(p) ? new Set(JSON.parse(readFileSync(p, 'utf8')).done ?? []) : new Set());
const saveCheckpoint = (p, done) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }), { mode: 0o600 }); };

async function main() {
  const { values } = parseArgs({
    options: { apply: { type: 'boolean' }, rollback: { type: 'boolean' }, suffix: { type: 'string' }, 'report-file': { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Usage: node scripts/awLocationCleanup.mjs [--report-file <md>] [--apply | --rollback --apply] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply. --rollback (with --apply) reverses this script's own writes from its AuditLog rows.`);
    return;
  }
  const gate = await locationCleanupGate({ ...values, apply: values.apply });
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

  if (values.rollback) {
    if (!apply) { console.log('ROLLBACK DRY RUN: pass --apply with --rollback to reverse this script\'s writes.'); return; }
    const rows = (await doc.send(new ScanCommand({ TableName: T('AuditLog'), FilterExpression: '#u = :u AND #a = :a', ExpressionAttributeNames: { '#u': 'user', '#a': 'action' }, ExpressionAttributeValues: { ':u': AUDIT_USER, ':a': AUDIT_ACTION } }))).Items ?? [];
    console.log(`ROLLBACK: ${rows.length} audit row(s)`, JSON.stringify(await rollbackAll({ doc, suffix, auditRows: rows })));
    return;
  }

  const locations = await scanAll(doc, T('Location'), LOCATION_PROJECTION);
  const loads = await scanAll(doc, T('Load'), ['id', 'shipmentId', 'stops', 'originName', 'originCity', 'destinationName', 'destinationCity', 'updatedAt']);
  console.log(`Location rows ${locations.length}; Load rows ${loads.length}`);
  const plan = planCleanup(locations, loads);
  const resume = planResume(locations, loads);
  const royal = locations.filter((l) => /royal/i.test(blank(l.name))).map((l) => ({
    id: l.id, name: blank(l.name), street: l.street, city: l.city, state: l.state, zip: l.zip,
    loads: plan.refs.get(l.id)?.stopLoads.size ?? 0,
    plan: plan.archive.some((a) => a.id === l.id) ? 'ARCHIVE' : plan.merges.find((m) => m.sourceId === l.id) ? `MERGE into ${plan.merges.find((m) => m.sourceId === l.id).survivorId}` : plan.survivors.some((s) => s.id === l.id) ? 'KEEP (survivor)' : l.active === false || l.mergedIntoId ? 'already archived/merged' : 'keep',
  }));
  const md = values['report-file'] ?? '/private/tmp/locdup-report.md';
  writePrivate(md, renderReport({ plan, resume, today, suffix, royal }));
  console.log(JSON.stringify(plan.counts, null, 2));
  console.log(`unfinished repoints from an earlier run: ${resume.length}; report: ${md}`);

  if (!apply) { console.log('DRY RUN: nothing written.'); return; }

  const jobId = jobIdFor(today);
  const cpPath = checkpointPath(suffix);
  const done = loadCheckpoint(cpPath);
  const loadById = new Map(loads.map((l) => [l.id, l]));
  const out = { archived: 0, enriched: 0, frozen: 0, repointed: 0, lost: 0, skippedDone: 0 };
  const step = async (key, fn, okKey) => {
    if (done.has(key)) { out.skippedDone += 1; return; }
    const r = await fn();
    if (r === 'written' || r === 'gone' || r === 'noop') { if (r === 'written') out[okKey] += 1; done.add(key); } else out.lost += 1;
    saveCheckpoint(cpPath, done);
  };
  for (const a of plan.archive) await step(`archive:${a.id}`, () => applyArchive({ doc, suffix, row: plan.byId.get(a.id) }), 'archived');
  for (const s of plan.survivors) {
    await step(`enrich:${s.id}`, () => applyEnrich({ doc, suffix, row: plan.byId.get(s.id), set: s.set, sourceIds: s.sourceIds }), 'enriched');
  }
  for (const m of plan.merges) {
    await step(`freeze:${m.sourceId}`, () => applyFreeze({ doc, suffix, row: plan.byId.get(m.sourceId), targetId: m.survivorId, jobId }), 'frozen');
    if (!done.has(`freeze:${m.sourceId}`)) continue;
    for (const loadId of m.loadIds) await step(`repoint:${loadId}:${m.sourceId}`, () => applyRepoint({ doc, suffix, load: loadById.get(loadId), sourceId: m.sourceId, targetId: m.survivorId }), 'repointed');
  }
  for (const r of resume) {
    for (const loadId of r.loadIds) await step(`repoint:${loadId}:${r.sourceId}`, async () => {
      const fresh = (await doc.send(new GetCommand({ TableName: T('Load'), Key: { id: loadId } }))).Item;
      return fresh ? applyRepoint({ doc, suffix, load: fresh, sourceId: r.sourceId, targetId: r.targetId }) : 'gone';
    }, 'repointed');
  }
  console.log('APPLIED', JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
