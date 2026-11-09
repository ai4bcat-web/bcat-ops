/**
 * Pure planning for scripts/awZakDriver.mjs: Aljex equipment code ZAK is the DRIVER (Ryne's decision), so every shipment whose
 * equipment-export code is ZAK gets the driver Zak Pace on its own-asset (Ivan Cartage) leg. Enrich only: a driver is set only where
 * the load has no driver at all; a different driver anywhere is reported, never overwritten.
 *
 * Join (same as awEquipRep): PRO -> Shipment via the numeric Shipment.number / `L<pro>`, then Load.aljexId, then ProClaim ids.
 */
import { DRIVER_CODES, SCOPE_FROM, inScope, isBlank, normCode, shipmentKeys } from './equipRepPlan.mjs';

export const ZAK_DRIVER_ID = 'd8a330f5-d927-4ffc-b60f-53d71e9348b4';

export const STATUS = Object.freeze({
  TO_SET: 'TO_SET',
  ALREADY_ZAK: 'ALREADY_ZAK',
  DIFFERENT_DRIVER: 'DIFFERENT_DRIVER',
  NO_LEG: 'NO_LEG',
  NOT_FOUND: 'NOT_FOUND',
  OLDER: 'OLDER',
  NO_SHIP_DATE: 'NO_SHIP_DATE',
  VOIDED: 'VOIDED',
  OTHER: 'OTHER',
});

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `load.stops` is AWSJSON (string, possibly double encoded) or an array. Always an array of stop objects, sorted by sequence. */
export function parseStops(load) {
  let stops = load.stops;
  for (let i = 0; i < 4 && typeof stops === 'string'; i++) {
    try { stops = JSON.parse(stops); } catch { break; }
  }
  return Array.isArray(stops) ? [...stops].sort((a, b) => (a?.sequence ?? 0) - (b?.sequence ?? 0)) : [];
}

/** PROs whose equipment-export code is exactly ZAK (a PRO with a second, different code is a conflict: not ours). */
export function zakPros(sourceByPro) {
  const zak = new Set();
  const conflicted = new Set();
  for (const [pro, s] of sourceByPro) {
    const codes = [...s.equip].map(normCode);
    if (!codes.some((c) => DRIVER_CODES.includes(c))) continue;
    if (codes.length === 1) zak.add(pro);
    else conflicted.add(pro);
  }
  return { zak, conflicted };
}

/** Every driver id the load already carries, by layer. */
export function driversOf(load, leg) {
  const stopIds = parseStops(load).map((s) => text(s?.driverId)).filter(Boolean);
  return {
    leg: text(leg?.driverId),
    pickup: text(load.pickupDriverId),
    delivery: text(load.deliveryDriverId),
    stops: stopIds,
  };
}

/**
 * The enrich-only writes of one load given the roster driver. Never a field that already holds a value.
 * @returns {Array<{table: 'LoadCarrier'|'Load', id: string, field: string, value: unknown}>}
 */
export function planWrites({ load, leg, driver }) {
  const writes = [];
  const d = driversOf(load, leg);
  if (!d.leg) {
    writes.push({ table: 'LoadCarrier', id: leg.id, field: 'driverId', value: driver.id });
    if (isBlank(leg.driverName)) writes.push({ table: 'LoadCarrier', id: leg.id, field: 'driverName', value: driver.name });
    if (isBlank(leg.driverPhone) && text(driver.phone)) writes.push({ table: 'LoadCarrier', id: leg.id, field: 'driverPhone', value: driver.phone });
  } else if (isBlank(leg.driverName) && d.leg === driver.id) {
    writes.push({ table: 'LoadCarrier', id: leg.id, field: 'driverName', value: driver.name });
  }
  return writes;
}

/** @param {{shipments: any[], loads: any[], legs: any[], claims: any[], zakProSet: Set<string>, exportByPro: Map<string, any>, driver: {id: string, name: string, phone?: string}}} i */
export function planZak({ shipments, loads, legs, claims, zakProSet, exportByPro, driver }) {
  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) if (r[key]) (m.get(r[key]) ?? m.set(r[key], []).get(r[key])).push(r);
    return m;
  };
  const loadsBy = group(loads, 'shipmentId');
  const claimsBy = group(claims, 'shipmentId');
  const legsBy = group(legs, 'loadId');
  const byPro = new Map();
  for (const shipment of shipments) {
    const ls = loadsBy.get(shipment.id) ?? [];
    const pro = shipmentKeys(shipment, ls, claimsBy.get(shipment.id) ?? []).find((k) => zakProSet.has(k));
    if (pro) (byPro.get(pro) ?? byPro.set(pro, []).get(pro)).push({ shipment, loads: ls });
  }
  const results = [];
  for (const pro of [...zakProSet].sort()) {
    const ex = exportByPro.get(pro) ?? null;
    const shipDate = ex?.shipDate ?? null;
    const base = { pro, shipDate, status: STATUS.OTHER, reason: '', currentDriverId: '', writes: [] };
    const found = byPro.get(pro) ?? [];
    if (found.length === 0) { results.push({ ...base, status: STATUS.NOT_FOUND, reason: 'no production shipment for this PRO' }); continue; }
    // Older than the scope: the pre-2025 delete removes these; never written.
    if (shipDate && !inScope(shipDate)) { results.push({ ...base, status: STATUS.OLDER, reason: `ship date ${shipDate} < ${SCOPE_FROM}, being deleted`, found: found[0].shipment.id }); continue; }
    const live = found.filter((f) => !f.shipment.voidedAt);
    if (live.length === 0) { results.push({ ...base, status: STATUS.VOIDED, reason: 'shipment voided' }); continue; }
    if (live.length > 1) { results.push({ ...base, reason: `${live.length} live shipments share this PRO` }); continue; }
    if (!shipDate) { results.push({ ...base, status: STATUS.NO_SHIP_DATE, reason: ex ? 'no usable ship date in the full export' : 'PRO not in the full export' }); continue; }
    const { shipment, loads: ls } = live[0];
    const liveLoads = ls.filter((l) => !l.voidedAt && l.status !== 'CANCELED');
    if (liveLoads.length !== 1) { results.push({ ...base, shipmentId: shipment.id, reason: `${liveLoads.length} live loads on the shipment` }); continue; }
    const load = liveLoads[0];
    const active = (legsBy.get(load.id) ?? []).filter((l) => l.status === 'ACTIVE');
    const own = active.filter((l) => l.kind === 'OWN_ASSET');
    if (active.length > 1) { results.push({ ...base, shipmentId: shipment.id, loadId: load.id, reason: `${active.length} active legs` }); continue; }
    if (own.length === 0) {
      const other = active[0]?.kind;
      results.push({ ...base, status: other ? STATUS.OTHER : STATUS.NO_LEG, shipmentId: shipment.id, loadId: load.id, reason: other ? `active leg is ${other}, not OWN_ASSET` : 'no active OWN_ASSET LoadCarrier' });
      continue;
    }
    const leg = own[0];
    const d = driversOf(load, leg);
    const all = [d.leg, d.pickup, d.delivery, ...d.stops].filter(Boolean);
    const different = [...new Set(all.filter((id) => id !== driver.id))];
    const state = (id) => (id ? (id === driver.id ? 'zak' : 'other') : 'blank');
    const facts = {
      leg: state(d.leg), legName: isBlank(leg.driverName) ? 'blank' : 'set', delivery: state(d.delivery), pickup: state(d.pickup),
      stops: d.stops.length === 0 ? 'blank' : 'zak', legacyImported: load.legacyImported === true, loadStatus: load.status ?? '', rateConfirmKey: !isBlank(load.rateConfirmKey),
    };
    const common = { ...base, shipmentId: shipment.id, loadId: load.id, legId: leg.id, facts };
    if (different.length > 0) { results.push({ ...common, status: STATUS.DIFFERENT_DRIVER, currentDriverId: different.join('|'), reason: 'another driver is already on the load or its leg' }); continue; }
    const writes = planWrites({ load, leg, driver });
    if (writes.length === 0) results.push({ ...common, status: STATUS.ALREADY_ZAK, currentDriverId: driver.id, reason: 'leg already names Zak' });
    else results.push({ ...common, status: STATUS.TO_SET, currentDriverId: all.length ? driver.id : '', reason: all.length ? 'Zak on part of the load; fill the leg' : 'no driver anywhere', writes });
  }
  return results;
}
