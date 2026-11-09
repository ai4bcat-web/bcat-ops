/**
 * Pure planning for scripts/awEquipRep.mjs: join the Aljex equipment / sales rep exports to production shipments by PRO,
 * map equipment codes to the app's own values, resolve the sales rep (file first, Aljex "Salesrep ID" mapping second),
 * and decide per shipment which empty fields may be enriched. No I/O, no AWS.
 *
 * Where the data lives (verified against amplify/data/resource.ts and src/hooks/useShipments.ts):
 *   equipment  -> Load.equipmentType and Order.equipmentType (free text; the Shipments grid reads Load first, then Order).
 *                 Shipment itself has no equipment field.
 *   sales rep  -> Shipment.salesRepCode (the verbatim Aljex rep slot Settings > Users > "Aljex code mapping" lists and maps to a
 *                 person; its Reassign then sets Shipment.salesRepId = a UserProfile id). salesRepId needs a real user, and
 *                 production has 0 UserProfile rows, so the NAME goes into salesRepCode and salesRepId is left alone.
 *   divisions  -> Shipment.revDivision / revSubdivision are already set on every production shipment (rule-tagged); the three
 *                 group names are only compared with them and reported, never written.
 */
import { normalizePro } from '../../src/lib/proNumber.ts';

export const SCOPE_FROM = '2025-01-01';

/** Equipment codes with a real app value. The app's own form suggestions (EQUIPMENT_SUGGESTIONS) are the stored spelling. */
export const EQUIPMENT_MAP = Object.freeze({
  V: 'Dry Van',
  R: 'Reefer',
  F: 'Flatbed',
  STRA: 'Box Truck', // closest app value to a straight truck
});

/** Ryne's codes the app has no equipment value for (they are modes / vehicle classes). Left blank and listed unless --also-map. */
export const NO_APP_VALUE = Object.freeze({
  FTL: 'Full Truckload', TL: 'Truckload', LTL: 'Less than truckload', OCN: 'Ocean', CRGO: 'Cargo van',
});

/** A DRIVER name typed into the equipment field. Never equipment. */
export const DRIVER_CODES = Object.freeze(['ZAK']);

/** The three division group names Ryne named: -> OwnershipDivision keys (OWNER_OPERATOR is a subdivision of ASSETS). */
export const DIVISION_NAMES = Object.freeze({
  'IVAN CARTAGE CO': { rev: 'ASSETS', sub: null },
  BCAT: { rev: 'BROKERAGE', sub: null },
  'OWNER OPERATORS': { rev: 'ASSETS', sub: 'OWNER_OPERATOR' },
});

export const PURITY_MIN = 0.95;

export const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '') || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);

/** PRO identity used for every join: pure numeric string, taking `L<pro>` originals to <pro>. Null for anything else. */
export function proKey(value) {
  const n = normalizePro(typeof value === 'number' ? String(value) : value);
  if (!n) return null;
  const m = /^L?(\d+)$/.exec(n);
  return m ? m[1] : null;
}

/** Aljex mm/dd/yy (or mm/dd/yyyy) -> YYYY-MM-DD; null when blank or unparseable. */
export function parseShipDate(text) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*$/.exec(text ?? '');
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const mo = Number(m[1]);
  const d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const normCode = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
export const normName = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * `--also-map FTL=Full Truckload,TL=Truckload` -> {FTL: 'Full Truckload', ...}. Only codes in NO_APP_VALUE or unknown ones
 * can be added; V/R/F/STRA stay as the app maps them and ZAK can never become equipment.
 */
export function parseAlsoMap(text) {
  const out = {};
  for (const part of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 1) throw new Error(`--also-map: expected CODE=Value, got "${part}"`);
    const code = normCode(part.slice(0, eq));
    const value = part.slice(eq + 1).trim();
    if (!value) throw new Error(`--also-map: empty value for ${code}`);
    if (DRIVER_CODES.includes(code)) throw new Error(`--also-map: ${code} is a driver name, never equipment`);
    if (code in EQUIPMENT_MAP) throw new Error(`--also-map: ${code} already maps to ${EQUIPMENT_MAP[code]}`);
    out[code] = value;
  }
  return out;
}

/** @returns {{kind: 'EQUIPMENT', value: string} | {kind: 'DRIVER'} | {kind: 'NO_APP_VALUE' | 'UNKNOWN', code: string}} */
export function classifyEquipmentCode(codeRaw, alsoMap = {}) {
  const code = normCode(codeRaw);
  if (DRIVER_CODES.includes(code)) return { kind: 'DRIVER', code };
  if (code in EQUIPMENT_MAP) return { kind: 'EQUIPMENT', code, value: EQUIPMENT_MAP[code] };
  if (code in alsoMap) return { kind: 'EQUIPMENT', code, value: alsoMap[code] };
  if (code in NO_APP_VALUE) return { kind: 'NO_APP_VALUE', code };
  return { kind: 'UNKNOWN', code };
}

/**
 * Index equipment-export rows by PRO. A field with two different non-blank values across rows/files is a CONFLICT: listed, never applied.
 * @param {Array<{pro: string, equipment: string, rep: string, file?: string}>} rows
 */
export function indexSources(rows) {
  const byPro = new Map();
  let unusable = 0;
  for (const r of rows) {
    const pro = proKey(r.pro);
    if (!pro) { unusable += 1; continue; }
    const e = byPro.get(pro) ?? byPro.set(pro, { pro, equip: new Set(), rep: new Set(), files: new Set(), rows: 0 }).get(pro);
    e.rows += 1;
    if (r.file) e.files.add(r.file);
    if (!isBlank(r.equipment)) e.equip.add(normCode(r.equipment));
    if (!isBlank(r.rep)) e.rep.add(normName(r.rep));
  }
  for (const e of byPro.values()) {
    e.equipment = e.equip.size === 1 ? [...e.equip][0] : null;
    e.equipmentConflict = e.equip.size > 1;
    e.salesRep = e.rep.size === 1 ? [...e.rep][0] : null;
    e.repConflict = e.rep.size > 1;
  }
  return { byPro, unusable };
}

/** Index the full export by PRO: ship date + Aljex Salesrep ID. Duplicate PROs keep the first non-blank value of each. */
export function indexExport(rows) {
  const byPro = new Map();
  for (const r of rows) {
    const pro = proKey(r.pro);
    if (!pro) continue;
    const e = byPro.get(pro) ?? byPro.set(pro, { pro, shipDate: null, repId: '' }).get(pro);
    const d = parseShipDate(r.shipDate);
    if (d && d > MAX_PLAUSIBLE_SHIP_DATE) e.badDate ??= r.shipDate;
    else e.shipDate ??= d;
    if (!e.repId) e.repId = String(r.repId ?? '').trim();
  }
  return byPro;
}

/** An Aljex ship date later than this is a typo (e.g. yy=70), not a shipment date: treated as "no ship date" and listed. */
export const MAX_PLAUSIBLE_SHIP_DATE = '2027-12-31';

export const inScope = (shipDate) => shipDate != null && shipDate >= SCOPE_FROM;

/**
 * Aljex Salesrep ID -> dominant rep name, from PROs present in BOTH the equipment exports (single unconflicted rep) and the full export.
 * Ambiguous (purity < 95% or a tie for first) ids are never applied.
 * @returns {Array<{id: string, total: number, dominant: string, count: number, purity: number, tie: boolean, ambiguous: boolean, names: Record<string, number>}>}
 */
export function buildIdMapping(exportByPro, sourceByPro, { filter = () => true } = {}) {
  const per = new Map();
  for (const [pro, ex] of exportByPro) {
    const src = sourceByPro.get(pro);
    if (!src || !src.salesRep || !ex.repId || !filter(ex)) continue;
    const m = per.get(ex.repId) ?? per.set(ex.repId, new Map()).get(ex.repId);
    m.set(src.salesRep, (m.get(src.salesRep) ?? 0) + 1);
  }
  const out = [];
  for (const [id, names] of per) {
    const ranked = [...names.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const total = ranked.reduce((s, [, c]) => s + c, 0);
    const [dominant, count] = ranked[0];
    const tie = ranked.length > 1 && ranked[1][1] === count;
    const purity = count / total;
    out.push({ id, total, dominant, count, purity, tie, ambiguous: tie || purity < PURITY_MIN, names: Object.fromEntries(ranked) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

const empty = (v) => isBlank(v);

/**
 * Candidate PRO keys of a production shipment, preferred first: the number (pure numeric or `L<pro>`), then Load.aljexId, then ProClaim ids.
 */
export function shipmentKeys(shipment, loads = [], claims = []) {
  const keys = [shipment.number, ...loads.map((l) => l.aljexId), ...claims.map((c) => c.id)].map(proKey).filter(Boolean);
  return [...new Set(keys)];
}

/**
 * Plan one in-scope shipment.
 * @returns {{
 *   equipment: {status: string, code?: string, value?: string},
 *   rep: {status: string, source?: string, name?: string, kind?: string, division?: object, idAmbiguous?: boolean},
 *   writes: Array<{table: 'Load'|'Order'|'Shipment', id: string, field: string, value: string}>
 * }}
 */
export function planShipment({ shipment, loads, orders, src, repId, idMap, alsoMap = {} }) {
  const writes = [];
  // ── equipment
  let equipment;
  if (!src || (src.equip.size === 0 && !src.equipmentConflict)) equipment = { status: 'NO_SOURCE' };
  else if (src.equipmentConflict) equipment = { status: 'CONFLICT', codes: [...src.equip] };
  else {
    const c = classifyEquipmentCode(src.equipment, alsoMap);
    if (c.kind === 'DRIVER') equipment = { status: 'DRIVER', code: c.code };
    else if (c.kind === 'NO_APP_VALUE') equipment = { status: 'NO_APP_VALUE', code: c.code };
    else if (c.kind === 'UNKNOWN') equipment = { status: 'UNKNOWN_CODE', code: c.code };
    else {
      const targets = [...loads.map((l) => ['Load', l]), ...orders.map((o) => ['Order', o])];
      const open = targets.filter(([, row]) => empty(row.equipmentType));
      if (targets.length === 0) equipment = { status: 'NO_TARGET', code: c.code, value: c.value };
      else if (open.length === 0) equipment = { status: 'ALREADY_SET', code: c.code, value: c.value };
      else {
        equipment = { status: 'TO_SET', code: c.code, value: c.value };
        for (const [table, row] of open) writes.push({ table, id: row.id, field: 'equipmentType', value: c.value });
      }
    }
  }
  // ── sales rep
  let rep;
  let name = null;
  let source = null;
  if (src?.repConflict) rep = { status: 'CONFLICT', names: [...src.rep] };
  else if (src?.salesRep) { name = src.salesRep; source = 'FILE'; }
  else if (repId) {
    const m = idMap.find((x) => x.id === repId);
    if (!m) rep = { status: 'NO_SOURCE', repId };
    else if (m.ambiguous) rep = { status: 'ID_AMBIGUOUS', repId, idAmbiguous: true };
    else { name = m.dominant; source = 'ID_MAP'; }
  } else rep = { status: 'NO_SOURCE' };
  if (name) {
    const division = DIVISION_NAMES[name] ?? null;
    if (division) {
      const agrees = shipment.revDivision === division.rev && (division.sub == null || shipment.revSubdivision === division.sub);
      rep = { status: empty(shipment.revDivision) ? 'DIVISION_NEEDS_REVIEW' : agrees ? 'DIVISION_AGREES' : 'DIVISION_DISAGREES', source, name, kind: 'DIVISION', division };
    } else if (!empty(shipment.salesRepCode)) rep = { status: 'ALREADY_SET', source, name, kind: 'PERSON' };
    else {
      rep = { status: 'TO_SET', source, name, kind: 'PERSON' };
      writes.push({ table: 'Shipment', id: shipment.id, field: 'salesRepCode', value: name });
    }
  }
  return { equipment, rep, writes };
}

/** Resolve the shipments' scope and plan them all. */
export function planAll({ shipments, loads, orders, claims, sources, exportByPro, idMap, alsoMap = {} }) {
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) if (r.shipmentId) (m.get(r.shipmentId) ?? m.set(r.shipmentId, []).get(r.shipmentId)).push(r);
    return m;
  };
  const loadsBy = group(loads);
  const ordersBy = group(orders);
  const claimsBy = group(claims);
  const results = [];
  for (const shipment of shipments) {
    const ls = loadsBy.get(shipment.id) ?? [];
    const keys = shipmentKeys(shipment, ls, claimsBy.get(shipment.id) ?? []);
    const pro = keys.find((k) => exportByPro.has(k)) ?? null;
    const ex = pro ? exportByPro.get(pro) : null;
    const base = { shipment, pro, keys, shipDate: ex?.shipDate ?? null };
    if (shipment.voidedAt) { results.push({ ...base, scope: 'VOIDED' }); continue; }
    if (!ex) { results.push({ ...base, scope: 'NOT_IN_EXPORT' }); continue; }
    if (!ex.shipDate) { results.push({ ...base, scope: 'NO_SHIP_DATE' }); continue; }
    if (!inScope(ex.shipDate)) { results.push({ ...base, scope: 'OLDER' }); continue; }
    const plan = planShipment({
      shipment, loads: ls, orders: ordersBy.get(shipment.id) ?? [], src: sources.get(pro) ?? null, repId: ex.repId, idMap, alsoMap,
    });
    results.push({ ...base, scope: 'IN_SCOPE', ...plan });
  }
  return results;
}

export const histogram = (rows, f) => {
  const out = {};
  for (const r of rows) { const k = String(f(r)); out[k] = (out[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
};

/** Export PROs with ship date >= SCOPE_FROM that no equipment export row covers (what Ryne still has to export). */
export function missingFromSources(exportByPro, sourceByPro, prodPros = new Set()) {
  const out = [];
  for (const [pro, ex] of exportByPro) {
    if (inScope(ex.shipDate) && !sourceByPro.has(pro)) out.push({ pro, shipDate: ex.shipDate, inProd: prodPros.has(pro) });
  }
  return out.sort((a, b) => Number(a.pro) - Number(b.pro));
}
