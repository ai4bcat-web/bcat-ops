#!/usr/bin/env node
/**
 * Backfill the revenue taxonomy (Step R).
 *
 * Step R makes every shipment carry the business that earns it (`revDivision`), the
 * subsidiary inside it (`revSubdivision`), the rep who sold it (`salesRepId`) and —
 * for the rows that were soft-deleted before Void existed — an honest void. The
 * sidebar sections, the Shipments views and the whole Brokerage dashboard group by
 * those four fields, so a shipment without them is invisible to every chart.
 *
 * Six passes, in this order, because each one depends on the last:
 *
 *   1. SEED      — `ENSURE_OWNERSHIP_SEED` through `tmsDirectoryActions`. Idempotent:
 *                  it writes only the division, rule and view rows that do not exist,
 *                  and never touches one an admin has edited or archived.
 *   2. RETAG     — `RETAG_SHIPMENTS` through `tmsShipmentActions`. The Lambda owns the
 *                  resolution (it reads the division tree, the ordered rules, each
 *                  shipment's order, load, active leg and driver); this script asks it
 *                  to plan (`dryRun`) and then to apply, and prints what it reports.
 *                  A shipment tagged BY HAND is never re-tagged, and neither is a
 *                  voided one.
 *   3. SALES REP — every Shipment with no `salesRepId` takes its order's
 *                  `customerRepId`. Legacy orders name the rep by E-MAIL; the staff
 *                  pool keys people by their Cognito username, so an e-mail is
 *                  resolved through the `UserProfile` row that carries it. A value
 *                  that matches no profile is REPORTED, never guessed — a wrong rep
 *                  on a shipment is a wrong commission.
 *   4. VOIDS     — a Shipment with `deletedAt` and no `voidedAt` is a soft delete from
 *                  before the PRO rule. It becomes a void that says so, written
 *                  straight to DynamoDB under `attribute_not_exists(voidedAt)` so a
 *                  re-run cannot overwrite a real void somebody has since recorded.
 *                  A void is not three columns: `applyVoid` in the shipment router
 *                  also takes our fleet off the mirrored loads, because the calendar,
 *                  dispatch, settlements and the driver app key on `stops[].driverId`
 *                  and the `pickupDriverId`/`deliveryDriverId`/`truckId` mirrors and
 *                  never read `Load.status`. So every mirrored load that still carries
 *                  a driver mark, or is still flagged `readyToInvoice`, is cleared and
 *                  canceled in the same apply step and PRINTED IN THE PLAN REVIEW, so
 *                  a person sees which drivers' calendars and settlements move.
 *                  Nothing is deleted and no PRO is released.
 *   5. MIRROR    — the void, written onto the loads that mirror it. Void lives on the
 *                  Shipment, but the calendar, dispatch, the appointment queue, the
 *                  schedule, the settlements and the pay hooks read the Load table and
 *                  never join a shipment, which is how voided freight kept turning up
 *                  in the calendar's Unscheduled strip. Every load of a voided shipment
 *                  takes that shipment's `voidedAt`, under `attribute_not_exists` so a
 *                  void the router wrote is never overwritten. Nothing else moves.
 *   6. REPORT    — the resulting counts per division and per subdivision over EVERY
 *                  shipment, and the loads that carry no shipment at all. Those loads
 *                  are reported, never invented: a load with no customer match was
 *                  left unlinked by the Step B backfill on purpose.
 *
 * Dry run is the default and writes NOTHING: it asks the two Lambdas to plan, works
 * out the rep and void writes from the tables, prints all of it and saves a plan file
 * when `--plan` is given. `--apply` replays that reviewed plan after checking the rows
 * it was computed from have not moved underneath it (the same fingerprint every other
 * TMS migration uses). A second plan after an applied one reports zero changes.
 *
 * Two guards, because this script talks to two things. The TABLE SUFFIX is checked
 * before a single read — the production suffix is refused outright — and the
 * `--outputs` file may not be the repo-root (production) `amplify_outputs.json`. The
 * identity it signs in with (`BCAT_EMAIL` / `BCAT_PASSWORD`, the same helper every TMS
 * migration uses) must be the owner or an ADMIN: both Lambda actions refuse anybody
 * else, and that refusal is the point.
 *
 *   node scripts/backfillRevDivision.mjs --help
 *   node scripts/backfillRevDivision.mjs --outputs dev_outputs.json --plan plans/r-rev-division.json
 *   node scripts/backfillRevDivision.mjs --outputs dev_outputs.json --apply --plan plans/r-rev-division.json
 */

import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createTmsClient } from './lib/tmsClient.mjs';
import { authenticateTmsUser } from './lib/tmsAuth.mjs';
import { parseTmsArgs, loadAmplifyOutputs } from './lib/tmsConfig.mjs';
import { createPlan, loadPlan, savePlan, validatePlan, summarize } from './lib/tmsPlan.mjs';

export const REGION_DEFAULT = 'us-east-1';
/** The dev stack. Every write this script makes lands here unless --suffix says otherwise. */
export const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE';
/** Production. Present anywhere in a suffix, the run stops before a single read. */
export const PRODUCTION_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4';
/** Who the audit trail says did this. Not a person: a script, named so it can be found again. */
export const MIGRATION_USER = 'migration:backfillRevDivision';
/** What a legacy soft delete becomes. Said once, so every migrated row reads the same. */
export const LEGACY_VOID_REASON = 'Legacy soft delete (pre Step R)';

/** Read directly; the three Lambda actions do every write but the legacy voids. */
const MODELS = ['Shipment', 'Order', 'Load', 'UserProfile', 'OwnershipDivision', 'OwnershipRule', 'ShipmentView'];

const USAGE = `
Usage: node scripts/backfillRevDivision.mjs [options]

Options:
  --help, -h        Show this offline help.
  --outputs <path>  Required: amplify_outputs.json for the DEV stack (the repo-root
                    production file is refused). Sign-in uses BCAT_EMAIL / BCAT_PASSWORD
                    and that identity must be the owner or an ADMIN.
  --suffix <s>      DynamoDB table suffix (default ${DEV_TABLE_SUFFIX});
                    the production suffix is refused.
  --region <r>      AWS region (default ${REGION_DEFAULT}).
  --plan <path>     (dry-run) write the plan file; (apply) read it back.
  --apply           Apply the reviewed plan.

SEED:      ENSURE_OWNERSHIP_SEED (tmsDirectoryActions) writes the division, rule and
           view rows that are missing, and only those.
RETAG:     RETAG_SHIPMENTS (tmsShipmentActions) re-resolves every shipment that is not
           hand-tagged and not voided, and reports changed / byDivision / bySubdivision
           / handTagged.
SALES REP: a Shipment with no salesRepId takes its order's customerRepId; an e-mail is
           resolved to the UserProfile that carries it. Unresolved values are listed and
           left alone.
VOIDS:     a Shipment with deletedAt and no voidedAt becomes a void that says
           "${LEGACY_VOID_REASON}", and every mirrored Load that still carries a
           driver mark (stops, pickup/delivery driver, truck) or readyToInvoice is
           cleared and CANCELED with it, exactly as the shipment router's own void
           does. Each such load is named in the plan review. Nothing is deleted; no
           PRO is released.
MIRROR:    every Load whose Shipment is voided takes that shipment's voidedAt. The
           calendar, dispatch, the appointment queue, the schedule and the driver-pay
           hooks read the Load table and never join a shipment, so this is the field
           that takes voided freight out of them. A load that already carries a void
           is left alone, and the Voided tab and the shipment's History still read it.

Dry run reads the tables, asks both Lambdas to plan, prints everything and writes
nothing to AWS. Apply re-reads the same tables, refuses a plan whose sources have
changed, and then replays it. A second plan reports zero changes.
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
      `Refusing to run against production tables (${suffix}): this backfill re-tags every ` +
        'shipment and voids legacy soft deletes, and Step R is a dev-only build. Point it ' +
        `at the dev suffix (${DEV_TABLE_SUFFIX}).`
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

const isEmail = (value) => typeof value === 'string' && value.includes('@');

// ── Sales rep ────────────────────────────────────────────────────────────────

/**
 * Which shipments need a rep, and who it is.
 *
 * The rep lives on the ORDER (`customerRepId`) and the board reads it off the
 * SHIPMENT, so the two have to agree. Legacy orders name a person by e-mail; the
 * staff pool keys people by their Cognito username (`UserProfile.id`), which is what
 * every rep filter, the commission ladder and the dashboard's rep cards compare
 * against. An e-mail with no profile is left unresolved and listed by value, because
 * a guessed rep is a wrong commission.
 *
 * @param {object} input
 * @param {Array<Record<string, any>>} input.shipments
 * @param {Array<Record<string, any>>} input.orders
 * @param {Array<Record<string, any>>} input.profiles
 * @returns {{actions: any[], unresolved: any[], byValue: Record<string, number>, alreadySet: number, noRepOnOrder: number}}
 */
export function planSalesReps({ shipments, orders, profiles }) {
  const ordersByShipment = new Map();
  for (const order of orders ?? []) {
    const key = text(order.shipmentId);
    if (!key || ordersByShipment.has(key)) continue;
    ordersByShipment.set(key, order);
  }
  const profileByEmail = new Map();
  for (const profile of profiles ?? []) {
    const email = text(profile.email);
    if (!email) continue;
    profileByEmail.set(email.toLowerCase(), profile);
  }
  const profileIds = new Set((profiles ?? []).map((p) => String(p.id)));

  const actions = [];
  const unresolved = [];
  const byValue = {};
  let alreadySet = 0;
  let noRepOnOrder = 0;
  let leavingTheBoard = 0;

  for (const shipment of [...(shipments ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (text(shipment.voidedAt) || text(shipment.deletedAt)) {
      // A voided shipment refuses every write, and a legacy soft delete is about to
      // become one. Neither earns anybody a commission, so neither is given a rep.
      leavingTheBoard += 1;
      continue;
    }
    if (text(shipment.salesRepId)) {
      alreadySet += 1;
      continue;
    }
    const order = ordersByShipment.get(String(shipment.id)) ?? null;
    const raw = text(order?.customerRepId);
    if (!raw) {
      noRepOnOrder += 1;
      continue;
    }

    let repId = null;
    if (isEmail(raw)) {
      const profile = profileByEmail.get(raw.toLowerCase()) ?? null;
      repId = profile ? String(profile.id) : null;
    } else if (profileIds.has(raw)) {
      // Already a username: the profile pool is the authority on which ids exist.
      repId = raw;
    }

    if (!repId) {
      byValue[raw] = (byValue[raw] ?? 0) + 1;
      unresolved.push({
        shipmentId: String(shipment.id),
        shipmentNumber: text(shipment.number),
        reason: isEmail(raw) ? 'NO_PROFILE_FOR_EMAIL' : 'NOT_A_KNOWN_USERNAME',
        value: raw,
      });
      continue;
    }

    actions.push({
      action: 'SET_SALES_REP',
      purpose: "The rep already on the order, onto the shipment and its mirrored load",
      shipmentId: String(shipment.id),
      shipmentNumber: text(shipment.number),
      orderId: String(order.id),
      from: raw,
      repId,
    });
  }

  return { actions, unresolved, byValue, alreadySet, noRepOnOrder, leavingTheBoard };
}

// ── Legacy soft deletes ──────────────────────────────────────────────────────

/**
 * A Load's stops as an array, or null when the row has none of its own. AWSJSON
 * arrives as a string; a legacy load with no `stops` keeps its two mirror fields and
 * nothing is synthesised for it, because writing a synthesised array back would
 * invent stops this migration never read.
 * @param {Record<string, any>} load
 * @returns {any[] | null}
 */
function stopsOf(load) {
  let stops = load.stops;
  for (let i = 0; i < 4 && typeof stops === 'string'; i += 1) {
    try { stops = JSON.parse(stops); } catch { return null; }
  }
  return Array.isArray(stops) && stops.length > 0 ? stops : null;
}

/**
 * What a void has to take off a load. The calendar, dispatch, box-truck and
 * owner-operator pay, employee stats and the driver schedule never read
 * `Load.status`: they key on these. A voided shipment that kept them would still pay
 * a driver for freight that never ran.
 * @param {Record<string, any>} load
 * @returns {string[]} the marks found, named for the plan review
 */
export function driverMarksOf(load) {
  const marks = [];
  if (text(load.pickupDriverId)) marks.push('pickupDriverId');
  if (text(load.deliveryDriverId)) marks.push('deliveryDriverId');
  if (text(load.truckId)) marks.push('truckId');
  (stopsOf(load) ?? []).forEach((stop, i) => {
    if (text(stop?.driverId)) marks.push(`stops[${i}].driverId`);
    if (text(stop?.truckId)) marks.push(`stops[${i}].truckId`);
  });
  return marks;
}

/**
 * Every shipment that was soft-deleted before Void existed, as the void it should
 * have been — and the mirrored loads that void has to clear. The PRO stays, the
 * history stays, the documents stay.
 *
 * A load is listed only when there is something to take off it: a driver mark, or a
 * `readyToInvoice` flag on freight nobody ran. `stops` is rewritten exactly the way
 * `clearedStops` does in `src/lib/loadMirror.ts` — the driver and truck off each
 * stop, every appointment, address, reference and arrival time left alone.
 *
 * @param {Array<Record<string, any>>} shipments
 * @param {Array<Record<string, any>>} [loads] every Load, to find the mirrors by shipmentId
 * @returns {any[]}
 */
export function planLegacyVoids(shipments, loads = []) {
  const loadsByShipment = new Map();
  for (const load of [...(loads ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const key = text(load.shipmentId);
    if (!key) continue;
    if (!loadsByShipment.has(key)) loadsByShipment.set(key, []);
    loadsByShipment.get(key).push(load);
  }

  const actions = [];
  for (const shipment of [...(shipments ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const deletedAt = text(shipment.deletedAt);
    if (!deletedAt || text(shipment.voidedAt)) continue;

    const mirrored = [];
    for (const load of loadsByShipment.get(String(shipment.id)) ?? []) {
      const driverMarks = driverMarksOf(load);
      const readyToInvoice = load.readyToInvoice === true;
      if (driverMarks.length === 0 && !readyToInvoice) continue;
      const stops = stopsOf(load);
      mirrored.push({
        loadId: String(load.id),
        loadNumber: text(load.loadNumber),
        status: text(load.status),
        driverMarks,
        readyToInvoice,
        // Null when the load has no stops array of its own: the two mirror columns
        // below carry its drivers and they are cleared by name.
        stops: stops ? stops.map(({ truckId: _truckId, ...rest }) => ({ ...rest, driverId: null })) : null,
        // The router cancels a load that is not canceled already and leaves one that is.
        canceling: text(load.status) !== 'CANCELED',
      });
    }

    actions.push({
      action: 'VOID_LEGACY_SOFT_DELETE',
      purpose: 'A pre-Step-R soft delete, recorded as the void it always was',
      shipmentId: String(shipment.id),
      shipmentNumber: text(shipment.number),
      voidedAt: deletedAt,
      voidedBy: text(shipment.deletedBy) ?? MIGRATION_USER,
      voidReason: LEGACY_VOID_REASON,
      version: typeof shipment.version === 'number' ? shipment.version : 0,
      loads: mirrored,
    });
  }
  return actions;
}

/**
 * The void, written onto the loads that mirror it.
 *
 * Void lives on the Shipment, but the calendar, dispatch, the appointment queue, the
 * schedule, the settlements and the pay hooks all read the Load table and never join
 * a shipment — which is why voided freight kept turning up in the calendar's
 * Unscheduled strip. Step R mirrors `voidedAt` onto the load so one field takes it
 * out of every working set at once. The row, the PRO, the legs and the history all
 * stay: the Shipments board's Voided tab and the shipment's History tab still read
 * them.
 *
 * The time written is the shipment's own: `voidedAt` when it has one, otherwise the
 * `deletedAt` the legacy-void pass above is about to promote, so both passes in one
 * run agree to the millisecond. A load that already carries a void is left alone.
 *
 * @param {Array<Record<string, any>>} shipments
 * @param {Array<Record<string, any>>} [loads]
 * @returns {any[]}
 */
export function planVoidMirror(shipments, loads = []) {
  const voidedAtByShipment = new Map();
  const numberByShipment = new Map();
  for (const shipment of shipments ?? []) {
    const at = text(shipment.voidedAt) ?? text(shipment.deletedAt);
    if (!at) continue;
    voidedAtByShipment.set(String(shipment.id), at);
    numberByShipment.set(String(shipment.id), text(shipment.number));
  }

  const actions = [];
  for (const load of [...(loads ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const shipmentId = text(load.shipmentId);
    if (!shipmentId) continue;
    const voidedAt = voidedAtByShipment.get(shipmentId);
    if (!voidedAt) continue;
    if (text(load.voidedAt)) continue;
    actions.push({
      action: 'MIRROR_VOID_ON_LOAD',
      purpose: 'The shipment is voided; its load leaves the calendar, dispatch and the pay hooks',
      shipmentId,
      shipmentNumber: numberByShipment.get(shipmentId) ?? null,
      loadId: String(load.id),
      loadNumber: text(load.loadNumber),
      status: text(load.status),
      voidedAt,
    });
  }
  return actions;
}

// ── The report ───────────────────────────────────────────────────────────────

/**
 * The tags as they stand, over every shipment. Voided rows are counted separately:
 * they are not working freight and no dashboard counts them.
 * @param {Array<Record<string, any>>} shipments
 */
export function countTags(shipments) {
  const byDivision = {};
  const bySubdivision = {};
  let untagged = 0;
  let voided = 0;
  let handTagged = 0;

  for (const shipment of shipments ?? []) {
    if (text(shipment.voidedAt)) {
      voided += 1;
      continue;
    }
    if (text(shipment.revTagSource) === 'HAND') handTagged += 1;
    const division = text(shipment.revDivision);
    if (!division) {
      untagged += 1;
      continue;
    }
    byDivision[division] = (byDivision[division] ?? 0) + 1;
    const subdivision = text(shipment.revSubdivision);
    if (subdivision) bySubdivision[subdivision] = (bySubdivision[subdivision] ?? 0) + 1;
  }

  return { byDivision, bySubdivision, untagged, voided, handTagged };
}

/**
 * Loads the Step B backfill could not turn into shipments. Reported with whatever
 * customer text they carry so a person can decide; nothing is created for them.
 * @param {Array<Record<string, any>>} loads
 */
export function loadsWithoutShipment(loads) {
  return (loads ?? [])
    .filter((load) => !text(load.shipmentId))
    .map((load) => ({
      loadId: String(load.id),
      loadNumber: text(load.loadNumber),
      customer: text(load.customer),
      status: text(load.status),
    }))
    .sort((a, b) => a.loadId.localeCompare(b.loadId));
}

// ── Plan ─────────────────────────────────────────────────────────────────────

/**
 * Exactly the fields the passes read, per row. Fingerprinting `updatedAt` on every
 * shipment would invalidate the plan the moment a dispatcher saved an ETA.
 * @param {Record<string, any[] | null>} source
 * @returns {Array<Record<string, unknown>>}
 */
export function sourceRowsOf(source) {
  const FIELDS = {
    Shipment: ['number', 'salesRepId', 'revDivision', 'revSubdivision', 'revTagSource', 'deletedAt', 'deletedBy', 'voidedAt', 'version'],
    Order: ['shipmentId', 'customerRepId'],
    // The driver marks a void clears are read off the Load, so a dispatcher who
    // reassigns one between plan and apply invalidates the plan. `voidedAt` is the
    // mirror pass's own input and is fingerprinted for the same reason.
    Load: ['shipmentId', 'loadNumber', 'customer', 'status', 'stops', 'pickupDriverId', 'deliveryDriverId', 'truckId', 'readyToInvoice', 'voidedAt'],
    UserProfile: ['email'],
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
 * @param {Record<string, any> | null} input.retag the RETAG_SHIPMENTS dry-run report
 * @param {string} input.environment
 * @param {string} input.suffix
 */
export function buildRevDivisionPlan({ source, retag, environment, suffix }) {
  const shipments = source.Shipment ?? [];
  const reps = planSalesReps({
    shipments,
    orders: source.Order ?? [],
    profiles: source.UserProfile ?? [],
  });
  const voids = planLegacyVoids(shipments, source.Load ?? []);
  const voidMirror = planVoidMirror(shipments, source.Load ?? []);
  const orphanLoads = loadsWithoutShipment(source.Load ?? []);

  const actions = [
    // The seed first: a rule cannot resolve to a division that is not there yet.
    { action: 'ENSURE_OWNERSHIP_SEED', purpose: 'The seed divisions, rules and views that are missing', input: {} },
    { action: 'RETAG_SHIPMENTS', purpose: 'Re-resolve every shipment that is not hand-tagged', input: { dryRun: false } },
    ...reps.actions,
    ...voids,
    // After the voids: a legacy soft delete becomes a void in the same run, and the
    // mirror is written with the time that void carries.
    ...voidMirror,
  ];

  return createPlan({
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceType: 'Shipment / Order / Load / UserProfile for the Step R revenue taxonomy',
    sourceRows: sourceRowsOf(source),
    actions,
    reviewables: reps.unresolved.map((row) => ({
      kind: 'REP_NOT_RESOLVED',
      reason:
        `Shipment ${row.shipmentNumber ?? row.shipmentId} names its rep as "${row.value}" and no ` +
        'UserProfile carries it; the shipment is left without a sales rep rather than guessed',
      source: row,
    })),
    unresolved: reps.unresolved,
    summary: {
      shipments: shipments.length,
      ownership: {
        divisions: (source.OwnershipDivision ?? []).length,
        rules: (source.OwnershipRule ?? []).length,
        views: (source.ShipmentView ?? []).length,
      },
      retag: retag ?? null,
      salesReps: {
        toWrite: reps.actions.length,
        alreadySet: reps.alreadySet,
        noRepOnOrder: reps.noRepOnOrder,
        leavingTheBoard: reps.leavingTheBoard,
        unresolved: reps.unresolved.length,
        unresolvedByValue: reps.byValue,
      },
      legacyVoids: voids.length,
      // Named one by one, not counted: each is a driver's calendar or settlement.
      legacyVoidLoads: voids.flatMap((entry) =>
        entry.loads.map((load) => ({ ...load, shipmentId: entry.shipmentId, shipmentNumber: entry.shipmentNumber }))
      ),
      voidMirror: voidMirror.map(({ loadId, loadNumber, status, shipmentId, shipmentNumber, voidedAt }) => ({
        loadId, loadNumber, status, shipmentId, shipmentNumber, voidedAt,
      })),
      tagsNow: countTags(shipments),
      loadsWithoutShipment: orphanLoads,
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
    `Shipments read:                ${s.shipments}`,
    `OwnershipDivision rows:        ${s.ownership.divisions}`,
    `OwnershipRule rows:            ${s.ownership.rules}`,
    `ShipmentView rows:             ${s.ownership.views}`,
    '',
  ];

  const retag = s.retag;
  if (!retag) {
    lines.push('RETAG_SHIPMENTS: the Lambda did not answer the dry run — nothing can be applied.');
  } else {
    lines.push(
      'RETAG_SHIPMENTS (dry run):',
      `    scanned:     ${retag.scanned ?? 0}`,
      `    changed:     ${retag.changed ?? 0}`,
      `    handTagged:  ${retag.handTagged ?? 0} (never re-tagged)`,
      '    byDivision:'
    );
    const divisions = Object.entries(retag.byDivision ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (divisions.length === 0) lines.push('        (none)');
    for (const [code, count] of divisions) lines.push(`        ${code}: ${count}`);
    lines.push('    bySubdivision:');
    const subs = Object.entries(retag.bySubdivision ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (subs.length === 0) lines.push('        (none)');
    for (const [code, count] of subs) lines.push(`        ${code}: ${count}`);
  }

  const reps = s.salesReps;
  lines.push(
    '',
    'Sales rep:',
    `    to write:        ${reps.toWrite}`,
    `    already set:     ${reps.alreadySet}`,
    `    no rep on order: ${reps.noRepOnOrder}`,
    `    voided/deleted:  ${reps.leavingTheBoard} (left without a rep on purpose)`,
    `    unresolved:      ${reps.unresolved}`
  );
  const values = Object.entries(reps.unresolvedByValue ?? {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [value, count] of values) lines.push(`        ${value}: ${count} shipment(s) — no UserProfile carries it`);

  lines.push('', `Legacy soft deletes to void: ${s.legacyVoids} ("${LEGACY_VOID_REASON}")`);
  const voidLoads = s.legacyVoidLoads ?? [];
  lines.push(
    `    Mirrored loads cleared with them: ${voidLoads.length} — our fleet comes off the`,
    '    load (stops, pickup/delivery driver, truck, trailer), readyToInvoice goes false',
    '    and the load is CANCELED, the way the shipment router\'s own void does it:'
  );
  if (voidLoads.length === 0) lines.push('        (none — no voided shipment carries a driver mark)');
  for (const load of voidLoads) {
    const marks = [
      ...load.driverMarks,
      ...(load.readyToInvoice ? ['readyToInvoice'] : []),
    ].join(', ');
    lines.push(
      `        ${load.loadId}${load.loadNumber ? ` (${load.loadNumber})` : ''} on ` +
      `${load.shipmentNumber ?? load.shipmentId} — ${marks}` +
      `${load.canceling ? '' : ' (already CANCELED)'}`
    );
  }

  const mirror = s.voidMirror ?? [];
  lines.push(
    '',
    `Voids to mirror onto their loads: ${mirror.length} — the calendar, dispatch, the`,
    '    appointment queue, the schedule and the pay hooks read the Load table and never',
    '    join a shipment, so this one field is what takes voided freight out of them.',
    '    Nothing else on the load moves, and the Voided tab still reads it:'
  );
  if (mirror.length === 0) lines.push('        (none — every voided shipment\'s load already carries its void)');
  for (const load of mirror) {
    lines.push(
      `        ${load.loadId}${load.loadNumber ? ` (${load.loadNumber})` : ''} on ` +
      `${load.shipmentNumber ?? load.shipmentId} — ${load.status ?? 'no status'} → voidedAt ${load.voidedAt}`
    );
  }

  const tags = s.tagsNow;
  lines.push('', 'Tags over ALL shipments right now:');
  const now = Object.entries(tags.byDivision).sort(([a], [b]) => a.localeCompare(b));
  if (now.length === 0) lines.push('    (none tagged)');
  for (const [code, count] of now) lines.push(`    ${code}: ${count}`);
  const nowSubs = Object.entries(tags.bySubdivision).sort(([a], [b]) => a.localeCompare(b));
  if (nowSubs.length > 0) {
    lines.push('    by subdivision:');
    for (const [code, count] of nowSubs) lines.push(`        ${code}: ${count}`);
  }
  lines.push(
    `    untagged: ${tags.untagged}`,
    `    hand-tagged: ${tags.handTagged}`,
    `    voided (not counted above): ${tags.voided}`
  );

  const orphans = s.loadsWithoutShipment ?? [];
  lines.push('', `Loads with no shipment: ${orphans.length} — reported, never invented:`);
  if (orphans.length === 0) lines.push('    (none)');
  for (const load of orphans) {
    lines.push(`    ${load.loadId}${load.loadNumber ? ` (${load.loadNumber})` : ''} — customer text: ${load.customer ?? '(none)'}`);
  }

  lines.push(
    '',
    'Nothing is deleted. A legacy soft delete becomes a void: the PRO, the history and',
    'the documents all stay, and no PRO is ever reused.'
  );

  if (plan.reviewables.length > 0) {
    lines.push('', 'Needs a person — NOT changed:');
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
        throw new Error(`Table ${tableName} does not exist — has the Step R schema been deployed to this stack?`);
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
 * One audit row per legacy void, the same way the Lambdas do it. The two Lambda
 * actions audit themselves.
 * @param {any} doc
 * @param {string} table
 * @param {string} entityId
 * @param {Record<string, unknown>} changes
 */
async function writeAudit(doc, table, entityId, changes) {
  const now = new Date().toISOString();
  try {
    await doc.send(new PutCommand({
      TableName: table,
      Item: {
        id: randomUUID(),
        __typename: 'AuditLog',
        entityType: 'Shipment',
        entityId,
        action: 'VOID_SHIPMENT',
        user: MIGRATION_USER,
        changes: JSON.stringify(changes),
        createdAt: now,
        updatedAt: now,
      },
    }));
  } catch (err) {
    console.warn(`audit log write failed for Shipment ${entityId}: ${err.message}`);
  }
}

/**
 * Take our fleet off one mirrored load, the way `applyVoid` does in
 * `amplify/functions/tms-shipment-actions/handler.ts`: the stops and the four mirror
 * columns cleared, nothing ready to bill, and the load canceled by the SYSTEM rather
 * than by a person. Who held it stays readable on `assignmentType`, `carrierName`
 * and the LoadCarrier legs — that is the record, and it is deliberately not touched.
 *
 * @param {any} doc
 * @param {string} table
 * @param {Record<string, any>} load one entry of a VOID_LEGACY_SOFT_DELETE's `loads`
 */
async function clearVoidedLoad(doc, table, load) {
  const now = new Date().toISOString();
  const names = {};
  const values = {
    ':null': null,
    ':false': false,
    ':now': now,
    ':user': MIGRATION_USER,
  };
  const sets = [
    'pickupDriverId = :null',
    'deliveryDriverId = :null',
    'truckId = :null',
    'trailerNumber = :null',
    'readyToInvoice = :false',
    'updatedAt = :now',
    'updatedBy = :user',
  ];
  if (load.stops) {
    // AWSJSON: the column holds the serialised array, which is how it was read.
    values[':stops'] = JSON.stringify(load.stops);
    sets.push('stops = :stops');
  }
  if (load.canceling) {
    names['#status'] = 'status';
    values[':canceled'] = 'CANCELED';
    values[':system'] = 'SYSTEM';
    sets.push('#status = :canceled', 'statusChangedAt = :now', 'statusChangedBy = :user', 'statusSource = :system');
  }
  await doc.send(new UpdateCommand({
    TableName: table,
    Key: { id: load.loadId },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  }));
}

/**
 * Replay a reviewed plan. The order is the plan's order: seed, retag, reps, voids.
 *
 * @param {object} input
 * @param {any} input.client the AppSync client (both Lambda actions)
 * @param {any} input.doc the DynamoDB document client (the legacy voids only)
 * @param {import('./lib/tmsPlan.mjs').TmsPlan} input.plan
 * @param {string} input.suffix
 */
export async function applyRevDivisionPlan({ client, doc, plan, suffix }) {
  // The suffix was checked before the read; it is checked again here because this is
  // the function that writes, and it is exported for tests and for other callers.
  if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error(`Refusing to write shipments in production tables (${suffix})`);
  }
  const shipmentTable = `Shipment-${suffix}`;
  const loadTable = `Load-${suffix}`;
  const auditTable = `AuditLog-${suffix}`;
  const report = {
    seed: null,
    retag: null,
    salesRepsWritten: 0,
    voidsWritten: 0,
    voidsAlready: 0,
    loadsCleared: 0,
    voidsMirrored: 0,
    voidsMirrorAlready: 0,
    failures: [],
  };

  for (const entry of plan.actions) {
    try {
      if (entry.action === 'ENSURE_OWNERSHIP_SEED') {
        report.seed = await client.tmsDirectoryActions('ENSURE_OWNERSHIP_SEED', {});
        continue;
      }
      if (entry.action === 'RETAG_SHIPMENTS') {
        report.retag = await client.tmsShipmentActions('RETAG_SHIPMENTS', { dryRun: false });
        continue;
      }
      if (entry.action === 'SET_SALES_REP') {
        await client.tmsShipmentActions('SET_SALES_REP', { shipmentId: entry.shipmentId, repId: entry.repId });
        report.salesRepsWritten += 1;
        continue;
      }
      if (entry.action === 'MIRROR_VOID_ON_LOAD') {
        try {
          await doc.send(new UpdateCommand({
            TableName: loadTable,
            Key: { id: entry.loadId },
            // A void already on the load is the router's own and wins; this pass only
            // fills the ones written before the load carried the field. A row the
            // client wrote with an explicit `voidedAt: null` — a duplicate made in the
            // scheduler spreads the whole load into `createLoad` — stores the
            // attribute as NULL, which `attribute_not_exists` counts as present, so
            // that case is named here rather than silently reported as already done.
            ConditionExpression: 'attribute_not_exists(voidedAt) OR voidedAt = :nothing',
            UpdateExpression: 'SET voidedAt = :voidedAt, updatedAt = :updatedAt, updatedBy = :updatedBy',
            ExpressionAttributeValues: {
              ':voidedAt': entry.voidedAt,
              ':nothing': null,
              ':updatedAt': new Date().toISOString(),
              ':updatedBy': MIGRATION_USER,
            },
          }));
          report.voidsMirrored += 1;
        } catch (err) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
          report.voidsMirrorAlready += 1;
        }
        continue;
      }
      if (entry.action === 'VOID_LEGACY_SOFT_DELETE') {
        try {
          await doc.send(new UpdateCommand({
            TableName: shipmentTable,
            Key: { id: entry.shipmentId },
            // A void recorded since the plan was built is the real one and wins.
            ConditionExpression: 'attribute_not_exists(voidedAt)',
            UpdateExpression:
              'SET voidedAt = :voidedAt, voidedBy = :voidedBy, voidReason = :voidReason, ' +
              'updatedAt = :updatedAt, updatedBy = :updatedBy, #version = :version',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: {
              ':voidedAt': entry.voidedAt,
              ':voidedBy': entry.voidedBy,
              ':voidReason': entry.voidReason,
              ':updatedAt': new Date().toISOString(),
              ':updatedBy': MIGRATION_USER,
              ':version': (entry.version ?? 0) + 1,
            },
          }));
          report.voidsWritten += 1;
          // The void is not finished until the freight is off our drivers: the
          // calendar, dispatch and settlements key on the load, not on the shipment.
          // Only on the branch that wrote the void — when the condition fails, a real
          // void landed since the plan was built and the router already cleared these.
          for (const load of entry.loads ?? []) {
            await clearVoidedLoad(doc, loadTable, load);
            report.loadsCleared += 1;
          }
          await writeAudit(doc, auditTable, entry.shipmentId, {
            voidedAt: entry.voidedAt,
            voidedBy: entry.voidedBy,
            voidReason: entry.voidReason,
            shipmentNumber: entry.shipmentNumber,
            loadsCleared: (entry.loads ?? []).map((load) => load.loadId),
          });
        } catch (err) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
          // Already voided — by an earlier run of this plan, or by a person since.
          report.voidsAlready += 1;
        }
        continue;
      }
      throw new Error(`Unknown action ${entry.action}`);
    } catch (err) {
      report.failures.push({ action: entry.action, id: entry.shipmentId ?? null, error: err.message });
    }
  }

  return report;
}

/**
 * What the counts look like after the writes, read back off the table rather than
 * assumed from the plan.
 * @param {any} doc
 * @param {string} suffix
 */
export async function finalCounts(doc, suffix) {
  const shipments = await scanAll(doc, `Shipment-${suffix}`);
  const loads = await scanAll(doc, `Load-${suffix}`);
  return { ...countTags(shipments), shipments: shipments.length, loadsWithoutShipment: loadsWithoutShipment(loads) };
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

  const outputs = loadAmplifyOutputs(args.values.outputs);
  const auth = await authenticateTmsUser(outputs);
  const client = createTmsClient({ endpoint: auth.endpoint, token: auth.token });

  const source = await readSource(doc, suffix);

  if (!args.values.apply) {
    // The one Lambda call a dry run makes, and it writes nothing by contract.
    const retag = await client.tmsShipmentActions('RETAG_SHIPMENTS', { dryRun: true });
    const plan = buildRevDivisionPlan({ source, retag, environment, suffix });
    console.log(reviewText(plan));
    if (args.values.plan) {
      savePlan(plan, resolve(process.cwd(), args.values.plan));
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

  const report = await applyRevDivisionPlan({ client, doc, plan, suffix });
  const after = await finalCounts(doc, suffix);
  console.log(JSON.stringify({ environment, suffix, ...report, after }, null, 2));
  if (report.failures.length > 0) process.exit(2);
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
