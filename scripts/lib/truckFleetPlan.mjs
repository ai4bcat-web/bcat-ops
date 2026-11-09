/**
 * Pure planning for scripts/awTruckFleet.mjs (no AWS, no files). Ryne 2026-11-09, queue item 50.
 *
 * Two independent steps, each moves Equipment.fleetGroup of ONE truck per driver and nothing else:
 *   box-truck       Zak Pace's truck (unit 3890) LOCAL -> BOX_TRUCK. No schema change (BOX_TRUCK is in the Equipment enum).
 *                   Zak's DriverPaySetting.payGroup BOX_TRUCK is never touched: he stays in the Box Truck settlements.
 *   owner-operator  Chad Salerno's (423166), Lee Lara's (009) and Michael Bodle's (0012) trucks AMAZON -> OWNER_OPERATOR.
 *                   Needs the additive enum value OWNER_OPERATOR on Equipment.fleetGroup deployed first (the apply checks the
 *                   live AppSync schema and refuses until it is there).
 * Trailers are reported, never written. The driver is matched by name (+ id for Zak) among non-broker rows, the truck by
 * Driver.assignedTruckId, and the unit number must be the expected one: anything else is a PROBLEM and is not written.
 */

export const AUDIT_USER = 'system:awTruckFleet';
export const ENUM_NAME = 'EquipmentFleetGroup';

export const STEPS = Object.freeze({
  'box-truck': {
    to: 'BOX_TRUCK',
    needsEnumValue: false,
    targets: [
      { key: 'zak-pace', firsts: ['zak'], last: 'pace', id: 'd8a330f5-d927-4ffc-b60f-53d71e9348b4', unit: '3890', from: 'LOCAL' },
    ],
  },
  'owner-operator': {
    to: 'OWNER_OPERATOR',
    needsEnumValue: true,
    targets: [
      { key: 'chad-salerno', firsts: ['chad'], last: 'salerno', unit: '423166', from: 'AMAZON' },
      { key: 'lee-lara', firsts: ['lee'], last: 'lara', unit: '009', from: 'AMAZON' },
      { key: 'michael-bodle', firsts: ['michael', 'mike'], last: 'bodle', unit: '0012', from: 'AMAZON' },
    ],
  },
});
export const STEP_NAMES = Object.keys(STEPS);

const str = (v) => (v == null ? '' : String(v));
const norm = (v) => str(v).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
const isNamed = (d, firsts, last) => {
  const t = norm(d.name);
  return t.length >= 2 && firsts.includes(t[0]) && t[t.length - 1] === last;
};

/**
 * @returns {{ entries: Array<{key,status,problem?,driverId?,firstName?,equipmentId?,unit?,from,to,current?,trailers:Array}>, toWrite: Array }}
 * status: WRITE (still `from`) | DONE (already `to`) | PROBLEM (not found / ambiguous / wrong unit / not a truck / other fleet value)
 */
export function planStep(step, { drivers, equipment }) {
  const spec = STEPS[step];
  if (!spec) throw new Error(`unknown step "${step}" (${STEP_NAMES.join(' | ')})`);
  const entries = spec.targets.map((t) => {
    const base = { key: t.key, from: t.from, to: spec.to, unit: t.unit, trailers: [] };
    const hits = drivers.filter((d) => str(d.type).toLowerCase() !== 'broker' && (t.id ? d.id === t.id : isNamed(d, t.firsts, t.last)));
    if (hits.length !== 1) return { ...base, status: 'PROBLEM', problem: hits.length === 0 ? 'DRIVER_NOT_FOUND' : `DRIVER_AMBIGUOUS_${hits.length}` };
    const driver = hits[0];
    if (t.id && !isNamed(driver, t.firsts, t.last)) return { ...base, status: 'PROBLEM', problem: 'ID_MATCHES_BUT_NAME_DOES_NOT' };
    const withDriver = { ...base, driverId: driver.id, firstName: norm(driver.name)[0] ?? '' };
    const trailers = equipment
      .filter((e) => e.type === 'trailer' && (e.assignedDriverId === driver.id || e.id === driver.assignedTrailerId))
      .map((e) => ({ unit: e.unitNumber, fleetGroup: e.fleetGroup ?? null }));
    const truck = equipment.find((e) => e.id === driver.assignedTruckId);
    if (!truck) return { ...withDriver, trailers, status: 'PROBLEM', problem: 'TRUCK_NOT_FOUND' };
    const out = { ...withDriver, trailers, equipmentId: truck.id, current: truck.fleetGroup ?? null, unit: str(truck.unitNumber) };
    if (truck.type !== 'truck') return { ...out, status: 'PROBLEM', problem: 'NOT_A_TRUCK' };
    if (out.unit !== t.unit) return { ...out, status: 'PROBLEM', problem: `UNIT_${out.unit}_NOT_${t.unit}` };
    if (truck.assignedDriverId && truck.assignedDriverId !== driver.id) return { ...out, status: 'PROBLEM', problem: 'TRUCK_ASSIGNED_TO_ANOTHER_DRIVER' };
    if (truck.fleetGroup === spec.to) return { ...out, status: 'DONE' };
    if (truck.fleetGroup !== t.from) return { ...out, status: 'PROBLEM', problem: `FLEET_IS_${truck.fleetGroup ?? 'BLANK'}_NOT_${t.from}` };
    return { ...out, status: 'WRITE' };
  });
  return { entries, toWrite: entries.filter((e) => e.status === 'WRITE') };
}

/** True when an AppSync SDL schema lists `value` in enum `name`. */
export function enumHasValue(sdl, name, value) {
  const m = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(sdl);
  return !!m && m[1].split(/\s+/).filter(Boolean).includes(value);
}

/** The reason an apply of `step` must be refused before any write, or null. */
export function applyRefusal(step, { problems, enumHasTarget }) {
  const spec = STEPS[step];
  if (problems.length) return `refusing: ${problems.length} planned row(s) are PROBLEM (${problems.map((p) => `${p.key}:${p.problem}`).join(', ')})`;
  if (spec.needsEnumValue && !enumHasTarget) return `refusing: the live schema's ${ENUM_NAME} has no ${spec.to} yet (needs the additive enum value deployed to production first)`;
  return null;
}

/** Rollback entries from an export manifest: only rows that still hold the value this script wrote are restored. */
export function planRollback(manifest, currentById) {
  return manifest.entries.map((e) => {
    const cur = currentById.get(e.equipmentId);
    if (!cur) return { ...e, status: 'MISSING' };
    if (cur.fleetGroup === e.from) return { ...e, status: 'ALREADY_RESTORED' };
    if (cur.fleetGroup !== e.to) return { ...e, status: 'CHANGED_SINCE', current: cur.fleetGroup ?? null };
    return { ...e, status: 'RESTORE' };
  });
}
