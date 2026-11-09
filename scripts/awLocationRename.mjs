#!/usr/bin/env node
/**
 * Facility-name fix for Location rows whose NAME is a street address (dry by default, prod-gated apply). ENRICH ONLY, the approved rows in RENAMES.
 *
 *   dry run (read-only; prints before/after + counts, writes the address-name scan CSV mode 0600 into --report-dir):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/awLocationRename.mjs --target prod --i-mean-production
 *   backup (once, < 6 h before the apply):
 *     BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script awLocationRename --target prod --i-mean-production --apply
 *   apply:
 *     BCAT_ALLOW_PROD=$(date +%F) AW_PROD_CONFIRM=$(date +%F)-locationrename node scripts/awLocationRename.mjs \
 *       --target prod --i-mean-production --apply --confirm-prod <account id>:5ucwdyvwivelbo4k4jomvrwel4-NONE
 *   apply + phase 2 (the same command plus --with-stop-copies; the backup above covers Load too).
 *
 * Phase 1 writes ONLY the Location rows named in RENAMES (built-in table, keyed by Location id; Ryne approved exactly these) and
 * one AuditLog row per row with the previous values. A row is renamed only while it STILL matches the expected old name / city /
 * street (planning refuses otherwise, and the UpdateItem carries the same guard as its ConditionExpression), so a re-run is idempotent.
 * It mirrors what the app's own edit path (tms-directory-actions UPSERT_LOCATION) stores for a name/address edit: name, street,
 * city/state/zip, normalizedName, normalizedAddress (same keys as amplify/functions/_shared/directoryKeys.ts), and, because the address
 * changed, the stored geocode is cleared (the old pin described the old address).
 *
 * The app's edit path does NOT rewrite the facility-name copies on Load.stops[].name / Load.originName / Load.destinationName (nor does
 * MERGE_LOCATIONS). They are counted in the dry run. OPTIONAL phase 2 (`--with-stop-copies`, default OFF, also for renames phase 1 already
 * applied) rewrites those copies on a Load ONLY where the value still equals the OLD name AND the stop's locationId is the renamed
 * row; the UpdateItem is conditional on the Load's updatedAt and on the stops value it read, one AuditLog row per Load with the previous
 * values, nothing else on the Load is touched.
 *
 * The scan (every Location whose name looks like a street address) is READ ONLY: it lists, never renames.
 * Never a money/status field, never a notice / e-mail / message.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, DEV_SUFFIX, REGION, assertWritableSuffix, isProductionSuffix, localDate, requireProd } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { csvCell } from './lib/releaseClassify.mjs';

export const SCRIPT = 'awLocationRename';
export const AUDIT_ACTION = 'AW_LOCATION_RENAME';
export const AUDIT_USER = 'system:awLocationRename';

/**
 * The ONLY rows this script may touch. `idPrefix` is resolved to the full production id (exactly one live row must match the prefix
 * AND the old name / city / street). `old` must still match on apply; `next` is the full new value of every field listed.
 */
export const RENAMES = [
  {
    key: 'austell',
    idPrefix: 'loc-fd3cce',
    old: { name: '6000 DR. LUKE GLENN GA', street: 'NORFOLK SOUTHERN RAIL', city: 'AUSTELL', state: 'GA', zip: '30106' },
    next: { name: 'Norfolk Southern Austell Intermodal', street: '6000 Dr Luke Glenn Garrett Jr Memorial Hwy', city: 'Austell', state: 'GA', zip: '30106' },
  },
  {
    key: 'rochelle',
    idPrefix: 'loc-7c0af6',
    old: { name: '100 4TH AVE', street: '', city: 'ROCHELLE', state: 'IL', zip: '61068' },
    next: { name: "Roy's Transfer, Inc.", street: '100 E 4th Ave', city: 'ROCHELLE', state: 'IL', zip: '61068' },
  },
  {
    key: 'romulus',
    idPrefix: 'loc-7c58836541adf355',
    old: { name: '11651 HANNAN RD', street: '11651 HANNAN RD', city: 'ROMULUS', state: 'MI', zip: '48174' },
    next: { name: 'Forward Air, Inc.', street: '11651 Hannan Rd', city: 'ROMULUS', state: 'MI', zip: '48174' },
  },
  {
    key: 'walker',
    idPrefix: 'loc-03fb6661aa45b6b5',
    old: { name: '3200 FRUIT RIDGE AVE', street: '3200 FRUIT RIDGE AVE NW', city: 'GRAND RAPIDS', state: 'MI', zip: '49544' },
    next: { name: 'Challenge Manufacturing', street: '3200 FRUIT RIDGE AVE NW', city: 'GRAND RAPIDS', state: 'MI', zip: '49544' },
  },
  {
    key: 'hartford',
    idPrefix: 'loc-0a9d16d71c8709a5',
    old: { name: '749 NORTH WALKER DRIVE', street: '749 NORTH WALKER DR', city: 'HARTFORD', state: 'WI', zip: '53027' },
    // the street is WACKER, not Walker
    next: { name: 'CDM Tool & Mfg. Co., LLC', street: '749 N Wacker Dr', city: 'HARTFORD', state: 'WI', zip: '53027' },
  },
  {
    key: 'lapeer',
    idPrefix: '1793135701161-qnafp4pyt',
    old: { name: '100 E FAIR ST', street: '', city: 'LAPEER', state: 'MI', zip: '' },
    next: { name: 'Gestamp North America - Lapeer Plant', street: '100 E Fair St', city: 'LAPEER', state: 'MI', zip: '' },
  },
  {
    key: 'stcharles',
    idPrefix: '1793135701843-srsxawlcu',
    old: { name: '417 STONE DR', street: '', city: 'ST CHARLES', state: 'IL', zip: '' },
    next: { name: 'Endeavor Technologies, Inc.', street: '417 Stone Dr', city: 'ST CHARLES', state: 'IL', zip: '' },
    note: 'LOWER CONFIDENCE: multi-tenant building; applied on Ryne\'s approval',
  },
];
// Address-like names deliberately NOT renamed: 5 CO BAR RNCH RD (Flagstaff AZ; ranch road, no business found); '1210' and '3 TIMES SQUARE' await Ryne.
const FIELDS = ['name', 'street', 'city', 'state', 'zip'];
const GEO_FIELDS = ['lat', 'lng', 'placeId', 'geocodedAt', 'geocodeExpiresAt', 'geohash6'];

/** Verbatim copies of amplify/functions/_shared/directoryKeys.ts (a test pins them to the TS originals). */
export const normalizeName = (value) => value
  .toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ')
  .replace(/\b(llc|inc|ltd|llp|corp|co|company|enterprises)\b/g, '').trim();
export const normalizeAddress = (v) => [v.street, v.city, v.state, v.zip, v.country]
  .map((p) => (typeof p === 'string' ? p.toLowerCase().replace(/[^a-z0-9]/g, ' ') : ''))
  .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

const blank = (v) => (v == null ? '' : String(v));

/** Production gate + the typed AW_PROD_CONFIRM token an apply additionally needs. Null = dev run. */
export async function locationRenameGate(values, deps = {}) {
  const gate = await requireProd({ script: SCRIPT, values, tables: PROD_WRITE_SETS.awLocationRename.models, deps });
  if (gate?.apply && !gate.rehearsal) {
    const want = `${localDate(deps.now ?? new Date())}-locationrename`;
    if ((deps.env ?? process.env).AW_PROD_CONFIRM !== want) {
      throw new Error(`Production gate closed for ${SCRIPT}:\n  - (e) env AW_PROD_CONFIRM must equal ${want}`);
    }
  }
  return gate;
}

/**
 * Resolve every RENAMES entry against the live Location rows.
 * -> [{ entry, status: 'TO_RENAME'|'ALREADY_DONE'|'NO_MATCH'|'AMBIGUOUS'|'COLLISION'|'MERGED_OR_ARCHIVED', row?, before?, after?, detail? }]
 * Never plans a row that no longer matches the expected old values.
 */
export function planRenames(locations, renames = RENAMES) {
  return renames.map((entry) => {
    const sameField = (row, src) => FIELDS.every((f) => blank(row[f]) === blank(src[f]));
    const byPrefix = locations.filter((l) => String(l.id).startsWith(entry.idPrefix));
    const oldMatches = byPrefix.filter((l) => sameField(l, entry.old));
    if (oldMatches.length > 1) return { entry, status: 'AMBIGUOUS', detail: `${oldMatches.length} rows match prefix ${entry.idPrefix} and the old values` };
    if (oldMatches.length === 0) {
      const done = byPrefix.filter((l) => sameField(l, entry.next));
      if (done.length === 1) return { entry, status: 'ALREADY_DONE', row: done[0] };
      return { entry, status: 'NO_MATCH', detail: byPrefix.length ? `prefix ${entry.idPrefix} found ${byPrefix.length} row(s) but none has the expected old name/street/city/state/zip` : `no Location id starts with ${entry.idPrefix}` };
    }
    const row = oldMatches[0];
    if (row.mergedIntoId || row.active === false) return { entry, status: 'MERGED_OR_ARCHIVED', row };
    const after = { ...row, ...entry.next };
    const nn = normalizeName(after.name);
    const na = normalizeAddress({ ...after, country: row.country ?? 'US' });
    // The app's UPSERT_LOCATION refuses a same name+city or same address as another ACTIVE location; so does this.
    const clash = locations.find((o) => o.id !== row.id && o.active !== false && !o.mergedIntoId
      && ((nn && normalizeName(blank(o.name)) === nn && normalizeName(blank(o.city)) === normalizeName(blank(after.city)))
        || (na && normalizeAddress({ ...o, country: o.country ?? 'US' }) === na)));
    if (clash) return { entry, status: 'COLLISION', row, detail: `would duplicate location ${clash.id}` };
    return { entry, status: 'TO_RENAME', row, before: Object.fromEntries(FIELDS.map((f) => [f, blank(row[f])])), after: { ...entry.next, normalizedName: nn, normalizedAddress: na } };
  });
}

/** One row: conditional update (only while it still holds the expected old values) + one AuditLog row. -> 'written' | 'lost' */
export async function applyOne({ doc, suffix, item, now = new Date() }) {
  assertWritableSuffix(suffix, 'location rename');
  if (!RENAMES.some((r) => r.idPrefix && String(item.row.id).startsWith(r.idPrefix) && r === item.entry)) throw new Error(`refusing to write location ${item.row.id}: not in the rename table`);
  const nowIso = now.toISOString();
  const { entry, row, after } = item;
  const names = { '#nn': 'normalizedName', '#na': 'normalizedAddress', '#ua': 'updatedAt', '#ub': 'updatedBy', '#mi': 'mergedIntoId', '#act': 'active' };
  const values = { ':nn': after.normalizedName, ':na': after.normalizedAddress, ':ua': nowIso, ':ub': AUDIT_USER, ':act': false };
  const sets = ['#nn = :nn', '#na = :na', '#ua = :ua', '#ub = :ub'];
  const conds = ['attribute_exists(id)', 'attribute_not_exists(#mi)', '(attribute_not_exists(#act) OR #act <> :act)'];
  FIELDS.forEach((f, i) => {
    names[`#f${i}`] = f;
    if (blank(entry.next[f]) !== blank(entry.old[f])) { values[`:n${i}`] = entry.next[f]; sets.push(`#f${i} = :n${i}`); }
    const old = blank(entry.old[f]);
    if (old === '') conds.push(`(attribute_not_exists(#f${i}) OR attribute_type(#f${i}, :nul) OR #f${i} = :o${i})`);
    else conds.push(`#f${i} = :o${i}`);
    values[`:o${i}`] = old;
  });
  if (conds.some((c) => c.includes(':nul'))) values[':nul'] = 'NULL';
  const geoPresent = GEO_FIELDS.filter((g) => row[g] != null);
  geoPresent.forEach((g, i) => { names[`#g${i}`] = g; });
  const expr = `SET ${sets.join(', ')}${geoPresent.length ? ` REMOVE ${geoPresent.map((_, i) => `#g${i}`).join(', ')}` : ''}`;
  try {
    await doc.send(new UpdateCommand({
      TableName: `Location-${suffix}`, Key: { id: row.id }, UpdateExpression: expr, ConditionExpression: conds.join(' AND '),
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return 'lost';
    throw err;
  }
  await doc.send(new PutCommand({
    TableName: `AuditLog-${suffix}`,
    Item: {
      id: randomUUID(), __typename: 'AuditLog', entityType: 'LOCATION', entityId: row.id, action: AUDIT_ACTION, user: AUDIT_USER,
      changes: JSON.stringify({
        previous: { ...Object.fromEntries(FIELDS.map((f) => [f, blank(row[f])])), normalizedName: row.normalizedName ?? null, normalizedAddress: row.normalizedAddress ?? null, geocode: Object.fromEntries(geoPresent.map((g) => [g, row[g]])) },
        next: { ...entry.next, normalizedName: after.normalizedName, normalizedAddress: after.normalizedAddress },
      }),
      createdAt: nowIso, updatedAt: nowIso,
    },
  }));
  return 'written';
}

// ── phase 2 (opt-in): the denormalized facility-name copies on Load ───────────────────────────────────────────────────────────────
export const STOP_AUDIT_ACTION = 'AW_LOCATION_RENAME_STOP_COPIES';

/** Raw `stops` as stored -> { list: every entry (kept verbatim), asString } or null when absent/unparseable. */
function rawStops(load) {
  let v = load.stops;
  const asString = typeof v === 'string';
  if (asString) { try { v = JSON.parse(v); } catch { return null; } }
  return Array.isArray(v) ? { list: v, asString } : null;
}

/**
 * Per Load, the name copies to rewrite for every planned/already-done rename: a stop whose locationId is the renamed row AND whose name still
 * equals the OLD name; originName / destinationName likewise (old name, city of the row, and the Load holds a stop by that locationId).
 * Nothing else is planned. -> [{ load, newStops, previous, next, loadId }]; `newStops` is in the stored representation.
 */
export function planStopCopies(plan, loads) {
  const subs = plan.filter((p) => (p.status === 'TO_RENAME' || p.status === 'ALREADY_DONE') && p.row)
    .map((p) => ({ id: p.row.id, oldName: p.entry.old.name, newName: p.entry.next.name, cityKey: normalizeName(blank(p.entry.next.city)) }));
  const out = [];
  for (const load of loads) {
    const st = rawStops(load);
    const held = new Set((st?.list ?? []).map((s) => s && typeof s === 'object' && s.locationId).filter(Boolean));
    const previous = { stops: [], originName: undefined, destinationName: undefined };
    const next = { stops: [], originName: undefined, destinationName: undefined };
    let newList = st?.list;
    if (st) {
      newList = st.list.map((s, index) => {
        const sub = s && typeof s === 'object' ? subs.find((x) => x.id === s.locationId && blank(s.name) === x.oldName) : null;
        if (!sub) return s;
        previous.stops.push({ index, locationId: sub.id, name: s.name });
        next.stops.push({ index, locationId: sub.id, name: sub.newName });
        return { ...s, name: sub.newName };
      });
    }
    for (const [field, cityField] of [['originName', 'originCity'], ['destinationName', 'destinationCity']]) {
      const sub = subs.find((x) => held.has(x.id) && blank(load[field]) === x.oldName && normalizeName(blank(load[cityField])) === x.cityKey);
      if (sub) { previous[field] = load[field]; next[field] = sub.newName; }
    }
    if (!previous.stops.length && previous.originName === undefined && previous.destinationName === undefined) continue;
    out.push({
      load, loadId: load.id, previous, next,
      newStops: previous.stops.length ? (st.asString ? JSON.stringify(newList) : newList) : undefined,
    });
  }
  return out;
}

/** One Load: conditional update (updatedAt + the exact stops / name values read) + one AuditLog row. -> 'written' | 'lost' */
export async function applyStopCopies({ doc, suffix, item, now = new Date() }) {
  assertWritableSuffix(suffix, 'location rename stop copies');
  const { load, previous, next } = item;
  const ids = [...previous.stops.map((s) => s.locationId)];
  if (!ids.every((id) => RENAMES.some((r) => String(id).startsWith(r.idPrefix)))) throw new Error(`refusing to write load ${load.id}: a stop is not a renamed location`);
  const nowIso = now.toISOString();
  const names = { '#ua': 'updatedAt', '#ub': 'updatedBy' };
  const values = { ':ua': nowIso, ':ub': AUDIT_USER };
  const sets = ['#ua = :ua', '#ub = :ub'];
  const conds = ['attribute_exists(id)', load.updatedAt ? '#ou = :ou' : 'attribute_not_exists(#ou)'];
  names['#ou'] = 'updatedAt';
  if (load.updatedAt) values[':ou'] = load.updatedAt;
  if (item.newStops !== undefined) {
    names['#st'] = 'stops'; values[':ns'] = item.newStops; values[':os'] = load.stops;
    sets.push('#st = :ns'); conds.push('#st = :os');
  }
  for (const [field, tag] of [['originName', 'on'], ['destinationName', 'dn']]) {
    if (previous[field] === undefined) continue;
    names[`#${tag}`] = field; values[`:n${tag}`] = next[field]; values[`:o${tag}`] = previous[field];
    sets.push(`#${tag} = :n${tag}`); conds.push(`#${tag} = :o${tag}`);
  }
  try {
    await doc.send(new UpdateCommand({
      TableName: `Load-${suffix}`, Key: { id: load.id }, UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: conds.join(' AND '),
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return 'lost';
    throw err;
  }
  await doc.send(new PutCommand({
    TableName: `AuditLog-${suffix}`,
    Item: {
      id: randomUUID(), __typename: 'AuditLog', entityType: 'LOAD', entityId: load.id, action: STOP_AUDIT_ACTION, user: AUDIT_USER,
      changes: JSON.stringify({ previous: { ...previous, updatedAt: load.updatedAt ?? null }, next }), createdAt: nowIso, updatedAt: nowIso,
    },
  }));
  return 'written';
}

// ── READ-ONLY scan: names that look like a street address ──────────────────────────────────────────────────────────────────────
const STREET_WORDS = 'ST|STREET|AVE|AVENUE|AV|RD|ROAD|DR|DRIVE|BLVD|BOULEVARD|HWY|HIGHWAY|LN|LANE|WAY|CT|COURT|PKWY|PARKWAY|PL|PLACE|CIR|CIRCLE|TRL|TRAIL|TER|TERRACE|PIKE|RTE|ROUTE|RNCH|RANCH|EXPY|EXPWY|FWY|LOOP|PLZ|SQ|ALY|XING|CRK';
const DIRS = 'N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST';
// number (optionally 123-A / 12B) + 1-4 words + street word (+ optional direction, suite/unit, or trailing state/city tail)
const ADDRESS_NAME = new RegExp(`^\\d{1,6}[A-Z]?(-\\d{1,6})?\\s+(?:(?:${DIRS})\\.?\\s+)?(?:[A-Z0-9'.]+\\s+){0,4}?(?:${STREET_WORDS})\\.?(?:\\s+(?:${DIRS})\\.?)?(?:\\s*(?:,|#|STE|SUITE|UNIT|BLDG|APT)\\b.*)?(?:\\s+[A-Z]{2})?$`);
const PO_BOX = /^(P\.?\s?O\.?\s+BOX|POST OFFICE BOX)\s+\d+/;
// A "3RD AVE" / "5TH ST" ordinal-first name is a street, but "1ST CHOICE..." is a business; so ordinals need a street word right after.
const ORDINAL_STREET = new RegExp(`^\\d{1,3}(?:ST|ND|RD|TH)\\s+(?:${STREET_WORDS})\\.?$`);

/**
 * True when a facility NAME is a postal address rather than a place name. Case-insensitive. `street` (optional) adds one rule:
 * a name that is only the leading part of the row's own street ("1210" for "1210 S WAUKEGAN RD", "3 TIMES SQUARE" for itself).
 * A leading URL-encoding artefact ("%09 ") is ignored.
 */
export function looksLikeAddressName(name, street) {
  const n = blank(name).trim().toUpperCase().replace(/^(?:%[0-9A-F]{2}\s*)+/, '').replace(/\s+/g, ' ');
  if (!n) return false;
  if (ADDRESS_NAME.test(n) || PO_BOX.test(n) || ORDINAL_STREET.test(n)) return true;
  const ns = blank(street).toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const nn = n.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^\d/.test(nn) && ns !== '' && (ns === nn || ns.startsWith(`${nn} `)) && nn.length >= 3;
}

/** Name copies per Location: loads holding it as a stop (by locationId) and loads whose origin/destination name+city equals it. */
export function countReferences(locations, loads) {
  const byId = new Map(locations.map((l) => [l.id, { stopLoads: new Set(), stopRows: 0, nameLoads: new Set(), shipments: new Set() }]));
  const byNameCity = new Map();
  for (const l of locations) {
    const k = `${normalizeName(blank(l.name))}|${normalizeName(blank(l.city))}`;
    const arr = byNameCity.get(k) ?? [];
    arr.push(l.id);
    byNameCity.set(k, arr);
  }
  for (const ld of loads) {
    for (const s of loadStops(ld)) {
      const c = s.locationId && byId.get(s.locationId);
      if (c) { c.stopRows += 1; c.stopLoads.add(ld.id); if (ld.shipmentId) c.shipments.add(ld.shipmentId); }
    }
    for (const [n, c] of [[ld.originName, ld.originCity], [ld.destinationName, ld.destinationCity]]) {
      if (!n) continue;
      const ids = byNameCity.get(`${normalizeName(blank(n))}|${normalizeName(blank(c))}`);
      for (const id of ids ?? []) { const x = byId.get(id); x.nameLoads.add(ld.id); if (ld.shipmentId) x.shipments.add(ld.shipmentId); }
    }
  }
  return byId;
}

/** `stops` is AWSJSON: a list once parsed, or a raw JSON string. */
export function loadStops(load) {
  let v = load.stops;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v.filter((s) => s && typeof s === 'object') : [];
}

/** Exact stop-name copies of one rename (names equal the OLD name): stops[] rows by locationId, and origin/destination mirrors. */
export function countNameCopies(row, oldName, loads) {
  const out = { stopsByLocationId: 0, stopLoads: 0, stopsNameMatchOtherId: 0, originMirror: 0, destinationMirror: 0, loadsTouched: 0, loadIds: [] };
  const touched = new Set();
  for (const ld of loads) {
    let hit = false;
    for (const s of loadStops(ld)) {
      if (s.locationId === row.id) { out.stopsByLocationId += 1; hit = true; }
      else if (!s.locationId && blank(s.name) === oldName && normalizeName(blank(s.city)) === normalizeName(blank(row.city))) { out.stopsNameMatchOtherId += 1; hit = true; }
    }
    if (blank(ld.originName) === oldName && normalizeName(blank(ld.originCity)) === normalizeName(blank(row.city))) { out.originMirror += 1; hit = true; }
    if (blank(ld.destinationName) === oldName && normalizeName(blank(ld.destinationCity)) === normalizeName(blank(row.city))) { out.destinationMirror += 1; hit = true; }
    if (hit) touched.add(ld.id);
  }
  out.loadsTouched = touched.size;
  out.loadIds = [...touched];
  out.stopLoads = loads.filter((ld) => loadStops(ld).some((s) => s.locationId === row.id)).length;
  return out;
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

export const writeCsv = (path, head, lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${[head.join(','), ...lines.map((l) => l.map(csvCell).join(','))].join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

const checkpointPath = (suffix) => join(homedir(), 'bcat-ops-backups', `aw-location-rename-${suffix}.checkpoint.json`);
const loadCheckpoint = (p) => (existsSync(p) ? new Set(JSON.parse(readFileSync(p, 'utf8')).done ?? []) : new Set());
const saveCheckpoint = (p, done) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ done: [...done], savedAt: new Date().toISOString() }), { mode: 0o600 });
};

async function main() {
  const { values } = parseArgs({
    options: { apply: { type: 'boolean' }, 'with-stop-copies': { type: 'boolean' }, suffix: { type: 'string' }, 'report-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' }, ...PROD_GATE_OPTIONS },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Usage: node scripts/awLocationRename.mjs [--report-dir <dir>] [--apply [--with-stop-copies]] [--target prod --i-mean-production ...]\n${PROD_GATE_USAGE}\nDry run unless --apply. Renames exactly ${RENAMES.length} built-in Location rows; --with-stop-copies (with --apply) also rewrites the old-name copies on Loads.`);
    return;
  }
  const gate = await locationRenameGate(values);
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

  const locations = await scanAll(doc, T('Location'), ['id', 'name', 'street', 'city', 'state', 'zip', 'country', 'facilityType', 'active', 'mergedIntoId', 'normalizedName', 'normalizedAddress', 'lat', 'lng', 'placeId', 'geocodedAt', 'geocodeExpiresAt', 'geohash6']);
  const loads = await scanAll(doc, T('Load'), ['id', 'shipmentId', 'stops', 'originName', 'originCity', 'destinationName', 'destinationCity', 'updatedAt']);
  console.log(`production Location rows ${locations.length}; Load rows ${loads.length}`);

  // ── the renames: before / after (facility names are not PII)
  const plan = planRenames(locations);
  for (const p of plan) {
    console.log(`RENAME ${p.entry.key} [${p.status}]${p.row ? ` id ${p.row.id}` : ''}${p.detail ? ` — ${p.detail}` : ''}${p.entry.note ? `\n   !! ${p.entry.note}` : ''}`);
    if (p.status === 'TO_RENAME') {
      console.log(`   before ${JSON.stringify(p.before)}`);
      console.log(`   after  ${JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, p.after[f]])))}`);
      console.log(`   normalizedName ${JSON.stringify(p.row.normalizedName ?? null)} -> ${JSON.stringify(p.after.normalizedName)}; normalizedAddress ${JSON.stringify(p.row.normalizedAddress ?? null)} -> ${JSON.stringify(p.after.normalizedAddress)}`);
      console.log(`   geocode fields present (cleared, address changed): ${GEO_FIELDS.filter((g) => p.row[g] != null).join(',') || 'none'}`);
    }
    if (p.row && (p.status === 'TO_RENAME' || p.status === 'ALREADY_DONE')) {
      console.log(`   denormalized copies of the OLD name (phase 1 never touches them; phase 2 --with-stop-copies does): ${JSON.stringify(countNameCopies(p.row, p.entry.old.name, loads))}`);
    }
  }
  const toRename = plan.filter((p) => p.status === 'TO_RENAME');
  const stopPlan = planStopCopies(plan, loads);
  const stopRows = stopPlan.reduce((n, i) => n + i.previous.stops.length, 0);
  console.log(`PHASE 2 (--with-stop-copies): ${stopPlan.length} Load(s) with copies to rewrite: ${stopRows} stops[].name, ${stopPlan.filter((i) => i.previous.originName !== undefined).length} originName, ${stopPlan.filter((i) => i.previous.destinationName !== undefined).length} destinationName`);
  for (const i of stopPlan) console.log(`   load ${i.loadId}: ${JSON.stringify({ previous: i.previous, next: i.next })}`);
  writeCsv(join(reportDir, `location-rename-plan-${today}.csv`),
    ['key', 'id', 'status', 'before name', 'before street', 'after name', 'after street', 'city', 'state', 'zip', 'note', 'loads with old-name copies', 'load ids'],
    plan.map((p) => {
      const c = p.row ? countNameCopies(p.row, p.entry.old.name, loads) : null;
      return [p.entry.key, p.row?.id ?? p.entry.idPrefix, p.status, p.entry.old.name, p.entry.old.street, p.entry.next.name, p.entry.next.street, p.entry.next.city, p.entry.next.state, p.entry.next.zip, p.entry.note ?? '', c?.loadsTouched ?? '', c?.loadIds.join(' ') ?? ''];
    }));

  // ── READ-ONLY scan of every address-like name
  const refs = countReferences(locations, loads);
  const inTable = (l) => RENAMES.some((x) => String(l.id).startsWith(x.idPrefix));
  const hits = locations.filter((l) => (looksLikeAddressName(l.name, l.street) || inTable(l)) && !l.mergedIntoId);
  const f = join(reportDir, `location-address-names-${today}.csv`);
  writeCsv(f, ['id', 'name', 'street', 'city', 'state', 'zip', 'facility type', 'active', 'loads with stop locationId', 'stop rows', 'loads with origin/destination name', 'distinct shipments', 'in rename table'],
    hits.sort((a, b) => blank(a.name).localeCompare(blank(b.name))).map((l) => {
      const r = refs.get(l.id);
      return [l.id, l.name, blank(l.street), blank(l.city), blank(l.state), blank(l.zip), blank(l.facilityType), l.active === false ? 'no' : 'yes', r.stopLoads.size, r.stopRows, r.nameLoads.size, r.shipments.size, inTable(l) ? 'yes' : 'no'];
    }));
  console.log('ADDRESS-LIKE NAMES NOT IN THE RENAME TABLE (for Ryne to decide):');
  for (const l of hits.filter((x) => !inTable(x))) console.log(`   ${JSON.stringify({ id: l.id, name: l.name, street: blank(l.street), city: blank(l.city), state: blank(l.state), zip: blank(l.zip) })}`);
  console.log(`ADDRESS-LIKE NAMES: ${hits.length} of ${locations.length} Location rows (active ${hits.filter((l) => l.active !== false).length}); referenced by >=1 load ${hits.filter((l) => refs.get(l.id).stopLoads.size + refs.get(l.id).nameLoads.size > 0).length}; list (mode 0600): ${f}`);
  console.log(`TO APPLY: ${toRename.length} Location row(s)`);

  if (!apply) {
    console.log(`DRY RUN: nothing written. ${toRename.length} location(s) would be renamed; ${stopPlan.length} load(s) would get stop-name copies updated with --with-stop-copies.`);
    return;
  }
  const cpPath = checkpointPath(suffix);
  const done = loadCheckpoint(cpPath);
  const out = { renamed: 0, lost: 0, skippedDone: 0, notPlanned: plan.length - toRename.length };
  for (const item of toRename) {
    if (done.has(item.row.id)) { out.skippedDone += 1; continue; }
    const r = await applyOne({ doc, suffix, item });
    if (r === 'written') { out.renamed += 1; done.add(item.row.id); } else out.lost += 1;
    saveCheckpoint(cpPath, done);
  }
  console.log('APPLIED', JSON.stringify(out));
  if (values['with-stop-copies']) {
    const loadOut = { written: 0, lost: 0, skippedDone: 0 };
    for (const item of stopPlan) {
      const key = `load:${item.loadId}`;
      if (done.has(key)) { loadOut.skippedDone += 1; continue; }
      const r = await applyStopCopies({ doc, suffix, item });
      if (r === 'written') { loadOut.written += 1; done.add(key); } else loadOut.lost += 1;
      saveCheckpoint(cpPath, done);
    }
    console.log('APPLIED STOP COPIES', JSON.stringify(loadOut));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
