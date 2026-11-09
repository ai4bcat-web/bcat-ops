/**
 * Pure planning for scripts/awSalesRepDivision.mjs (Ryne 2026-11-09): every live shipment's sales rep follows its revenue
 * division. ASSETS (Ivan Cartage, every subdivision) -> Ivan Cartage, CAR_SHIPPING -> Ruben Vargas, BROKERAGE -> Ryne Bandolik.
 * Unlike awSalesRepFill this OVERWRITES an existing rep; the read value is the condition of the write and goes in the audit row.
 * No I/O.
 */
import { matchRep } from './salesRepPlan.mjs';

export const DIVISION_REPS = Object.freeze({
  ASSETS: { name: 'Ivan Cartage', group: true },
  CAR_SHIPPING: { name: 'Ruben Vargas', group: false },
  BROKERAGE: { name: 'Ryne Bandolik', group: false },
});

const blank = (v) => v == null || String(v).trim() === '';

/** division -> { id, name, group } from the profiles in hand, plus what is missing. */
export function resolveDivisionProfiles(profiles) {
  const byDivision = {};
  const missing = [];
  for (const [division, rep] of Object.entries(DIVISION_REPS)) {
    const m = matchRep(rep.name, profiles);
    if (m.status === 'MAPPED') byDivision[division] = { id: m.profile.id, name: m.profile.name ?? rep.name, group: rep.group };
    else missing.push(`${division}:${rep.name}:${m.status}`);
  }
  return { byDivision, missing };
}

/** @returns {{entries, unchanged, skipped, settings}} */
export function planDivisionReps({ shipments, orders, profiles, currentSettingsMap = {} }) {
  const { byDivision, missing } = resolveDivisionProfiles(profiles);
  const ordersOf = new Map();
  for (const o of orders) ordersOf.set(String(o.shipmentId ?? ''), [...(ordersOf.get(String(o.shipmentId ?? '')) ?? []), o]);
  const entries = [];
  const skipped = { voided: 0, noRule: 0 };
  let unchanged = 0;
  for (const s of shipments) {
    if (!blank(s.voidedAt)) { skipped.voided += 1; continue; }
    const target = byDivision[s.revDivision];
    if (!target) { skipped.noRule += 1; continue; }
    const code = target.group ? '' : target.name.toUpperCase();
    const orderWrites = (ordersOf.get(String(s.id)) ?? []).filter((o) => o.customerRepId !== target.id)
      .map((o) => ({ table: 'Order', id: o.id, field: 'customerRepId', before: o.customerRepId ?? null, value: target.id }));
    const same = s.salesRepId === target.id && (s.salesRepCode ?? '') === code;
    if (same && orderWrites.length === 0) { unchanged += 1; continue; }
    entries.push({
      shipment: s, target, code,
      shipWrite: same ? null : { before: { salesRepId: s.salesRepId ?? null, salesRepCode: s.salesRepCode ?? null }, value: { salesRepId: target.id, salesRepCode: code } },
      orderWrites,
    });
  }
  const wanted = Object.fromEntries(Object.entries(byDivision).map(([d, t]) => [d, t.id]));
  const settings = { next: { ...currentSettingsMap, ...wanted }, changed: Object.entries(wanted).some(([d, id]) => currentSettingsMap[d] !== id) };
  return { entries, unchanged, skipped, missing, settings };
}
