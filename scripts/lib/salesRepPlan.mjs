/**
 * Pure planning for scripts/awSalesRepId.mjs: which person each Aljex sales rep name on a shipment is, and which
 * Shipment / Order rows get their id. No I/O here; the script scans, this decides.
 *
 * The Aljex import stored the sales rep as a NAME (`Shipment.salesRepCode`, e.g. "RYNE BANDOLIK"). The "Sales rep"
 * required field and the rep picker read `Shipment.salesRepId` / `Order.customerRepId` (a UserProfile id = the Cognito
 * username), so this maps name -> profile and fills the empty ids. ENRICH ONLY: a target already holding a value is never
 * touched, a voided shipment is skipped (the app's SET_SALES_REP refuses one), no money / status field is involved.
 */

export const SHIPMENT_FIELD = 'salesRepId';
/** `Order` has no `salesRepId`; SET_SALES_REP mirrors the rep onto `customerRepId`. */
export const ORDER_FIELD = 'customerRepId';
/** The only fields this enrich may write, per table. */
export const WRITABLE = { Shipment: [SHIPMENT_FIELD], Order: [ORDER_FIELD] };

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

/** Upper/lower-case, accents and punctuation folded away: "O'Brien, Jo-Ann" -> "obrien jo ann"; letters + single spaces. */
export function normName(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const letters = (s) => normName(s).replace(/\s+/g, '');
const localPart = (email) => String(email ?? '').split('@')[0] ?? '';

/**
 * The e-mail local parts that identify "Jane Q Doe": the first name alone, first+last, first initial + last, last+first.
 * Compared with every non-letter dropped, so jane.doe, jane_doe and janedoe are all "janedoe". A first name alone only
 * counts when the whole local part is that first name.
 */
export function localPartKeys(name) {
  const words = normName(name).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : '';
  const keys = new Set([first]);
  if (last) { keys.add(first + last); keys.add(first[0] + last); keys.add(last + first); }
  return [...keys];
}

/**
 * One rep name -> one profile, or a reason it stays a name.
 *   MAPPED     exactly one ACTIVE/PENDING profile matched at the best tier
 *   AMBIGUOUS  two or more distinct profiles matched at the best tier (never guessed)
 *   INACTIVE   the only match is an INACTIVE profile (the picker hides it, so it is left alone)
 *   NONE       nobody matched
 * Tier 1: the profile's own `name` equals the rep name. Tier 2: the e-mail local part is one of `localPartKeys`.
 * A tier with only INACTIVE matches does not fall through to a weaker tier.
 */
export function matchRep(repName, profiles) {
  const want = normName(repName);
  if (!want) return { status: 'NONE', candidates: [] };
  const tier1 = profiles.filter((p) => normName(p.name) === want);
  const keys = new Set(localPartKeys(repName));
  const tier2 = profiles.filter((p) => keys.has(letters(localPart(p.email))));
  for (const tier of [tier1, tier2]) {
    if (tier.length === 0) continue;
    const live = tier.filter((p) => p.status !== 'INACTIVE');
    if (live.length === 1) return { status: 'MAPPED', profile: live[0], candidates: live };
    if (live.length > 1) return { status: 'AMBIGUOUS', candidates: live };
    return { status: 'INACTIVE', candidates: tier };
  }
  return { status: 'NONE', candidates: [] };
}

/** `Map<repName, matchRep result>` for every distinct non-blank salesRepCode (keyed by the stored string, trimmed). */
export function mapRepNames(names, profiles) {
  const out = new Map();
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name || out.has(name)) continue;
    out.set(name, matchRep(name, profiles));
  }
  return out;
}

/**
 * Plan every write. `shipments` {id, salesRepCode, salesRepId, voidedAt?}, `orders` {id, shipmentId, customerRepId},
 * `mapping` from mapRepNames. Returns { entries, skipped }: an entry is one shipment with its conditional writes
 * [{table, id, field, value}]; `skipped` are counted by reason.
 *
 * Per shipment: no code or an unmapped code -> nothing; voided -> skipped; the shipment already carries a DIFFERENT rep
 * -> skipped as CONFLICT (an Order is never given a rep the shipment does not have); otherwise the Shipment is written
 * only while its id is empty and each of its Orders only while its customerRepId is empty.
 */
export function planSalesRepIds({ shipments, orders, mapping }) {
  const ordersOf = new Map();
  for (const o of orders) {
    const key = String(o.shipmentId ?? '');
    if (key) ordersOf.set(key, [...(ordersOf.get(key) ?? []), o]);
  }
  const entries = [];
  const skipped = { noCode: 0, unmapped: 0, voided: 0, conflict: 0, alreadyComplete: 0 };
  for (const s of shipments) {
    const code = String(s.salesRepCode ?? '').trim();
    if (!code) { skipped.noCode += 1; continue; }
    const m = mapping.get(code);
    if (!m || m.status !== 'MAPPED') { skipped.unmapped += 1; continue; }
    if (!blank(s.voidedAt)) { skipped.voided += 1; continue; }
    const repId = m.profile.id;
    if (!blank(s.salesRepId) && s.salesRepId !== repId) { skipped.conflict += 1; continue; }
    const writes = [];
    if (blank(s.salesRepId)) writes.push({ table: 'Shipment', id: s.id, field: SHIPMENT_FIELD, value: repId });
    for (const o of ordersOf.get(String(s.id)) ?? []) {
      if (blank(o.customerRepId)) writes.push({ table: 'Order', id: o.id, field: ORDER_FIELD, value: repId });
    }
    if (writes.length === 0) { skipped.alreadyComplete += 1; continue; }
    entries.push({ shipment: s, code, repId, writes });
  }
  return { entries, skipped };
}

/** Counts per table for the TO APPLY line. */
export function countWrites(entries) {
  const out = { Shipment: 0, Order: 0 };
  for (const e of entries) for (const w of e.writes) out[w.table] += 1;
  return out;
}

/**
 * The profiles a PREVIEW uses: the table's rows plus the rows the backfill's dry-run plan would add (the table wins on
 * an id clash, as the backfill never overwrites). `plan` is the JSON written by `backfillUserProfiles.mjs --plan`.
 * Each plan-only profile carries `planned: true` so output can label it.
 */
export function profilesFromPlan(plan, tableProfiles) {
  if (!plan || !Array.isArray(plan.actions)) throw new Error('--assume-profiles: not a backfillUserProfiles plan (no actions[])');
  const have = new Set(tableProfiles.map((p) => String(p.id)));
  const planned = [];
  for (const a of plan.actions) {
    const item = a?.item;
    if (a?.action !== 'PUT_USER_PROFILE' || !item?.id) continue;
    if (have.has(String(item.id))) continue;
    planned.push({ id: item.id, email: item.email, name: item.name ?? null, role: item.role ?? null, status: item.status ?? null, planned: true });
  }
  return [...tableProfiles, ...planned];
}
