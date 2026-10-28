#!/usr/bin/env node
/**
 * Backfill the lane rate history (Step H).
 *
 * Step H adds `LaneRateSample` — one row per delivered load, keyed by lane — and the
 * Historical Rates panel reads nothing else. New loads write their own sample from
 * `tmsShipmentActions`; the 890 loads already on dev were copied in before that code
 * existed, so without this migration the panel opens onto an empty lane on every
 * quote a dispatcher prices.
 *
 * One pass over Load, with the money read off the rows that hold money:
 *
 *   BACKFILL     — every Load at DELIVERED or later that has a `LoadFinancials` row.
 *                  Every cent on the sample comes off that row: customer rate,
 *                  revenue, carrier rate, cost, profit, margin. Nothing is derived,
 *                  nothing is summed, nothing is converted.
 *
 *   LEGACY_LOAD  — a legacy own-fleet load (no TMS `status`) with no financials row,
 *                  a lane key on both ends, and a non-empty legacy `Load.rate`.
 *                  `Load.rate` is an `a.integer()` from the pre-TMS calendar whose
 *                  UNIT IS NOT DOCUMENTED, so this class is conditional: before a
 *                  single LEGACY_LOAD row is emitted the unit is proved against the
 *                  loads that carry BOTH a `rate` and a `LoadFinancials` row, by
 *                  comparing `rate` with `revenueCents` and with `revenueCents / 100`.
 *                  Ten agreeing comparables are the minimum. Fewer than ten, a
 *                  sample that matches both units, or a sample that disagrees with
 *                  itself, and the WHOLE CLASS is skipped and the reason printed.
 *                  A lane sample whose money had to be guessed is worse than no
 *                  sample: it quietly moves every future quote on that lane.
 *
 * A load whose lane key is null — no two-letter state on one end — is skipped and
 * counted, never averaged into a neighbouring lane. So is a load with no date to
 * put it on: "today" would move the row every time the migration re-ran.
 *
 * Idempotency is the row id. `lrs:<loadId>` means a re-run overwrites rather than
 * doubles, the planner compares what it would write against the sample already there
 * and emits nothing when they match, and apply puts each row under a condition that
 * refuses to overwrite a sample taken AFTER the plan was built — so a live
 * `source: 'LOAD'` sample written by the Lambda since planning wins over the
 * backfill, and replaying an applied plan is a counted no-op rather than a write.
 * A second dry run over an applied table produces zero actions.
 *
 * What it deliberately does NOT do:
 *
 *   - it deletes nothing and updates no Load, Order, Shipment, LoadCarrier or
 *     LoadFinancials row. It writes `LaneRateSample` rows and `AuditLog` lines;
 *   - it invents no money. A delivered load with no financials row is reported under
 *     `noFinancials`, not sampled from the legacy rate — that number was proved for
 *     own-fleet calendar loads, not for brokered legs priced in the TMS;
 *   - it writes no NULLs. A null attribute on `laneKey3` is a type mismatch against
 *     the laneKey3 index, so absent fields are left off the item entirely.
 *
 * Dry run is the default and writes NOTHING to AWS: it prints the counts per source
 * and per skip reason and writes a plan file when `--plan` is given. `--apply`
 * replays that reviewed plan after checking the source rows have not moved underneath
 * it.
 *
 * The guard that matters is the TABLE SUFFIX, not a flag a human types: this script
 * talks to DynamoDB directly, so the environment is read off the tables it was
 * pointed at and the production suffix is refused before a single read.
 *
 *   node scripts/backfillLaneSamples.mjs --help
 *   node scripts/backfillLaneSamples.mjs --plan plans/h-lane-samples.json
 *   node scripts/backfillLaneSamples.mjs --apply --plan plans/h-lane-samples.json
 */

import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { parseTmsArgs } from './lib/tmsConfig.mjs';
import { createPlan, loadPlan, savePlan, validatePlan, summarize } from './lib/tmsPlan.mjs';
import { getStops } from './lib/tmsStops.mjs';

export const REGION_DEFAULT = 'us-east-1';
/** The dev stack. Every write this script makes lands here unless --suffix says otherwise. */
export const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE';
/** Production. Present anywhere in a suffix, the run stops before a single read. */
export const PRODUCTION_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4';
/** Who the audit trail says did this. Not a person: a script, named so it can be found again. */
export const MIGRATION_USER = 'migration:backfillLaneSamples';

/** The live sample the Lambda writes. The backfill never overwrites one. */
export const LIVE_SOURCE = 'LOAD';
/** How many loads must carry both a legacy rate and financials before the unit is proved. */
export const LEGACY_UNIT_MINIMUM = 10;
/** Said once, in the plan and in the printout, whenever the legacy class is dropped. */
export const LEGACY_CLASS_SKIPPED = 'LEGACY_LOAD class skipped — Load.rate unit unproven';

/**
 * Mirrors MOVEMENT_RANK in src/lib/shipmentStatus.ts. DELIVERED is the bar: a load
 * still moving has no rate history to teach anyone.
 */
export const MOVEMENT_RANK = {
  CANCELED: -1,
  SOURCING: 0,
  BOOKED: 1,
  PLANNED: 1,
  DISPATCHED: 2,
  LOADING: 3,
  PICKED_UP: 3,
  IN_TRANSIT: 4,
  RECOVERED: 5,
  ARRIVED_AT_DELIVERY_TERMINAL: 6,
  OUT_FOR_DELIVERY: 7,
  UNLOADING: 8,
  DELIVERED: 9,
  INVOICING: 10,
};

/**
 * LaneRateSample is read as well as written: the planner compares what it would write
 * against what is already there, which is what makes the second dry run empty.
 */
const MODELS = ['Shipment', 'Order', 'Load', 'LoadCarrier', 'LoadFinancials', 'LaneRateSample'];

const USAGE = `
Usage: node scripts/backfillLaneSamples.mjs [options]

Options:
  --help, -h        Show this offline help.
  --suffix <s>      DynamoDB table suffix (default ${DEV_TABLE_SUFFIX});
                    the production suffix is refused.
  --region <r>      AWS region (default ${REGION_DEFAULT}).
  --plan <path>     (dry-run) write the plan file; (apply) read it back.
  --apply           Apply the reviewed plan.

BACKFILL:    a Load at DELIVERED or later with a LoadFinancials row. All money comes
             off that row and nowhere else.
LEGACY_LOAD: a legacy own-fleet Load (no TMS status) with no financials, a lane key,
             and a non-empty Load.rate — ONLY once Load.rate's unit has been proved
             against ${LEGACY_UNIT_MINIMUM}+ loads carrying both a rate and financials. Unproved,
             ambiguous or inconsistent, and the whole class is skipped.

Row id is lrs:<loadId>, so a re-run overwrites rather than doubles, and a sample taken
after this plan was built is never overwritten by it.

Nothing is deleted and no Load, Order, Shipment, LoadCarrier or LoadFinancials row is
touched: this writes LaneRateSample rows and AuditLog lines.

Dry run reads the tables, prints what it would write, and writes nothing to AWS.
Apply re-reads the same tables, refuses a plan whose sources have changed, and then
writes each row under a condition that makes a re-run free.
`;

/**
 * The environment is the tables, so the environment is checked on the tables.
 * @param {string | undefined} value
 * @returns {{suffix: string, environment: string}}
 */
export function resolveTarget(value) {
  const suffix = (value ?? process.env.TABLE_SUFFIX ?? DEV_TABLE_SUFFIX).trim();
  if (!suffix) throw new Error('--suffix <tableSuffix> cannot be empty');
  if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error(
      `Refusing to run against production tables (${suffix}): this backfill writes ` +
        'LaneRateSample rows that price every future quote, and Step H is a dev-only ' +
        `build. Point it at the dev suffix (${DEV_TABLE_SUFFIX}).`
    );
  }
  return { suffix, environment: suffix === DEV_TABLE_SUFFIX ? 'dev' : suffix };
}

/** @param {unknown} value @returns {string | null} */
function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** @param {unknown} value @returns {number | null} */
function cents(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

// ── Lane key ─────────────────────────────────────────────────────────────────
//
// A mirror of src/lib/laneKey.ts, because these scripts run under plain Node and
// cannot import TypeScript (the one script that does, backfillShipmentDocuments.mjs,
// is run through a loader). backfillLaneSamples.test.mjs pins every function below to
// the TypeScript originals over a table of cases, so the two cannot drift apart
// quietly: a key that changes there and not here would split one lane into two.

/** Upper case, punctuation to spaces, whitespace collapsed. `'St. Louis'` → `'ST LOUIS'`. */
function normalizeText(value) {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** A two-letter state, or null — a spelled-out state is not a key, it is a guess. */
function stateCode(value) {
  const t = normalizeText(value);
  return /^[A-Z]{2}$/.test(t) ? t : null;
}

/** "Chicago, IL" → { city: 'Chicago', state: 'IL' }; a bare city stays a city. */
function splitCityState(cityState) {
  const raw = (cityState ?? '').trim();
  if (!raw) return { city: null, state: null };
  const m = raw.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
  if (m) return { city: m[1].trim() || null, state: m[2].toUpperCase() };
  return { city: raw, state: null };
}

/** Where a stop is, as the lane key spells it: booked snapshot first, city string second. */
function placeOf(stop) {
  const parsed = splitCityState(stop.city);
  const city = normalizeText(stop.address?.city) || normalizeText(parsed.city);
  const state = stateCode(stop.address?.state) ?? stateCode(parsed.state);
  if (!city || !state) return null;
  return { city, state };
}

function stopKind(stop) {
  return String(stop.type ?? '').trim().toLowerCase();
}

/** The two ends of the route: first pickup, last delivery, in `sequence` order. */
export function endpointsOf(stops) {
  const list = (stops ?? []).filter((s) => s != null);
  if (list.length < 2) return null;
  const ordered = list
    .map((stop, index) => ({ stop, order: typeof stop.sequence === 'number' ? stop.sequence : index, index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((e) => e.stop);

  const pickup = ordered.find((s) => stopKind(s) === 'pickup') ?? ordered[0];
  let delivery = ordered[ordered.length - 1];
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (stopKind(ordered[i]) === 'delivery') { delivery = ordered[i]; break; }
  }
  if (pickup === delivery) return null;
  return { pickup, delivery };
}

/** `'CHICAGO|IL>DANVILLE|IL'`, or null when either end has no city and two-letter state. */
export function laneKeyFor(stops) {
  const ends = endpointsOf(stops);
  if (!ends) return null;
  const from = placeOf(ends.pickup);
  const to = placeOf(ends.delivery);
  if (!from || !to) return null;
  return `${from.city}|${from.state}>${to.city}|${to.state}`;
}

/** The first three digits of a five-digit ZIP; ZIP+4 is accepted, anything else is not. */
function zip3Of(stop) {
  const raw = (stop.address?.zip ?? '').trim();
  const match = raw.match(/^(\d{5})(?:-?\d{4})?$/);
  return match ? match[1].slice(0, 3) : null;
}

/** `'606>618'` from the two ends' ZIPs; null when either ZIP is missing or malformed. */
export function laneKey3For(stops) {
  const ends = endpointsOf(stops);
  if (!ends) return null;
  const from = zip3Of(ends.pickup);
  const to = zip3Of(ends.delivery);
  if (!from || !to) return null;
  return `${from}>${to}`;
}

/** `'2026-02-14T15:00:00.000Z'` → `'2026-02-14'`; anything unparseable → null. */
function dayOf(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

// ── The legacy rate's unit ───────────────────────────────────────────────────

/**
 * Is `Load.rate` dollars or cents? The field predates the TMS and nothing says. The
 * loads that carry BOTH a `rate` and a `LoadFinancials` row answer it: on those,
 * `revenueCents` is known-good cents, so `rate * 100 ≈ revenueCents` means dollars
 * and `rate ≈ revenueCents` means cents.
 *
 * A comparable votes for one unit only when it matches that unit and NOT the other —
 * a small load can match both (rate 1, revenue 100) and such a row proves nothing.
 * The verdict needs ten voters, no voter for the other unit, and at least four fifths
 * of the comparables voting: a pile of rows matching neither means `rate` is not the
 * revenue at all, which is exactly the case where converting it would be a guess.
 *
 * @param {Array<{loadId: string, rate: number, revenueCents: number}>} comparables
 * @param {{minimum?: number}} [opts]
 * @returns {{unit: 'dollars'|'cents'|null, comparables: number, dollars: number,
 *            cents: number, ambiguous: number, neither: number, reason: string}}
 */
export function proveLegacyRateUnit(comparables, { minimum = LEGACY_UNIT_MINIMUM } = {}) {
  let dollars = 0;
  let centsVotes = 0;
  let ambiguous = 0;
  let neither = 0;

  for (const row of comparables) {
    // One percent, or a dollar, whichever is larger: an accessorial rounded into the
    // invoice must not look like a different unit, and a different unit is never
    // within one percent of the right one.
    const tolerance = Math.max(100, Math.abs(row.revenueCents) * 0.01);
    const asDollars = Math.abs(row.rate * 100 - row.revenueCents) <= tolerance;
    const asCents = Math.abs(row.rate - row.revenueCents) <= tolerance;
    if (asDollars && asCents) ambiguous += 1;
    else if (asDollars) dollars += 1;
    else if (asCents) centsVotes += 1;
    else neither += 1;
  }

  const total = comparables.length;
  const base = { comparables: total, dollars, cents: centsVotes, ambiguous, neither };

  if (total < minimum) {
    return {
      ...base,
      unit: null,
      reason:
        `only ${total} load(s) carry both a legacy Load.rate and a LoadFinancials row, ` +
        `and ${minimum} are needed to prove the unit`,
    };
  }
  if (dollars > 0 && centsVotes > 0) {
    return {
      ...base,
      unit: null,
      reason:
        `${dollars} load(s) match whole dollars and ${centsVotes} match cents across ` +
        `${total} comparable load(s); the sample disagrees with itself`,
    };
  }

  const winner = dollars > 0 ? 'dollars' : centsVotes > 0 ? 'cents' : null;
  const votes = Math.max(dollars, centsVotes);
  if (!winner) {
    return {
      ...base,
      unit: null,
      reason:
        `none of the ${total} comparable load(s) decide the unit: ${ambiguous} match both ` +
        `dollars and cents and ${neither} match neither`,
    };
  }
  if (votes < minimum) {
    return {
      ...base,
      unit: null,
      reason:
        `only ${votes} of ${total} comparable load(s) decide for ${winner} ` +
        `(${ambiguous} match both units, ${neither} match neither), and ${minimum} are needed`,
    };
  }
  if (votes < total * 0.8) {
    return {
      ...base,
      unit: null,
      reason:
        `${votes} of ${total} comparable load(s) say ${winner} but ${ambiguous} match both ` +
        `units and ${neither} match neither; Load.rate is not reliably the revenue`,
    };
  }

  return {
    ...base,
    unit: winner,
    reason:
      `${votes} of ${total} comparable load(s) match ${winner} and none match the other unit`,
  };
}

/** The legacy rate as cents, once the unit is known. Never called before it is. */
export function legacyRateCents(rate, unit) {
  const value = cents(rate);
  if (value == null || value === 0) return null;
  if (unit === 'dollars') return value * 100;
  if (unit === 'cents') return value;
  return null;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

/** The fields that decide whether a stored sample still says what we would write. */
const MATERIAL_FIELDS = [
  'laneKey', 'laneKey3', 'date', 'loadId', 'shipmentId', 'shipmentNumber', 'orderId',
  'customerId', 'customerName', 'carrierId', 'carrierName', 'assignmentKind',
  'divisionKey', 'mode', 'rateType', 'equipmentType', 'miles', 'customerRateCents',
  'revenueCents', 'carrierRateCents', 'costCents', 'profitCents', 'marginBps',
  'loadStatus', 'excluded', 'source',
];

/**
 * The comparable shape of a sample: material fields only, absent and null the same
 * thing. `sampledAt` moves on every run and `version`/`createdAt`/`updatedAt` belong
 * to the row rather than to what it says, so none of them count as a difference —
 * otherwise every re-plan would rewrite all 890 rows.
 * @param {Record<string, unknown> | null | undefined} item
 * @returns {string}
 */
export function materialOf(item) {
  if (!item) return '';
  const out = {};
  for (const field of MATERIAL_FIELDS) {
    const value = item[field];
    out[field] = value === undefined ? null : value;
  }
  return JSON.stringify(out);
}

/** Drop absent fields: a NULL on laneKey3 is a type mismatch against the laneKey3 index. */
function compact(item) {
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/** The stops a load's lane is read off: the real array, else the legacy mirror fields. */
export function stopsOf(load) {
  return getStops(load);
}

/**
 * One load as the row the Historical Rates panel reads, or null when it is not one.
 * Money is passed in, never derived here: the caller decides whether it came off a
 * LoadFinancials row or off a legacy rate whose unit was proved.
 *
 * @param {object} input
 * @param {Record<string, any>} input.load
 * @param {any[]} input.stops
 * @param {Record<string, any> | null} input.financials
 * @param {Record<string, any> | null} input.order
 * @param {Record<string, any> | null} input.loadCarrier
 * @param {Record<string, any> | null} input.shipment
 * @param {string} input.laneKey
 * @param {string} input.date
 * @param {'BACKFILL'|'LEGACY_LOAD'} input.source
 * @param {number | null} [input.legacyCents]
 * @param {string} input.nowIso
 * @returns {Record<string, unknown>}
 */
export function sampleItemFor({
  load, stops, financials, order, loadCarrier, shipment, laneKey, date, source, legacyCents = null, nowIso,
}) {
  const rawStatus = text(load.status);
  const status = rawStatus && rawStatus in MOVEMENT_RANK ? rawStatus : null;
  const miles = cents(load.miles);
  const kind = loadCarrier?.kind;
  // A legacy own-fleet load was carried by our own truck — that is what "legacy
  // own-fleet" means — and the brokered legs all have a LoadCarrier row to read.
  const assignmentKind = kind === 'OWN_ASSET' || kind === 'CARRIER'
    ? kind
    : (source === 'LEGACY_LOAD' ? 'OWN_ASSET' : null);

  return compact({
    id: `lrs:${load.id}`,
    __typename: 'LaneRateSample',
    laneKey,
    laneKey3: laneKey3For(stops),
    date,
    loadId: String(load.id),
    shipmentId: text(load.shipmentId) ?? text(shipment?.id) ?? '',
    shipmentNumber: text(shipment?.number),
    orderId: text(load.orderId) ?? text(order?.id),
    customerId: text(order?.customerId) ?? text(shipment?.customerId) ?? text(load.customerId),
    customerName: text(order?.customerName) ?? text(shipment?.customerName) ?? text(load.customer),
    carrierId: text(loadCarrier?.carrierId),
    carrierName: text(loadCarrier?.carrierName) ?? text(load.carrierName),
    assignmentKind,
    divisionKey: text(load.divisionKey),
    mode: text(shipment?.mode) ?? text(order?.mode),
    rateType: text(order?.rateType),
    equipmentType: text(load.equipmentType) ?? text(order?.equipmentType),
    miles: miles != null && miles > 0 ? miles : null,
    // The legacy rate is what the load was booked and billed at, so it is both the
    // customer rate and the revenue; what it cost us to run our own truck is a
    // settlement, not a carrier rate, and is left absent rather than invented.
    customerRateCents: financials ? cents(financials.customerRateCents) : legacyCents,
    revenueCents: financials ? cents(financials.revenueCents) : legacyCents,
    carrierRateCents: financials ? cents(financials.carrierRateCents) : null,
    costCents: financials ? cents(financials.costCents) : null,
    profitCents: financials ? cents(financials.profitCents) : null,
    marginBps: financials ? cents(financials.marginBps) : null,
    loadStatus: status,
    excluded: shipment?.status === 'CANCELED' || loadCarrier?.status === 'TONU',
    source,
    sampledAt: nowIso,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

/**
 * Every load, classified once.
 *
 * @param {Record<string, any[]>} source
 * @param {string} nowIso
 * @returns {{
 *   actions: any[], alreadyCurrent: number, skipped: any[], reviewables: any[],
 *   bySource: Record<string, number>, byReason: Record<string, number>,
 *   legacyUnit: ReturnType<typeof proveLegacyRateUnit>, legacyCandidates: number
 * }}
 */
export function planLaneSamples(source, nowIso) {
  const loads = [...(source.Load ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const financialsByLoad = new Map();
  for (const row of source.LoadFinancials ?? []) {
    financialsByLoad.set(String(row.loadId ?? row.id), row);
  }
  const ordersById = new Map((source.Order ?? []).map((r) => [String(r.id), r]));
  const shipmentsById = new Map((source.Shipment ?? []).map((r) => [String(r.id), r]));
  const samplesById = new Map((source.LaneRateSample ?? []).map((r) => [String(r.id), r]));

  const carriersById = new Map();
  const carriersByLoad = new Map();
  for (const row of [...(source.LoadCarrier ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    carriersById.set(String(row.id), row);
    const key = text(row.loadId);
    if (!key) continue;
    if (!carriersByLoad.has(key)) carriersByLoad.set(key, []);
    carriersByLoad.get(key).push(row);
  }

  // Pass 0: prove the legacy rate's unit before anything decides to use it.
  const comparables = [];
  for (const load of loads) {
    const rate = cents(load.rate);
    const financials = financialsByLoad.get(String(load.id));
    const revenueCents = financials ? cents(financials.revenueCents) : null;
    if (rate == null || rate === 0 || revenueCents == null || revenueCents === 0) continue;
    comparables.push({ loadId: String(load.id), rate, revenueCents });
  }
  const legacyUnit = proveLegacyRateUnit(comparables);

  const actions = [];
  const skipped = [];
  const reviewables = [];
  const bySource = { BACKFILL: 0, LEGACY_LOAD: 0 };
  const byReason = {};
  let alreadyCurrent = 0;
  let legacyCandidates = 0;

  const today = dayOf(nowIso) ?? nowIso.slice(0, 10);

  const skip = (load, reason, detail) => {
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    skipped.push({ loadId: String(load.id), loadNumber: text(load.loadNumber), reason, ...(detail ?? {}) });
  };

  for (const load of loads) {
    const loadId = String(load.id);
    const financials = financialsByLoad.get(loadId) ?? null;
    const rawStatus = text(load.status);
    const status = rawStatus && rawStatus in MOVEMENT_RANK ? rawStatus : null;
    const rank = status ? MOVEMENT_RANK[status] : (text(load.deliveredAt) ? MOVEMENT_RANK.DELIVERED : -1);

    /** @type {'BACKFILL'|'LEGACY_LOAD'|null} */
    let sampleSource = null;
    if (financials) {
      if (rank < MOVEMENT_RANK.DELIVERED) { skip(load, 'belowDelivered', { status: rawStatus }); continue; }
      sampleSource = 'BACKFILL';
    } else if (!rawStatus) {
      // A legacy own-fleet row: no TMS status was ever written on it.
      if (cents(load.rate) == null || cents(load.rate) === 0) { skip(load, 'noLegacyRate'); continue; }
      legacyCandidates += 1;
      if (!legacyUnit.unit) {
        skip(load, 'legacyRateUnitUnproven', { rate: cents(load.rate) });
        continue;
      }
      sampleSource = 'LEGACY_LOAD';
    } else if (rank < MOVEMENT_RANK.DELIVERED) {
      skip(load, 'belowDelivered', { status: rawStatus });
      continue;
    } else {
      // Delivered inside the TMS and never priced. The legacy rate was proved for
      // own-fleet calendar loads, not for this, so nothing is sampled from it.
      skip(load, 'noFinancials', { status: rawStatus });
      continue;
    }

    const stops = stopsOf(load);
    const laneKey = laneKeyFor(stops);
    if (!laneKey) { skip(load, 'noLaneKey'); continue; }

    const ends = endpointsOf(stops);
    const date = dayOf(ends?.delivery?.appt) ?? dayOf(load.deliveredAt);
    if (!date) { skip(load, 'noDate'); continue; }
    if (sampleSource === 'LEGACY_LOAD' && date > today) {
      // A legacy row has no workflow status, so the delivery date is the only thing
      // that says whether the load has run. A future one has not.
      skip(load, 'belowDelivered', { date });
      continue;
    }

    const legs = carriersByLoad.get(loadId) ?? [];
    const loadCarrier =
      carriersById.get(text(load.activeLoadCarrierId) ?? '') ??
      legs.find((r) => text(r.status) === 'ACTIVE') ??
      legs[0] ??
      null;
    const shipment = shipmentsById.get(text(load.shipmentId) ?? '') ?? null;
    const order = ordersById.get(text(load.orderId) ?? '') ?? null;

    const item = sampleItemFor({
      load,
      stops,
      financials,
      order,
      loadCarrier,
      shipment,
      laneKey,
      date,
      source: sampleSource,
      legacyCents: sampleSource === 'LEGACY_LOAD' ? legacyRateCents(load.rate, legacyUnit.unit) : null,
      nowIso,
    });

    const existing = samplesById.get(item.id) ?? null;
    if (existing && materialOf(existing) === materialOf(item)) {
      alreadyCurrent += 1;
      continue;
    }
    if (existing && text(existing.source) === LIVE_SOURCE) {
      // The Lambda has already sampled this load from the live row. Its numbers are
      // the current ones; a migration must not talk over them.
      reviewables.push({
        kind: 'LIVE_SAMPLE_DIFFERS',
        reason:
          `LaneRateSample ${item.id} was written by the live load (source ${LIVE_SOURCE}) and says ` +
          `something different from this backfill; left exactly as it is`,
        source: { loadId, laneKey: text(existing.laneKey), revenueCents: cents(existing.revenueCents) },
      });
      skip(load, 'liveSampleWins');
      continue;
    }

    bySource[sampleSource] += 1;
    actions.push({
      action: 'PUT_LANE_SAMPLE',
      purpose: 'One delivered load as a lane rate sample, for the Historical Rates panel',
      id: item.id,
      loadId,
      laneKey,
      source: sampleSource,
      item,
      before: existing ? { source: text(existing.source), revenueCents: cents(existing.revenueCents) } : null,
    });
  }

  return { actions, alreadyCurrent, skipped, reviewables, bySource, byReason, legacyUnit, legacyCandidates };
}

/**
 * Exactly the fields the pass reads, per row. Fingerprinting `updatedAt` on every load
 * would invalidate the plan the moment a dispatcher saved an ETA; fingerprinting what is
 * actually read invalidates it when, and only when, it has stopped being true.
 * @param {Record<string, any[] | null>} source
 * @returns {Array<Record<string, unknown>>}
 */
export function sourceRowsOf(source) {
  const FIELDS = {
    Load: [
      'status', 'deliveredAt', 'stops', 'miles', 'rate', 'shipmentId', 'orderId',
      'customer', 'customerId', 'carrierName', 'divisionKey', 'equipmentType',
      'activeLoadCarrierId', 'loadNumber', 'originName', 'originCity', 'destinationName',
      'destinationCity', 'pickupAppt', 'pickupApptType', 'deliveryAppt', 'deliveryApptType',
    ],
    LoadFinancials: [
      'loadId', 'customerRateCents', 'revenueCents', 'carrierRateCents', 'costCents',
      'profitCents', 'marginBps',
    ],
    LoadCarrier: ['loadId', 'kind', 'status', 'carrierId', 'carrierName'],
    Order: ['customerId', 'customerName', 'mode', 'rateType', 'equipmentType'],
    Shipment: ['number', 'customerId', 'customerName', 'mode', 'status'],
    LaneRateSample: MATERIAL_FIELDS,
  };
  const rows = [];
  for (const [model, fields] of Object.entries(FIELDS)) {
    for (const row of source[model] ?? []) {
      const entry = { model, id: String(row.id) };
      for (const field of fields) entry[field] = row[field] ?? null;
      rows.push(entry);
    }
  }
  return rows;
}

/**
 * @param {object} input
 * @param {Record<string, any[]>} input.source
 * @param {string} input.environment
 * @param {string} input.suffix
 * @param {string} [input.nowIso]
 */
export function buildLaneSamplePlan({ source, environment, suffix, nowIso = new Date().toISOString() }) {
  const loads = source.Load ?? [];
  const planned = planLaneSamples(source, nowIso);

  return createPlan({
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceType: 'LaneRateSample rows for delivered loads (financials) and legacy own-fleet loads',
    sourceRows: sourceRowsOf(source),
    actions: planned.actions,
    reviewables: planned.reviewables,
    unresolved: planned.skipped,
    summary: {
      loads: loads.length,
      existingSamples: (source.LaneRateSample ?? []).length,
      toWrite: planned.actions.length,
      alreadyCurrent: planned.alreadyCurrent,
      bySource: planned.bySource,
      skippedByReason: planned.byReason,
      legacyRate: {
        unit: planned.legacyUnit.unit,
        classSkipped: planned.legacyUnit.unit == null,
        candidates: planned.legacyCandidates,
        comparables: planned.legacyUnit.comparables,
        matchingDollars: planned.legacyUnit.dollars,
        matchingCents: planned.legacyUnit.cents,
        matchingBoth: planned.legacyUnit.ambiguous,
        matchingNeither: planned.legacyUnit.neither,
        minimumComparables: LEGACY_UNIT_MINIMUM,
        reason: planned.legacyUnit.reason,
        message: planned.legacyUnit.unit == null
          ? `${LEGACY_CLASS_SKIPPED}: ${planned.legacyUnit.reason}.`
          : null,
      },
      rowsDeleted: 0,
    },
  });
}

/**
 * The review printout: what a person needs to decide whether to apply this.
 * @param {import('./lib/tmsPlan.mjs').TmsPlan} plan
 * @returns {string}
 */
export function reviewText(plan) {
  const s = plan.summary;
  const lines = [
    summarize(plan),
    '',
    `Loads read:                    ${s.loads}`,
    `LaneRateSample rows present:   ${s.existingSamples}`,
    `Samples to write:              ${s.toWrite}`,
    `Already current:               ${s.alreadyCurrent}`,
    '',
    'Samples by source:',
  ];
  const sources = Object.entries(s.bySource).sort(([a], [b]) => a.localeCompare(b));
  if (sources.length === 0) lines.push('    (none)');
  for (const [name, count] of sources) lines.push(`    ${name}: ${count}`);

  lines.push('', 'Loads not sampled, by reason:');
  const reasons = Object.entries(s.skippedByReason).sort(([a], [b]) => a.localeCompare(b));
  if (reasons.length === 0) lines.push('    (none)');
  for (const [reason, count] of reasons) lines.push(`    ${reason}: ${count}`);

  const legacy = s.legacyRate;
  lines.push(
    '',
    `Legacy Load.rate unit: ${legacy.unit ?? 'UNPROVEN'}`,
    `  comparable loads (rate + financials): ${legacy.comparables} (need ${legacy.minimumComparables})`,
    `  match whole dollars:                  ${legacy.matchingDollars}`,
    `  match cents:                          ${legacy.matchingCents}`,
    `  match both units:                     ${legacy.matchingBoth}`,
    `  match neither:                        ${legacy.matchingNeither}`
  );
  if (legacy.classSkipped) {
    lines.push(
      legacy.message,
      `  ${legacy.candidates} legacy load(s) carry a rate and were NOT sampled. A lane sample whose`,
      '  money had to be guessed moves every future quote on that lane, so none is written.'
    );
  } else {
    lines.push(
      `  proved: ${legacy.reason}`,
      `  legacy loads sampled from Load.rate: ${s.bySource.LEGACY_LOAD ?? 0}`
    );
  }

  lines.push(
    '',
    'Money on a BACKFILL sample comes off the LoadFinancials row and nowhere else.',
    'Nothing is deleted and no Load, Order, Shipment, LoadCarrier or LoadFinancials row is touched.'
  );

  if (plan.reviewables.length > 0) {
    lines.push('', 'Samples that need a person — NOT changed:');
    for (const r of plan.reviewables) lines.push(`  ${r.kind}: ${r.reason}`);
  }

  return lines.join('\n');
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * @param {any} doc
 * @param {string} tableName
 * @returns {Promise<any[]>}
 */
async function scanAll(doc, tableName) {
  const items = [];
  let startKey;
  do {
    try {
      const page = await doc.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }));
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } catch (err) {
      if (err?.name === 'ResourceNotFoundException') {
        throw new Error(`Table ${tableName} does not exist — has the schema been deployed to this stack?`);
      }
      throw err;
    }
  } while (startKey);
  return items;
}

/**
 * @param {any} doc
 * @param {string} suffix
 * @returns {Promise<Record<string, any[]>>}
 */
export async function readSource(doc, suffix) {
  const entries = await Promise.all(
    MODELS.map(async (model) => [model, await scanAll(doc, `${model}-${suffix}`)])
  );
  return Object.fromEntries(entries);
}

// ── Apply ────────────────────────────────────────────────────────────────────

/**
 * One audit row per write, the same way the Lambdas do it. Best effort: a sample must
 * not be reported as failed because the history table refused a line.
 * @param {any} doc
 * @param {string} table
 * @param {string} entityId
 * @param {string} action
 * @param {Record<string, unknown>} changes
 */
async function writeAudit(doc, table, entityId, action, changes) {
  const now = new Date().toISOString();
  try {
    await doc.send(new PutCommand({
      TableName: table,
      Item: {
        id: randomUUID(),
        __typename: 'AuditLog',
        entityType: 'LaneRateSample',
        entityId,
        action,
        user: MIGRATION_USER,
        changes: JSON.stringify(changes),
        createdAt: now,
        updatedAt: now,
      },
    }));
  } catch (err) {
    console.warn(`audit log write failed for LaneRateSample ${entityId}: ${err.message}`);
  }
}

/**
 * @param {object} input
 * @param {any} input.doc
 * @param {import('./lib/tmsPlan.mjs').TmsPlan} input.plan
 * @param {string} input.suffix
 */
export async function applyLaneSamplePlan({ doc, plan, suffix }) {
  // The suffix was checked before the read; it is checked again here because this is
  // the function that writes, and it is exported for tests and for other callers.
  if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error(`Refusing to write LaneRateSample rows to production tables (${suffix})`);
  }
  const sampleTable = `LaneRateSample-${suffix}`;
  const auditTable = `AuditLog-${suffix}`;
  const report = {
    written: 0,
    alreadyCurrent: 0,
    bySource: { BACKFILL: 0, LEGACY_LOAD: 0 },
    failures: [],
  };

  for (const entry of plan.actions) {
    try {
      if (entry.action !== 'PUT_LANE_SAMPLE') throw new Error(`Unknown action ${entry.action}`);
      try {
        await doc.send(new PutCommand({
          TableName: sampleTable,
          Item: entry.item,
          // New row, or one this plan is newer than. A live `LOAD` sample is never
          // overwritten, and replaying an applied plan hits `sampledAt = :sampledAt`,
          // fails the condition, and costs one read instead of 890 writes.
          ConditionExpression: 'attribute_not_exists(id) OR (#source <> :live AND sampledAt < :sampledAt)',
          ExpressionAttributeNames: { '#source': 'source' },
          ExpressionAttributeValues: { ':live': LIVE_SOURCE, ':sampledAt': entry.item.sampledAt },
        }));
        report.written += 1;
        report.bySource[entry.source] = (report.bySource[entry.source] ?? 0) + 1;
        await writeAudit(doc, auditTable, entry.id, 'BACKFILL_LANE_SAMPLE', {
          source: entry.source,
          laneKey: entry.laneKey,
          loadId: entry.loadId,
          before: entry.before,
          after: {
            revenueCents: entry.item.revenueCents ?? null,
            customerRateCents: entry.item.customerRateCents ?? null,
            date: entry.item.date,
          },
        });
      } catch (err) {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
        // Written by an earlier run of this plan, or sampled live since it was built.
        report.alreadyCurrent += 1;
      }
    } catch (err) {
      report.failures.push({ action: entry.action, id: entry.id, error: err.message });
    }
  }

  return report;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseTmsArgs({ suffix: { type: 'string' }, region: { type: 'string' } });
  if (args.values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const { suffix, environment } = resolveTarget(args.values.suffix);
  const region = args.values.region ?? REGION_DEFAULT;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const source = await readSource(doc, suffix);

  if (!args.values.apply) {
    const plan = buildLaneSamplePlan({ source, environment, suffix });
    console.log(reviewText(plan));
    if (args.values.plan) {
      const planPath = resolve(process.cwd(), args.values.plan);
      savePlan(plan, planPath);
      console.log(`\nPlan written to ${args.values.plan} — review it, then re-run with --apply --plan ${args.values.plan}`);
    } else {
      console.log('\nDry run: nothing was written. Pass --plan <path> to save this plan, then --apply it.');
    }
    process.exit(0);
  }

  if (!args.values.plan) {
    throw new Error('--plan <path> is required when applying: apply replays a plan a person has read');
  }
  const plan = loadPlan(resolve(process.cwd(), args.values.plan));
  validatePlan(plan, {
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceRows: sourceRowsOf(source),
  });

  const report = await applyLaneSamplePlan({ doc, plan, suffix });
  console.log(JSON.stringify({ environment, suffix, ...report }, null, 2));
  if (report.failures.length > 0) process.exit(2);
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
