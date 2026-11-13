/**
 * Pure planning for scripts/awCustomerDuplicateMerge.mjs (Ryne 2026-11-12: "anything that is a possible duplicate
 * can you merge with the potential duplicate?"). No I/O.
 *
 * Input: the customers the Customers page flags as "Possible duplicate" (buildDuplicateIndex), grouped by normalised
 * name, plus per-customer history counts. Output: one entry per cluster — the survivor and the customers merged into
 * it, or a skip with the reason.
 *
 * Survivor: a stored ACTIVE status first, then the most shipments + invoices, then billing set up (AP e-mail / billing method),
 * then the oldest. A cluster is skipped (left for a person) when its members disagree on an identifier — different
 * MC or DOT numbers, different HaulPay debtor ids — or bill to different cities/states, or when no member can survive
 * (CLOSED / BLOCKED never become a merge target).
 */

const digits = (v) => String(v ?? '').replace(/\D+/g, '').replace(/^0+/, '');
const text = (v) => String(v ?? '').trim();
const upper = (v) => text(v).toUpperCase();

/** Same rule as effectiveCustomerStatus: no stored status = ACTIVE unless archived. */
export function effectiveStatus(c) {
  if (!c.status) return c.active === false ? 'BLOCKED' : 'ACTIVE';
  return c.status;
}

function billingPlace(c) {
  const a = c.billingAddress && typeof c.billingAddress === 'object' ? c.billingAddress : null;
  const city = upper(a?.city);
  const state = upper(a?.state);
  return city && state ? `${city}, ${state}` : null;
}

function distinct(members, pick) {
  return [...new Set(members.map(pick).filter(Boolean))];
}

/** Why this cluster should not be merged automatically, or null. */
export function conflictReason(members) {
  const reasons = [];
  const mc = distinct(members, (c) => digits(c.mcNumber));
  if (mc.length > 1) reasons.push(`different MC numbers (${mc.join(' / ')})`);
  const dot = distinct(members, (c) => digits(c.dotNumber));
  if (dot.length > 1) reasons.push(`different DOT numbers (${dot.join(' / ')})`);
  const debtor = distinct(members, (c) => text(c.haulpayDebtorId));
  if (debtor.length > 1) reasons.push(`different HaulPay debtor ids (${debtor.join(' / ')})`);
  const places = distinct(members, billingPlace);
  if (places.length > 1) reasons.push(`different billing cities (${places.join(' / ')})`);
  return reasons.length ? reasons.join('; ') : null;
}

const canSurvive = (c) => !['CLOSED', 'BLOCKED'].includes(effectiveStatus(c)) && c.active !== false && !c.mergedIntoId;

/** Survivor first. `history(id)` = shipments + invoices. */
export function rankMembers(members, history) {
  // A stored ACTIVE status (the imported, set-up account) beats an intake-created row with no status: the merge only
  // fills the target's blanks, so the survivor should be the one whose billing method / terms / credit are real.
  const score = (c) => [
    c.status === 'ACTIVE' ? 1 : 0,
    history(c.id),
    text(c.apEmail) || text(c.billingMethod) ? 1 : 0,
  ];
  return [...members].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    const ca = text(a.createdAt);
    const cb = text(b.createdAt);
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * @param {Array<object>} customers every Customer row
 * @param {(customers: object[]) => Map<string, unknown>} buildDuplicateIndex the app's grouping
 * @param {(name: string) => string} normalize the app's name key
 * @param {(id: string) => {shipments: number, invoices: number}} counts history per customer
 */
export function planDuplicateMerges({ customers, buildDuplicateIndex, normalize, counts }) {
  const index = buildDuplicateIndex(customers.filter((c) => c.active !== false));
  const flagged = customers.filter((c) => index.has(c.id));
  const byKey = new Map();
  for (const c of flagged) {
    const k = normalize(c.name);
    const list = byKey.get(k);
    if (list) list.push(c);
    else byKey.set(k, [c]);
  }
  const history = (id) => {
    const n = counts(id);
    return (n?.shipments ?? 0) + (n?.invoices ?? 0);
  };
  const clusters = [];
  for (const [key, members] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const conflict = conflictReason(members);
    const ranked = rankMembers(members, history);
    const survivor = ranked.find(canSurvive) ?? null;
    if (conflict) clusters.push({ key, members: ranked, survivor: null, sources: [], skip: conflict });
    else if (!survivor) clusters.push({ key, members: ranked, survivor: null, sources: [], skip: 'no member can be the merge target (all CLOSED / BLOCKED)' });
    else clusters.push({ key, members: ranked, survivor, sources: ranked.filter((c) => c.id !== survivor.id), skip: null });
  }
  return { flaggedCount: flagged.length, clusters };
}
