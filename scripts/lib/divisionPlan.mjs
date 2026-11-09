/**
 * Pure planning for scripts/awDivisions.mjs (no AWS, no files).
 *
 *  1. DRIVER TYPES (Ryne 2026-11-09): Driver.fleetGroup (the Files > Drivers "Type" column) is the SOURCE OF TRUTH and is never written. Driver.driverType
 *     is only a coarser label; it is written ONLY where it CONTRADICTS the fleet group (src/lib/driverOwnership.ts decides what the fleet implies):
 *     fleet OWNER_OPERATOR/AMAZON with driverType COMPANY -> OWNER_OPERATOR; fleet LOCAL/BOX_TRUCK with driverType OWNER_OPERATOR -> COMPANY. A blank
 *     driverType is NOT written (every consumer reads the fleet first); it is only reported. fleetGroup / DriverPaySetting.payGroup / Equipment are
 *     REPORTED when they disagree, never changed (they decide the pay model, the file checklist and fleet profitability).
 *  2. RETIRE the COMPANY OwnershipDivision (same business as Ivan Cartage, ASSETS): nothing may reference it, so the apply deletes the one
 *     division row after a live re-check and refuses while any referencing row exists.
 *
 * The division a driver lands in is derived with the app's own resolver (src/lib/ownership.ts: shipmentContextFor + resolveDivision), the same
 * code tms-shipment-actions runs after a driver is assigned (handler.ts recordsForTag -> applyTag), fed with the production division + rule rows.
 */
import { resolveDivision, shipmentContextFor, topLevelOf } from '../../src/lib/ownership.ts';
import { driverOwnershipKind, effectiveDriverType } from '../../src/lib/driverOwnership.ts';

export const COMPANY_CODE = 'COMPANY';
export const ASSETS_CODE = 'ASSETS';
export const AUDIT_USER = 'system:awDivisions';

const str = (v) => (v == null ? '' : String(v));
const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const norm = (v) => str(v).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);

/** Ryne's roster (the Files > Drivers Type column). group: OWNER_OPERATOR -> fleet OWNER_OPERATOR / ASSETS/OWNER_OPERATOR; IVAN -> fleet LOCAL (BOX_TRUCK for Zak) / ASSETS/<that>. Read-only expectations: never written. */
export const DRIVER_TARGETS = Object.freeze([
  { key: 'chad-salerno', firsts: ['chad'], last: 'salerno', group: 'OWNER_OPERATOR', expectSub: 'OWNER_OPERATOR' },
  { key: 'michael-bodle', firsts: ['michael', 'mike'], last: 'bodle', group: 'OWNER_OPERATOR', expectSub: 'OWNER_OPERATOR' },
  { key: 'john-brittich', firsts: ['john'], last: 'brittich', group: 'IVAN', expectSub: null },
  { key: 'jason-smith', firsts: ['jason'], last: 'smith', group: 'IVAN', expectSub: null },
  { key: 'daniel-palmer', firsts: ['daniel'], last: 'palmer', group: 'IVAN', expectSub: null },
  { key: 'eulalio-cortez', firsts: ['eulalio'], last: 'cortez', group: 'IVAN', expectSub: null },
  { key: 'joshua-kly', firsts: ['joshua'], last: 'kly', group: 'IVAN', expectSub: null },
  { key: 'zak-pace', firsts: ['zak'], last: 'pace', id: 'd8a330f5-d927-4ffc-b60f-53d71e9348b4', group: 'IVAN', expectSub: 'BOX_TRUCK' },
  { key: 'armando-aranda', firsts: ['armando'], last: 'aranda', group: 'IVAN', expectSub: null },
]);

const isNamed = (driver, firsts, last) => {
  const t = norm(driver.name);
  return t.length >= 2 && firsts.includes(t[0]) && t[t.length - 1] === last;
};
const isRosterDriver = (d) => str(d.type).toLowerCase() !== 'broker';

/**
 * One roster driver per target. Zak is matched by his id AND name; everyone else by first + last name among non-broker rows.
 * Anything not exactly one row is a problem and is not written.
 */
export function matchDrivers(drivers, targets = DRIVER_TARGETS) {
  const matched = new Map();
  const problems = [];
  for (const t of targets) {
    const hits = drivers.filter((d) => isRosterDriver(d) && (t.id ? d.id === t.id : isNamed(d, t.firsts, t.last)));
    if (t.id && hits.length === 1 && !isNamed(hits[0], t.firsts, t.last)) problems.push({ key: t.key, reason: 'id matches but name does not' });
    else if (hits.length === 1) matched.set(t.key, hits[0]);
    else problems.push({ key: t.key, reason: hits.length === 0 ? 'NOT_FOUND' : `AMBIGUOUS_${hits.length}` });
  }
  return { matched, problems };
}

/**
 * Driver.driverType writes: only a stored type that CONTRADICTS the fleet group. `prev` is what the conditional write requires.
 * Status: WRITE (contradiction), NOOP (agrees), BLANK_LEFT (no type stored; reported, never written). Drivers without a fleet group are not planned.
 */
export function planDriverTypes(drivers) {
  const entries = [];
  for (const d of drivers.filter(isRosterDriver)) {
    if (blank(d.fleetGroup)) continue;
    const next = effectiveDriverType({ fleetGroup: d.fleetGroup });
    if (!next) continue;
    const prev = blank(d.driverType) ? null : d.driverType;
    entries.push({ key: `${norm(d.name)[0] ?? 'driver'}-${String(d.id).slice(0, 8)}`, id: d.id, fleetGroup: d.fleetGroup, prev, next, status: prev === null ? 'BLANK_LEFT' : prev === next ? 'NOOP' : 'WRITE' });
  }
  return { entries, problems: [] };
}

/** The divisions as the resolver wants them. */
const divisionShape = (r) => ({ id: r.id ?? r.code, code: r.code, parentId: r.parentId ?? null, active: r.active !== false, sortOrder: r.sortOrder ?? 0 });

/** Which division the app's resolver gives an own-fleet shipment driven by `driver` (null/blank fields as stored). */
export function resolveOwnFleet(divisions, rules, driver) {
  const ctx = shipmentContextFor({
    loadCarrier: { kind: 'OWN_ASSET' },
    driver: { fleetGroup: driver.fleetGroup ?? null, driverType: driver.driverType ?? null, ivanApp: driver.ivanApp ?? null, timeClock: driver.timeClock ?? null },
  });
  const r = resolveDivision(divisions.map(divisionShape), rules.map((x) => ({ ...x, sortOrder: x.sortOrder ?? 0 })), ctx);
  return { top: r.revDivision, sub: r.revSubdivision, ruleId: r.ruleId };
}

const label = (r) => (r.top ? (r.sub ? `${r.top}/${r.sub}` : r.top) : 'UNTAGGED');

/**
 * The profile review: per roster driver, current vs proposed type / fleet group / pay group, the truck + trailer in the asset location,
 * the division before and after, and the mismatch flags Ryne should look at. Nothing but driverType is ever proposed as a write.
 */
export function reviewDrivers({ drivers, paySettings, equipment, divisions, rules, targets = DRIVER_TARGETS }) {
  const { entries } = planDriverTypes(drivers);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const targetOf = new Map([...matchDrivers(drivers, targets).matched].map(([key, d]) => [d.id, targets.find((t) => t.key === key)]));
  const equipById = new Map(equipment.map((e) => [e.id, e]));
  const payBy = new Map();
  for (const p of paySettings) if (p.active !== false) payBy.set(p.driverId, [...(payBy.get(p.driverId) ?? []), p.payGroup].filter(Boolean));
  const rows = [];
  for (const d of drivers.filter(isRosterDriver)) {
    const e = byId.get(d.id);
    const target = targetOf.get(d.id);
    const truck = d.assignedTruckId ? equipById.get(d.assignedTruckId) : null;
    const trailer = d.assignedTrailerId ? equipById.get(d.assignedTrailerId) : null;
    const payGroups = payBy.get(d.id) ?? [];
    const proposedType = e?.status === 'WRITE' ? e.next : (d.driverType ?? null);
    const before = resolveOwnFleet(divisions, rules, d);
    const after = resolveOwnFleet(divisions, rules, { ...d, driverType: proposedType });
    const flags = [];
    if (e?.status === 'WRITE') flags.push(`TYPE_CHANGE ${e.prev ?? 'blank'}->${e.next}`);
    if (e?.status === 'BLANK_LEFT') flags.push('TYPE_BLANK_LEFT (fleet group is read first; not written)');
    if (!e && blank(d.driverType)) flags.push('NO_FLEET_NO_TYPE');
    if (d.fleetGroup && payGroups.length && !payGroups.includes(d.fleetGroup)) flags.push(`FLEET_VS_PAYGROUP ${d.fleetGroup} vs ${payGroups.join('+')}`);
    if (!payGroups.length && target?.group === 'OWNER_OPERATOR') flags.push('NO_PAY_SETTING');
    if (proposedType === 'OWNER_OPERATOR' && d.fleetGroup && !['AMAZON', 'OWNER_OPERATOR'].includes(d.fleetGroup)) flags.push(`OWNER_OP_BUT_FLEET_${d.fleetGroup}`);
    if (proposedType === 'COMPANY' && ['AMAZON', 'OWNER_OPERATOR'].includes(d.fleetGroup ?? '')) flags.push(`COMPANY_BUT_FLEET_${d.fleetGroup}`);
    if (target?.group === 'OWNER_OPERATOR' && d.fleetGroup === 'AMAZON') flags.push('OWNER_OP_ON_AMAZON_FLEET_PAYGROUP (not changed: moves the pay model)');
    if (!blank(d.fleetGroup) && truck && !blank(truck.fleetGroup) && truck.fleetGroup !== d.fleetGroup) flags.push(`TRUCK_FLEET ${truck.fleetGroup} vs driver ${d.fleetGroup}`);
    if (d.fleetGroup === 'BOX_TRUCK' && truck && truck.fleetGroup !== 'BOX_TRUCK') flags.push('BOX_TRUCK_DRIVER_TRUCK_NOT_BOX_TRUCK_GROUP');
    if (d.assignedTruckId && !truck) flags.push('ASSIGNED_TRUCK_NOT_FOUND');
    if (truck && truck.assignedDriverId && truck.assignedDriverId !== d.id) flags.push('TRUCK_ASSIGNED_TO_OTHER_DRIVER');
    if (d.active !== false && target && !d.assignedTruckId) flags.push('NO_TRUCK');
    if (blank(d.unitType) && target) flags.push('UNIT_TYPE_BLANK');
    if (target) {
      const kind = driverOwnershipKind({ fleetGroup: d.fleetGroup });
      const rightFleet = target.group === 'OWNER_OPERATOR' ? kind === 'OWNER_OPERATOR' : target.expectSub === 'BOX_TRUCK' ? kind === 'BOX_TRUCK' : kind === 'LOCAL';
      if (!rightFleet) flags.push(`FLEET_NOT_AS_RYNE_LISTED ${d.fleetGroup ?? 'blank'}`);
      if (after.top !== ASSETS_CODE) flags.push(`DIVISION_NOT_ASSETS ${label(after)}`);
      if (target.expectSub && after.sub !== target.expectSub) flags.push(`EXPECTED_${target.expectSub}_GOT_${label(after)}`);
    }
    rows.push({
      id: d.id, firstName: norm(d.name)[0] ?? '', active: d.active !== false,
      driverType: { current: d.driverType ?? null, proposed: proposedType },
      fleetGroup: { current: d.fleetGroup ?? null, proposed: d.fleetGroup ?? null },
      payGroup: { current: payGroups.join('+') || null, proposed: payGroups.join('+') || null },
      unitType: d.unitType ?? null,
      truck: truck ? { unit: truck.unitNumber, fleetGroup: truck.fleetGroup ?? null } : null,
      trailer: trailer ? { unit: trailer.unitNumber } : null,
      before: label(before), after: label(after),
      topUnchanged: before.top === after.top && before.sub === after.sub,
      status: e ? e.status : 'NO_FLEET',
      flags,
    });
  }
  return rows;
}

/**
 * Everything that can name the COMPANY division. Spec per table: which fields, and how the value is shaped.
 *  string  - the field equals the code            array - the string array contains it           json - any string inside the JSON equals it
 */
export const COMPANY_REF_SPECS = Object.freeze([
  { model: 'OwnershipRule', kind: 'string', fields: ['divisionCode'] },
  { model: 'Shipment', kind: 'string', fields: ['revDivision', 'revSubdivision'] },
  { model: 'Load', kind: 'string', fields: ['revDivision', 'revSubdivision', 'divisionKey'] },
  { model: 'LaneRateSample', kind: 'string', fields: ['revDivision', 'revSubdivision', 'divisionKey'] },
  { model: 'Customer', kind: 'string', fields: ['defaultDivisionKey'] },
  { model: 'Invoice', kind: 'string', fields: ['divisionKey'] },
  { model: 'CarrierBill', kind: 'string', fields: ['divisionKey'] },
  { model: 'Quote', kind: 'string', fields: ['divisionKey'] },
  { model: 'Commission', kind: 'string', fields: ['divisionKey'] },
  { model: 'IntakeLoad', kind: 'string', fields: ['divisionCode'] },
  { model: 'UserProfile', kind: 'array', fields: ['divisions'] },
  { model: 'ShipmentView', kind: 'json', fields: ['filters', 'audience'] },
  { model: 'TmsSettings', kind: 'json', fields: ['divisionSalesReps'] },
  { model: 'OwnershipDivision', kind: 'string', fields: ['parentId'] },
]);

const jsonHas = (v, code) => {
  let x = v;
  for (let i = 0; i < 4 && typeof x === 'string'; i++) {
    try { x = JSON.parse(x); } catch { break; }
  }
  if (typeof x === 'string') return x === code;
  if (Array.isArray(x)) return x.some((y) => jsonHas(y, code));
  if (x && typeof x === 'object') return Object.entries(x).some(([k, y]) => k === code || jsonHas(y, code));
  return false;
};

/** Does this row reference the code in any of the spec's fields? Returns the matching field names. */
export function refFields(spec, row, code = COMPANY_CODE) {
  return spec.fields.filter((f) => {
    const v = row[f];
    if (v == null) return false;
    if (spec.kind === 'string') return v === code;
    if (spec.kind === 'array') return Array.isArray(v) && v.includes(code);
    return jsonHas(v, code);
  });
}

/** Counts per model/field of rows that name the code. The division row itself is not a reference. */
export function countCompanyRefs(rowsByModel, code = COMPANY_CODE) {
  const out = {};
  for (const spec of COMPANY_REF_SPECS) {
    const rows = rowsByModel[spec.model] ?? [];
    for (const r of rows) {
      if (spec.model === 'OwnershipDivision' && r.id === code) continue;
      for (const f of refFields(spec, r, code)) {
        const k = `${spec.model}.${f}`;
        out[k] = (out[k] ?? 0) + 1;
      }
    }
  }
  return out;
}

/** The retire plan: the COMPANY row (if it exists) and the references that would block deleting it. */
export function planRetire({ divisions, rowsByModel }) {
  const row = divisions.find((d) => d.id === COMPANY_CODE || d.code === COMPANY_CODE) ?? null;
  const refs = countCompanyRefs(rowsByModel);
  const blocking = Object.values(refs).reduce((a, b) => a + b, 0);
  const assets = divisions.find((d) => d.code === ASSETS_CODE);
  const topOfAssets = assets ? topLevelOf(divisions.map(divisionShape), ASSETS_CODE) : null;
  return {
    row,
    refs,
    blocking,
    assetsActive: Boolean(assets && assets.active !== false && topOfAssets === ASSETS_CODE),
    status: !row ? 'ALREADY_GONE' : blocking > 0 ? 'BLOCKED_BY_REFERENCES' : 'DELETE',
  };
}
