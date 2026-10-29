#!/usr/bin/env node
/**
 * Open the AP worklists on the carrier legs we already have (Step G).
 *
 * Step B wrote one LoadCarrier row per assignment and started every one of them on
 * `apStatus: 'AWAITING_INVOICE'`, own fleet included. Step G adds the sparse
 * `apOpen` + `apStatusChangedAt` index — the one query behind "every outside carrier
 * we still owe money on" — and a row with no partition key is not in a sparse index
 * at all. Without this migration the AP page opens onto nothing, however many legs
 * are out there unpaid.
 *
 * Two passes, over LoadCarrier:
 *
 *   (a) every row with `kind === 'OWN_ASSET'` has `apStatus` REMOVEd. Own-fleet legs
 *       never enter AP: the driver is paid through a settlement, not a carrier bill,
 *       and an AWAITING_INVOICE rung on one of them is Step B's default leaking into
 *       a ledger it does not belong in. The row keeps everything else it has;
 *
 *   (b) every row with `kind === 'CARRIER'`, `status` ACTIVE or TONU, and an
 *       `apStatus` other than PAID gets `apOpen: 'OPEN'` and `apStatusChangedAt`
 *       stamped at `bookedAt`, else `createdAt` — when we took the leg on, which is
 *       when we started owing for it. TONU is in because a truck-ordered-not-used
 *       leg is still a bill; BOUNCED is out because the carrier that walked is owed
 *       nothing. The stamp is read off the row, never "now", so a re-plan tomorrow
 *       produces the same value and the AP board sorts by age rather than by the
 *       order a migration happened to visit rows in.
 *
 * `apOpen` is never written as NULL. DynamoDB rejects a NULL in an index key
 * outright, so the only way to take a row back out of the AP board is REMOVE — which
 * is what pass (a) does to `apStatus` and what Step G's Lambda does to `apOpen` when
 * a bill is paid or a carrier bounces.
 *
 * What it deliberately does NOT do:
 *
 *   - it backfills no CarrierBill rows. Aljex-era carrier pay was settled in Aljex:
 *     those cheques cleared years ago, and inventing bills for them would create a
 *     second, fictional set of payables whose numbers and balances nobody could
 *     defend. The legs get their index keys; the money stays where it was paid;
 *   - it invents no AP rung. A CARRIER row with no `apStatus` at all still gets
 *     `apOpen` and a stamp — the board is driven by `apOpen`, and where in the AP
 *     flow such a leg sits is a person's call, not a migration's. A row with no
 *     timestamp to stamp is reported and left alone;
 *   - it changes nothing on a PAID or BOUNCED row, nothing on a leg whose shipment has
 *     been deleted (DELETE_SHIPMENT took the marker off on purpose and RESTORE_SHIPMENT
 *     puts it back), and nothing on a CARRIER row that already carries an `invoiceId`.
 *     Before Step G runs there should be no such invoiceId at all, so any that exist
 *     are LISTED for a person to look at.
 *
 * Dry run is the default and writes NOTHING to AWS: it prints the counts per pass and
 * writes a plan file when `--plan` is given. `--apply` replays that reviewed plan
 * after checking the source rows have not moved underneath it.
 *
 * The guard that matters is the TABLE SUFFIX, not a flag a human types: this script
 * talks to DynamoDB directly, so the environment is read off the tables it was
 * pointed at and the production suffix is refused before a single read.
 *
 *   node scripts/backfillApOpen.mjs --help
 *   node scripts/backfillApOpen.mjs --plan plans/g-ap-open.json
 *   node scripts/backfillApOpen.mjs --apply --plan plans/g-ap-open.json
 */

import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { parseTmsArgs } from './lib/tmsConfig.mjs';
import { createPlan, loadPlan, savePlan, validatePlan, summarize } from './lib/tmsPlan.mjs';

export const REGION_DEFAULT = 'us-east-1';
/** The dev stack. Every write this script makes lands here unless --suffix says otherwise. */
export const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE';
/** Production. Present anywhere in a suffix, the run stops before a single read. */
export const PRODUCTION_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4';
/** Who the audit trail says did this. Not a person: a script, named so it can be found again. */
export const MIGRATION_USER = 'migration:backfillApOpen';

/** The sparse marker. Present means "we still owe on this leg"; absent means we do not. */
export const AP_OPEN = 'OPEN';
/** A leg we are on the hook for. BOUNCED is not: the carrier that walked is owed nothing. */
export const OPEN_STATUSES = ['ACTIVE', 'TONU'];
/** Settled. Pass (b) steps over it rather than re-opening a payable somebody closed. */
export const PAID_AP_STATUS = 'PAID';

const MODELS = ['LoadCarrier', 'Shipment'];

const USAGE = `
Usage: node scripts/backfillApOpen.mjs [options]

Options:
  --help, -h        Show this offline help.
  --suffix <s>      DynamoDB table suffix (default ${DEV_TABLE_SUFFIX});
                    the production suffix is refused.
  --region <r>      AWS region (default ${REGION_DEFAULT}).
  --plan <path>     (dry-run) write the plan file; (apply) read it back.
  --apply           Apply the reviewed plan.

Pass (a): a LoadCarrier with kind=OWN_ASSET has apStatus REMOVEd. Own-fleet legs are
          paid through driver settlements and never enter AP.
Pass (b): a LoadCarrier with kind=CARRIER, status ${OPEN_STATUSES.join(' or ')}, and apStatus other
          than ${PAID_AP_STATUS} gets apOpen='${AP_OPEN}' and apStatusChangedAt = bookedAt ?? createdAt,
          because the apOpen+apStatusChangedAt index is sparse and a row with no keys
          never appears on the AP board.

apOpen is never written as NULL — a NULL in an index key is rejected outright, so
REMOVE is the only way to clear it.

No CarrierBill rows are written: Aljex-era carrier pay was settled in Aljex.

Dry run reads the table, prints what both passes would do, and writes nothing to AWS.
Apply re-reads the same table, refuses a plan whose sources have changed, and then
writes each update under a condition that makes a re-run free.
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
      `Refusing to run against production tables (${suffix}): this backfill rewrites ` +
        'LoadCarrier.apStatus, LoadCarrier.apOpen and LoadCarrier.apStatusChangedAt, and ' +
        `Step G is a dev-only build. Point it at the dev suffix (${DEV_TABLE_SUFFIX}).`
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

/**
 * When we took this leg on. The index sorts on it, so a deterministic answer matters
 * more than a precise one: the same row re-planned tomorrow must produce the same stamp,
 * and apply-time "now" would float a years-old leg above today's work.
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
export function stampFor(row) {
  return text(row.apStatusChangedAt) ?? text(row.bookedAt) ?? text(row.createdAt);
}

// ── Plan ─────────────────────────────────────────────────────────────────────

/**
 * Both passes, over the carrier legs as they are now.
 *
 * @param {any[]} rows
 * @param {any[]} [shipments] Shipment rows, read for `deletedAt` only.
 * @returns {{
 *   clears: any[], opens: any[], invoiced: any[], unexpectedOpen: any[], unstampable: any[],
 *   byKind: Record<string, number>, byApStatus: Record<string, number>,
 *   ownAlreadyClear: number, alreadyOpen: number, skippedPaid: number, skippedBounced: number,
 *   skippedShipmentDeleted: number
 * }}
 */
export function planCarrierLegs(rows, shipments = []) {
  const clears = [];
  const opens = [];
  const invoiced = [];
  const unexpectedOpen = [];
  const unstampable = [];
  const byKind = {};
  const byApStatus = {};
  let ownAlreadyClear = 0;
  let alreadyOpen = 0;
  let skippedPaid = 0;
  let skippedBounced = 0;
  let skippedShipmentDeleted = 0;
  const deletedShipments = new Set(
    shipments.filter((s) => text(s.deletedAt)).map((s) => String(s.id)),
  );

  const ordered = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const row of ordered) {
    const id = String(row.id);
    const kind = text(row.kind);
    const status = text(row.status);
    const apStatus = text(row.apStatus);
    const apOpen = text(row.apOpen);
    byKind[kind ?? 'not set'] = (byKind[kind ?? 'not set'] ?? 0) + 1;

    if (kind === 'OWN_ASSET') {
      if (!apStatus) {
        ownAlreadyClear += 1;
      } else {
        clears.push({
          action: 'CLEAR_OWN_ASSET_AP_STATUS',
          pass: 'a',
          purpose: 'Own-fleet legs are paid through driver settlements, never through AP',
          id,
          loadId: text(row.loadId),
          before: { apStatus },
        });
      }
      if (apOpen) {
        // Nothing should ever have put an own-fleet leg on the AP board. Removing it is a
        // write pass (a) was not asked for, so it is listed rather than performed.
        unexpectedOpen.push({ loadCarrierId: id, kind, status, apStatus, apOpen, reason: 'OWN_ASSET_ON_AP_BOARD' });
      }
      continue;
    }

    if (kind !== 'CARRIER') {
      // No kind at all — Step B wrote one on every row, so this is a row nobody can
      // classify, and guessing OWN_ASSET or CARRIER picks a ledger for it.
      unstampable.push({ loadCarrierId: id, status, apStatus, reason: 'NO_CARRIER_KIND' });
      continue;
    }

    byApStatus[apStatus ?? 'not set'] = (byApStatus[apStatus ?? 'not set'] ?? 0) + 1;
    const invoiceId = text(row.invoiceId);
    if (invoiceId) {
      // Step G is the only thing that writes a CarrierBill id back here, so before it
      // runs there should be none. Reported, and still eligible for pass (b): a leg with
      // a live bill belongs on the AP board more than any other.
      invoiced.push({ loadCarrierId: id, loadId: text(row.loadId), status, apStatus, invoiceId });
    }

    if (!OPEN_STATUSES.includes(status ?? '')) {
      skippedBounced += 1;
      if (apOpen) {
        // A bounced leg carrying the marker would sit on the AP board forever. Step G
        // REMOVEs it when the bounce happens; a pre-existing one is a person's problem.
        unexpectedOpen.push({ loadCarrierId: id, kind, status, apStatus, apOpen, reason: 'BOUNCED_ON_AP_BOARD' });
      }
      continue;
    }
    const shipmentId = text(row.shipmentId);
    if (shipmentId && deletedShipments.has(shipmentId)) {
      // DELETE_SHIPMENT took the marker off on purpose: a leg of a shipment nobody can
      // open is work nobody can do, and RESTORE_SHIPMENT puts it back if the shipment
      // comes back. Re-opening it here would undo that every time this ran.
      skippedShipmentDeleted += 1;
      if (apOpen) {
        unexpectedOpen.push({ loadCarrierId: id, kind, status, apStatus, apOpen, reason: 'DELETED_SHIPMENT_ON_AP_BOARD' });
      }
      continue;
    }
    if (apStatus === PAID_AP_STATUS) {
      skippedPaid += 1;
      if (apOpen) {
        unexpectedOpen.push({ loadCarrierId: id, kind, status, apStatus, apOpen, reason: 'PAID_ON_AP_BOARD' });
      }
      continue;
    }

    const apStatusChangedAt = stampFor(row);
    if (!apStatusChangedAt) {
      // The marker without a sort key is still not in the index, so writing apOpen alone
      // would buy nothing and hide the problem. Reported instead of guessed.
      unstampable.push({ loadCarrierId: id, status, apStatus, reason: 'NO_TIMESTAMP_TO_STAMP' });
      continue;
    }
    if (apOpen === AP_OPEN && text(row.apStatusChangedAt)) {
      alreadyOpen += 1;
      continue;
    }

    opens.push({
      action: 'OPEN_AP',
      pass: 'b',
      purpose: 'Put the carrier leg in the sparse apOpen + apStatusChangedAt index',
      id,
      loadId: text(row.loadId),
      carrierId: text(row.carrierId),
      apStatus,
      apStatusChangedAt,
      before: { apOpen, apStatusChangedAt: text(row.apStatusChangedAt) },
    });
  }

  return {
    clears, opens, invoiced, unexpectedOpen, unstampable,
    byKind, byApStatus, ownAlreadyClear, alreadyOpen, skippedPaid, skippedBounced, skippedShipmentDeleted,
  };
}

/**
 * Exactly the fields the passes read, per row. Fingerprinting `updatedAt` on every leg
 * would invalidate the plan the moment a dispatcher saved an ETA; fingerprinting what is
 * actually read invalidates it when, and only when, it has stopped being true.
 * @param {Record<string, any[] | null>} source
 * @returns {Array<Record<string, unknown>>}
 */
export function sourceRowsOf(source) {
  const FIELDS = {
    LoadCarrier: ['loadId', 'shipmentId', 'kind', 'status', 'apStatus', 'apOpen', 'apStatusChangedAt', 'invoiceId', 'bookedAt', 'createdAt'],
    Shipment: ['deletedAt'],
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
 */
export function buildApOpenPlan({ source, environment, suffix }) {
  const legs = source.LoadCarrier ?? [];
  const planned = planCarrierLegs(legs, source.Shipment ?? []);

  return createPlan({
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceType: 'LoadCarrier.apStatus on own-fleet legs + apOpen on open carrier legs',
    sourceRows: sourceRowsOf(source),
    actions: [...planned.clears, ...planned.opens],
    reviewables: [
      ...planned.invoiced.map((row) => ({
        kind: 'CARRIER_LEG_WITH_BILL',
        reason: `LoadCarrier ${row.loadCarrierId} already carries invoiceId ${row.invoiceId}; nothing but Step G writes one`,
        source: row,
      })),
      ...planned.unexpectedOpen.map((row) => ({
        kind: row.reason,
        reason: `LoadCarrier ${row.loadCarrierId} carries apOpen='${row.apOpen}' but is ${row.kind}/${row.status}/${row.apStatus ?? 'no apStatus'}; left exactly as it is`,
        source: row,
      })),
    ],
    unresolved: planned.unstampable,
    summary: {
      loadCarriers: legs.length,
      byKind: planned.byKind,
      passA: {
        toClear: planned.clears.length,
        alreadyClear: planned.ownAlreadyClear,
      },
      passB: {
        toOpen: planned.opens.length,
        alreadyOpen: planned.alreadyOpen,
        skippedPaid: planned.skippedPaid,
        skippedNotOpenStatus: planned.skippedBounced,
        skippedShipmentDeleted: planned.skippedShipmentDeleted,
        byApStatus: planned.byApStatus,
      },
      carrierLegsWithBill: planned.invoiced.length,
      carrierBillRowsWritten: 0,
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
    `LoadCarrier rows read:         ${s.loadCarriers}`,
    '  by kind:',
  ];
  const kinds = Object.entries(s.byKind).sort(([a], [b]) => a.localeCompare(b));
  if (kinds.length === 0) lines.push('    (none)');
  for (const [kind, count] of kinds) lines.push(`    ${kind}: ${count}`);

  lines.push(
    '',
    'Pass (a) OWN_ASSET legs → apStatus REMOVEd (own fleet is paid by settlement)',
    `  legs to clear:               ${s.passA.toClear}`,
    `  already clear:               ${s.passA.alreadyClear}`,
    '',
    `Pass (b) CARRIER legs → apOpen='${AP_OPEN}' (the index is sparse; no keys = no AP board row)`,
    `  legs to open:                ${s.passB.toOpen}`,
    `  already open:                ${s.passB.alreadyOpen}`,
    `  skipped, ${PAID_AP_STATUS}:               ${s.passB.skippedPaid}`,
    `  skipped, not ${OPEN_STATUSES.join('/')}:    ${s.passB.skippedNotOpenStatus}`,
    `  skipped, shipment deleted:   ${s.passB.skippedShipmentDeleted}`,
    '  prior AP status on carrier legs:'
  );
  const prior = Object.entries(s.passB.byApStatus).sort(([a], [b]) => a.localeCompare(b));
  if (prior.length === 0) lines.push('    (none)');
  for (const [status, count] of prior) lines.push(`    ${status}: ${count}`);

  lines.push(
    '',
    'CarrierBill rows written: 0 — Aljex-era carrier pay was settled in Aljex.',
    'apOpen is never written as NULL; REMOVE is the only way to clear an index key.'
  );

  if (plan.reviewables.length > 0) {
    lines.push('', 'Carrier legs that need a person — NOT changed:');
    for (const r of plan.reviewables) lines.push(`  ${r.kind}: ${r.reason}`);
  } else {
    lines.push('', 'No carrier leg carries an invoiceId or a stray apOpen, which is what we expect before Step G.');
  }

  if (plan.unresolved.length > 0) {
    const byReason = {};
    for (const u of plan.unresolved) byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;
    lines.push('', 'Legs left exactly as they are (nothing invented):');
    for (const [reason, count] of Object.entries(byReason).sort()) lines.push(`  ${reason}: ${count}`);
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
 * One audit row per write, the same way the Lambdas do it. Best effort: a leg must not
 * be reported as failed because the history table refused a line.
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
        entityType: 'LoadCarrier',
        entityId,
        action,
        user: MIGRATION_USER,
        changes: JSON.stringify(changes),
        createdAt: now,
        updatedAt: now,
      },
    }));
  } catch (err) {
    console.warn(`audit log write failed for LoadCarrier ${entityId}: ${err.message}`);
  }
}

/**
 * @param {object} input
 * @param {any} input.doc
 * @param {import('./lib/tmsPlan.mjs').TmsPlan} input.plan
 * @param {string} input.suffix
 */
export async function applyApOpenPlan({ doc, plan, suffix }) {
  const legTable = `LoadCarrier-${suffix}`;
  const auditTable = `AuditLog-${suffix}`;
  const report = {
    cleared: 0,
    clearedAlreadyCurrent: 0,
    opened: 0,
    openedAlreadyCurrent: 0,
    failures: [],
  };

  for (const entry of plan.actions) {
    try {
      if (entry.action === 'CLEAR_OWN_ASSET_AP_STATUS') {
        try {
          await doc.send(new UpdateCommand({
            TableName: legTable,
            // `updatedAt`/`updatedBy` are deliberately untouched: this takes a field off
            // a row that never belonged in AP, and bumping the CAS fields would make every
            // own-fleet leg look edited today by a script nobody dispatched.
            UpdateExpression: 'REMOVE apStatus',
            Key: { id: entry.id },
            // Still own fleet, still carrying the rung the plan read. A leg re-assigned to
            // an outside carrier since the plan was written keeps its AP state.
            ConditionExpression: 'attribute_exists(id) AND kind = :own AND apStatus = :before',
            ExpressionAttributeValues: { ':own': 'OWN_ASSET', ':before': entry.before.apStatus },
          }));
          report.cleared += 1;
          await writeAudit(doc, auditTable, entry.id, 'BACKFILL_AP_CLEAR_OWN_ASSET', {
            pass: entry.pass,
            before: entry.before,
            after: { apStatus: null },
          });
        } catch (err) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
          // Cleared by an earlier run, or no longer an own-fleet leg.
          report.clearedAlreadyCurrent += 1;
        }
        continue;
      }

      if (entry.action === 'OPEN_AP') {
        try {
          await doc.send(new UpdateCommand({
            TableName: legTable,
            Key: { id: entry.id },
            // The stamp is the row's own history written back onto it, so `updatedAt` is
            // left alone here too.
            UpdateExpression: 'SET apOpen = :open, apStatusChangedAt = :stamp',
            // Still an outside carrier, still a leg we are on the hook for, and still not
            // paid: a bill settled between the plan and the apply wins over the plan, and
            // re-running over a row this script already opened changes nothing.
            ConditionExpression:
              'attribute_exists(id) AND kind = :carrier AND (#status = :active OR #status = :tonu) ' +
              'AND (attribute_not_exists(apStatus) OR apStatus <> :paid) ' +
              'AND (attribute_not_exists(apOpen) OR apOpen <> :open OR attribute_not_exists(apStatusChangedAt))',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':carrier': 'CARRIER',
              ':active': OPEN_STATUSES[0],
              ':tonu': OPEN_STATUSES[1],
              ':paid': PAID_AP_STATUS,
              ':open': AP_OPEN,
              ':stamp': entry.apStatusChangedAt,
            },
          }));
          report.opened += 1;
          await writeAudit(doc, auditTable, entry.id, 'BACKFILL_AP_OPEN', {
            pass: entry.pass,
            apStatus: entry.apStatus,
            before: entry.before,
            after: { apOpen: AP_OPEN, apStatusChangedAt: entry.apStatusChangedAt },
          });
        } catch (err) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
          // Already on the board, bounced, or paid since the plan was written.
          report.openedAlreadyCurrent += 1;
        }
        continue;
      }

      throw new Error(`Unknown action ${entry.action}`);
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
    const plan = buildApOpenPlan({ source, environment, suffix });
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

  const report = await applyApOpenPlan({ doc, plan, suffix });
  console.log(JSON.stringify({ environment, suffix, ...report }, null, 2));
  if (report.failures.length > 0) process.exit(2);
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
