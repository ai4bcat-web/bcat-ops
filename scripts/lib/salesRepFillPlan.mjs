/**
 * Pure planning for scripts/awSalesRepFill.mjs: a sales rep on EVERY shipment that still has none, decided from the Aljex
 * "Salesrep ID" of the PRO (aljex-full-export). No I/O. ENRICH ONLY and LAST in the chain: it only touches a shipment that
 * has neither salesRepCode nor salesRepId (never overwrites). Source order per shipment: (1) the rep NAME the Aljex equipment
 * export gives for the PRO (FILE: the same names awEquipRep / awSalesRepId use; this also covers BCAT, which awRepProfiles
 * has no profile for), then (2) the Aljex Salesrep ID map (ID_MAP) for shipments with no file row. A conflicting file name
 * (two different reps for one PRO) is never guessed.
 *
 * Ryne's id map (Aljex Salesrep ID -> who):
 *   001 Ryne, 002 Ruben (2025+ only), 003 BCAT (division only: kept as the TEXT "BCAT"), 004 Jessy, 005 Ivan Cartage (group),
 *   007 Dillon, 008 Perla, 009 Brandon, 010 Jamey, '10' Owner Operators (group).
 * Profile ids are used for Ryne, Ruben and the two reporting groups only; every other name stays TEXT in salesRepCode.
 * An id is applied only while its evidence is unambiguous: the dominant name seen for that id in the equipment exports
 * (Ship Date >= 2025-01-01, the only period they cover) must equal the mapped name with purity >= PURITY_MIN (95%).
 */
import { PURITY_MIN, buildIdMapping, isBlank } from './equipRepPlan.mjs';
import { matchRep } from './salesRepPlan.mjs';

export const SCOPE_2025 = '2025-01-01';

/** The reporting-group profiles (same ids awRepProfiles creates). */
export const GROUP_IDS = Object.freeze({ IVAN_CARTAGE: 'group:ivan-cartage', OWNER_OPERATORS: 'group:owner-operators' });

/**
 * `kind`: PERSON_PROFILE (name text + profile id), PERSON_TEXT (name text only), GROUP_PROFILE (profile id only; the code
 * stays empty exactly as awSalesRepId's source-group path does), DIVISION_TEXT (text only; there is no BCAT profile).
 * `evidence`: the name awEquipRep's `sales rep name` column shows for that id.
 */
export const ID_MAP = Object.freeze({
  '001': { name: 'RYNE BANDOLIK', kind: 'PERSON_PROFILE', evidence: 'RYNE BANDOLIK' },
  '002': { name: 'RUBEN VARGAS', kind: 'PERSON_PROFILE', evidence: 'RUBEN VARGAS', from: SCOPE_2025 },
  '003': { name: 'BCAT', kind: 'DIVISION_TEXT', evidence: 'BCAT' },
  '004': { name: 'JESSY COFFEY', kind: 'PERSON_TEXT', evidence: 'JESSY COFFEY' },
  '005': { name: 'IVAN CARTAGE CO', kind: 'GROUP_PROFILE', groupId: GROUP_IDS.IVAN_CARTAGE, evidence: 'IVAN CARTAGE CO' },
  '007': { name: 'DILLON WHITT', kind: 'PERSON_TEXT', evidence: 'DILLON WHITT' },
  '008': { name: 'PERLA LOPEZ', kind: 'PERSON_TEXT', evidence: 'PERLA LOPEZ' },
  '009': { name: 'BRANDON KING', kind: 'PERSON_TEXT', evidence: 'BRANDON KING' },
  '010': { name: 'JAMEY CHILDS', kind: 'PERSON_TEXT', evidence: 'JAMEY CHILDS' },
  10: { name: 'OWNER OPERATORS', kind: 'GROUP_PROFILE', groupId: GROUP_IDS.OWNER_OPERATORS, evidence: 'OWNER OPERATORS' },
});

/** Fields this script may write, per table. */
export const WRITABLE = { Shipment: ['salesRepCode', 'salesRepId'], Order: ['customerRepId'] };

const blank = (v) => isBlank(v);

/** Equipment-export rep name -> same target (the export's names are the ID_MAP evidence names). */
export const NAME_MAP = Object.freeze(Object.fromEntries(Object.values(ID_MAP).map((m) => [m.evidence, m])));

/**
 * Verify the id map against the evidence: `evidence` = buildIdMapping(...) rows (since 2025).
 * @returns Map<id, {status: 'OK'|'NO_EVIDENCE'|'AMBIGUOUS'|'MISMATCH', purity?, total?, dominant?}>
 *   OK          >= 95% of the id's evidence names the mapped person
 *   NO_EVIDENCE the equipment exports never show this id (applied: Ryne's explicit map is the authority; reported separately)
 *   AMBIGUOUS   purity < 95% or a tie: NOT applied
 *   MISMATCH    the dominant name is someone else: NOT applied
 */
export function verifyIdMap(evidence) {
  const byId = new Map(evidence.map((e) => [String(e.id), e]));
  const out = new Map();
  for (const [id, m] of Object.entries(ID_MAP)) {
    const e = byId.get(id);
    if (!e) { out.set(id, { status: 'NO_EVIDENCE' }); continue; }
    const base = { purity: e.purity, total: e.total, dominant: e.dominant };
    const share = (e.names?.[m.evidence] ?? 0) / e.total;
    if (e.ambiguous || share < PURITY_MIN) out.set(id, { status: e.dominant === m.evidence ? 'AMBIGUOUS' : 'MISMATCH', ...base, purity: share });
    else out.set(id, { status: 'OK', ...base, purity: share });
  }
  return out;
}

export const idEvidence = (exportByPro, sourceByPro, inScope) => buildIdMapping(exportByPro, sourceByPro, { filter: (ex) => inScope(ex.shipDate) });

/**
 * Resolve the profile id of one mapped target against the profiles in hand.
 * PERSON_PROFILE -> matchRep(name) must be MAPPED; GROUP_PROFILE -> the profile with the fixed group id must exist and be ACTIVE.
 * @returns {{id: string}|{missing: string}}
 */
export function resolveProfile(target, profiles) {
  if (target.kind === 'GROUP_PROFILE') {
    const p = profiles.find((x) => x.id === target.groupId);
    return p && p.status !== 'INACTIVE' ? { id: p.id } : { missing: 'NO_GROUP_PROFILE' };
  }
  const m = matchRep(target.name, profiles);
  return m.status === 'MAPPED' ? { id: m.profile.id } : { missing: `PROFILE_${m.status}` };
}

/**
 * Plan one run.
 * @param shipments  {id, number, salesRepCode, salesRepId, voidedAt, revDivision, revSubdivision}
 * @param orders     {id, shipmentId, customerRepId}
 * @param proOf      (shipment) => PRO key or null
 * @param exportByPro Map<pro, {shipDate, repId}>
 * @param fileRepByPro Map<pro, {name: string|null, conflict: boolean}> the rep the equipment export names for the PRO
 * @param verdicts   verifyIdMap result
 * @param profiles   UserProfile rows (real, or real + planned for a preview)
 * @returns {{entries, unresolved, skipped}}
 *   entries     [{shipment, pro, repId, target, writes:[{table,id,field,value}]}]
 *   unresolved  [{shipment, pro, reason, repId?}] still without a rep after this run
 *   skipped     counts for shipments that already have a rep / are voided / belong to the file path
 */
export function planSalesRepFill({ shipments, orders, proOf, exportByPro, verdicts, profiles, fileRepByPro = new Map() }) {
  const ordersOf = new Map();
  for (const o of orders) {
    const k = String(o.shipmentId ?? '');
    if (k) ordersOf.set(k, [...(ordersOf.get(k) ?? []), o]);
  }
  const entries = [];
  const unresolved = [];
  const skipped = { voided: 0, hasRep: 0 };
  for (const s of shipments) {
    if (!blank(s.voidedAt)) { skipped.voided += 1; continue; }
    if (!blank(s.salesRepCode) || !blank(s.salesRepId)) { skipped.hasRep += 1; continue; }
    const pro = proOf(s);
    const ex = pro ? exportByPro.get(pro) : null;
    const file = pro ? fileRepByPro.get(pro) : null;
    let target;
    let repId = '';
    let source;
    let verdictStatus = 'FILE';
    if (file?.conflict) { unresolved.push({ shipment: s, pro, reason: 'FILE_REP_CONFLICT' }); continue; }
    if (file?.name) {
      target = NAME_MAP[file.name];
      if (!target) { unresolved.push({ shipment: s, pro, reason: 'FILE_NAME_UNKNOWN' }); continue; }
      source = 'FILE';
      repId = String(ex?.repId ?? '').trim();
    } else {
      source = 'ID_MAP';
      if (!pro) { unresolved.push({ shipment: s, pro, reason: 'NO_PRO_KEY' }); continue; }
      if (!ex) { unresolved.push({ shipment: s, pro, reason: 'NOT_IN_EXPORT' }); continue; }
      repId = String(ex.repId ?? '').trim();
      if (!repId) { unresolved.push({ shipment: s, pro, reason: 'EXPORT_ID_BLANK' }); continue; }
      target = ID_MAP[repId];
      if (!target) { unresolved.push({ shipment: s, pro, reason: 'ID_NOT_IN_MAP', repId }); continue; }
      if (target.from && !(ex.shipDate && ex.shipDate >= target.from)) { unresolved.push({ shipment: s, pro, reason: 'ID_AMBIGUOUS_BEFORE_2025', repId }); continue; }
      const verdict = verdicts.get(repId);
      if (verdict.status === 'AMBIGUOUS' || verdict.status === 'MISMATCH') { unresolved.push({ shipment: s, pro, reason: `ID_${verdict.status}`, repId }); continue; }
      verdictStatus = verdict.status;
    }
    const writes = [];
    let repProfileId = null;
    if (target.kind === 'PERSON_PROFILE' || target.kind === 'GROUP_PROFILE') {
      const r = resolveProfile(target, profiles);
      if (r.missing) { unresolved.push({ shipment: s, pro, reason: r.missing, repId }); continue; }
      repProfileId = r.id;
    }
    if (target.kind !== 'GROUP_PROFILE') writes.push({ table: 'Shipment', id: s.id, field: 'salesRepCode', value: target.name });
    if (repProfileId) {
      writes.push({ table: 'Shipment', id: s.id, field: 'salesRepId', value: repProfileId });
      for (const o of ordersOf.get(String(s.id)) ?? []) if (blank(o.customerRepId)) writes.push({ table: 'Order', id: o.id, field: 'customerRepId', value: repProfileId });
    }
    entries.push({ shipment: s, pro, repId, target, source, verdict: verdictStatus, shipDate: ex?.shipDate ?? null, preEvidenceEra: source === 'ID_MAP' && (!ex.shipDate || ex.shipDate < SCOPE_2025), writes });
  }
  return { entries, unresolved, skipped };
}

/** Counts per source (FILE / ID_MAP) and person for the report. */
export function tallyEntries(entries) {
  const out = {};
  for (const e of entries) {
    const k = `${e.source} ${e.target.name}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function countWrites(entries) {
  const out = { 'Shipment.salesRepCode': 0, 'Shipment.salesRepId': 0, 'Order.customerRepId': 0 };
  for (const e of entries) for (const w of e.writes) out[`${w.table}.${w.field}`] += 1;
  return out;
}
