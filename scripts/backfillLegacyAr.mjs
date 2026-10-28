#!/usr/bin/env node
/**
 * Retire the Aljex-era freight from the AR worklists (Step F).
 *
 * Step B turned 890 legacy loads into shipments, and every order it wrote started on the
 * first AR rung. Those bills were raised, sent and in most cases paid years ago in Aljex —
 * they are not ours to invoice, and leaving them on DOCS_NEEDED / UNBILLED would open the
 * new AR page onto 890 rows nobody will ever act on. Step F adds the `LEGACY` rung for
 * exactly this, and this script moves them onto it.
 *
 * Two passes:
 *
 *   (a) every Order whose Shipment carries `source === 'BACKFILL'` and whose `arStatus` is
 *       DOCS_NEEDED or UNBILLED becomes `arStatus: 'LEGACY'` with `arStatusChangedAt`
 *       stamped at the moment it moves. An order somebody has since invoiced is NOT
 *       touched — the condition requires `invoiceId` to be absent, so a real Step F bill
 *       raised against a backfilled load survives a re-run of this migration intact;
 *
 *   (b) every other Order that has an `arStatus` but no `arStatusChangedAt` gets one.
 *       The Step F index is `arStatus` + `arStatusChangedAt` and it is SPARSE: a row with
 *       no sort key is not in the index at all, so an order with no stamp would never
 *       appear in To invoice, Docs needed or Unpaid however correct its rung is. The value
 *       written is the order's own `updatedAt`, else its `createdAt` — the last moment we
 *       know something happened to it — so the worklist sorts sensibly and a re-run writes
 *       the same value it wrote the first time.
 *
 * What it deliberately does NOT do:
 *
 *   - it backfills no `Invoice` rows. The Aljex-era bills live in the factoring queue as
 *     `FactoringItem` rows keyed by PRO, which is where the office already reads them;
 *     inventing Invoice rows would create a second, fictional set of bills whose numbers,
 *     PDFs and balances nobody could defend;
 *   - it does not seed `TmsSettings.nextInvoiceNumber`. `GENERATE_INVOICE` takes its
 *     number with an atomic ADD, and an absent counter ADDs to 1, so the first invoice
 *     this system issues is number 1 without anybody writing a zero first;
 *   - it changes nothing about a BACKFILL order that is already UNPAID or PAID. There
 *     should be none — nothing but Step F writes those two rungs — so any that exist are
 *     LISTED for a person to look at rather than quietly overwritten;
 *   - it invents no AR rung. An order with no `arStatus` at all is reported and left
 *     alone: a stamp with no partition key cannot put a row in the index anyway, and
 *     deciding where such an order belongs is a dispatcher's call, not a migration's.
 *
 * Dry run is the default and writes NOTHING to AWS: it prints the counts per prior status
 * and writes a plan file when `--plan` is given. `--apply` replays that reviewed plan
 * after checking the source rows have not moved underneath it.
 *
 * The guard that matters is the TABLE SUFFIX, not a flag a human types: this script talks
 * to DynamoDB directly, so the environment is read off the tables it was pointed at and
 * the production suffix is refused before a single read.
 *
 *   node scripts/backfillLegacyAr.mjs --help
 *   node scripts/backfillLegacyAr.mjs --plan plans/f-legacy-ar.json
 *   node scripts/backfillLegacyAr.mjs --apply --plan plans/f-legacy-ar.json
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
export const MIGRATION_USER = 'migration:backfillLegacyAr';

/** The shipment marker Step B's backfill left behind. */
export const BACKFILL_SOURCE = 'BACKFILL';
/** The rungs a legacy order may be sitting on. Anything else is money, and money is left alone. */
export const LEGACY_FROM_STATUSES = ['DOCS_NEEDED', 'UNBILLED'];
/** A BACKFILL order on one of these has been through Step F; it is reported, never touched. */
export const MONEY_STATUSES = ['UNPAID', 'PAID'];

const MODELS = ['Order', 'Shipment', 'AuditLog'];

const USAGE = `
Usage: node scripts/backfillLegacyAr.mjs [options]

Options:
  --help, -h        Show this offline help.
  --suffix <s>      DynamoDB table suffix (default ${DEV_TABLE_SUFFIX});
                    the production suffix is refused.
  --region <r>      AWS region (default ${REGION_DEFAULT}).
  --plan <path>     (dry-run) write the plan file; (apply) read it back.
  --apply           Apply the reviewed plan.

Pass (a): an Order on a source=BACKFILL Shipment whose arStatus is ${LEGACY_FROM_STATUSES.join(' or ')}
          becomes LEGACY with arStatusChangedAt stamped. An order that already carries an
          invoiceId is left exactly as it is.
Pass (b): any other Order that has an arStatus but no arStatusChangedAt is stamped, because
          the arStatus+arStatusChangedAt index is sparse and a row with no sort key never
          appears in a worklist.

No Invoice rows are written (the Aljex-era bills live in the factoring queue) and
nextInvoiceNumber is not seeded (the first atomic ADD starts at 1).

Dry run reads the tables, prints what both passes would do, and writes nothing to AWS.
Apply re-reads the same tables, refuses a plan whose sources have changed, and then
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
      `Refusing to run against production tables (${suffix}): this backfill rewrites Order.arStatus ` +
        'and Order.arStatusChangedAt, and Step F is a dev-only build. ' +
        `Point it at the dev suffix (${DEV_TABLE_SUFFIX}).`
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
 * When an order last moved, as far as anything stored can say. The index sorts on this,
 * so a deterministic answer matters more than a precise one: the same row re-planned
 * tomorrow must produce the same stamp.
 * @param {Record<string, unknown>} order
 * @returns {string | null}
 */
export function stampFor(order) {
  return text(order.arStatusChangedAt) ?? text(order.updatedAt) ?? text(order.createdAt);
}

// ── Plan ─────────────────────────────────────────────────────────────────────

/**
 * Both passes, over the orders as they are now.
 *
 * @param {object} input
 * @param {any[]} input.orders
 * @param {any[]} input.shipments
 * @returns {{
 *   legacy: any[], stamps: any[], money: any[], noStatus: any[], noShipment: any[],
 *   byPriorStatus: Record<string, number>, alreadyLegacy: number, alreadyStamped: number, invoiced: number
 * }}
 */
export function planOrders({ orders, shipments }) {
  const backfilledShipmentIds = new Set(
    shipments
      .filter((shipment) => text(shipment.source) === BACKFILL_SOURCE)
      .map((shipment) => String(shipment.id))
  );

  const legacy = [];
  const stamps = [];
  const money = [];
  const noStatus = [];
  const noShipment = [];
  const byPriorStatus = {};
  let alreadyLegacy = 0;
  let alreadyStamped = 0;
  let invoiced = 0;

  const ordered = [...orders].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const order of ordered) {
    const id = String(order.id);
    const arStatus = text(order.arStatus);
    const shipmentId = text(order.shipmentId);
    const isBackfilled = shipmentId != null && backfilledShipmentIds.has(shipmentId);

    if (isBackfilled) {
      byPriorStatus[arStatus ?? 'not set'] = (byPriorStatus[arStatus ?? 'not set'] ?? 0) + 1;
      if (arStatus === 'LEGACY') alreadyLegacy += 1;
      if (MONEY_STATUSES.includes(arStatus ?? '')) {
        // Nothing but Step F writes UNPAID or PAID, so a legacy order on one of them is
        // either a real new bill or a surprise. Either way it is a person's decision.
        money.push({
          orderId: id,
          shipmentId,
          arStatus,
          invoiceId: text(order.invoiceId),
          invoiceNumber: text(order.invoiceNumber),
        });
      }
    }

    if (isBackfilled && LEGACY_FROM_STATUSES.includes(arStatus ?? '')) {
      if (text(order.invoiceId)) {
        // Somebody raised a Step F invoice against this legacy load. It is live AR, not
        // history, and demoting it to LEGACY would hide an open bill — but it still falls
        // through to pass (b), because a live bill with no stamp is in no worklist either.
        invoiced += 1;
      } else {
        legacy.push({
          action: 'SET_ORDER_LEGACY',
          pass: 'a',
          purpose: 'Retire an Aljex-era order from the AR worklists',
          id,
          shipmentId,
          before: { arStatus, arStatusChangedAt: text(order.arStatusChangedAt) },
        });
        continue;
      }
    }

    if (text(order.arStatusChangedAt)) {
      alreadyStamped += 1;
      continue;
    }
    if (!arStatus) {
      // No partition key, so no index row, so a stamp would change nothing. Which rung
      // this order belongs on is not a migration's call.
      noStatus.push({ orderId: id, shipmentId, reason: 'NO_AR_STATUS' });
      continue;
    }
    if (!shipmentId) noShipment.push({ orderId: id, reason: 'NO_SHIPMENT' });

    const arStatusChangedAt = stampFor(order);
    if (!arStatusChangedAt) {
      // Nothing stored says when this row last moved, and apply-time "now" would sort a
      // years-old order above today's work. Reported instead of guessed.
      noStatus.push({ orderId: id, shipmentId, arStatus, reason: 'NO_TIMESTAMP_TO_STAMP' });
      continue;
    }
    stamps.push({
      action: 'STAMP_AR_STATUS_CHANGED_AT',
      pass: 'b',
      purpose: 'Put the order in the sparse arStatus + arStatusChangedAt index',
      id,
      arStatus,
      arStatusChangedAt,
    });
  }

  return { legacy, stamps, money, noStatus, noShipment, byPriorStatus, alreadyLegacy, alreadyStamped, invoiced };
}

/**
 * Exactly the fields the passes read, per row. Fingerprinting `updatedAt` on every order
 * would invalidate the plan the moment a tracking ping touched one; fingerprinting what
 * is actually read invalidates it when, and only when, it has stopped being true.
 * @param {Record<string, any[] | null>} source
 * @returns {Array<Record<string, unknown>>}
 */
export function sourceRowsOf(source) {
  const FIELDS = {
    Order: ['shipmentId', 'arStatus', 'arStatusChangedAt', 'invoiceId', 'updatedAt', 'createdAt'],
    Shipment: ['source'],
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
export function buildLegacyArPlan({ source, environment, suffix }) {
  const orders = source.Order ?? [];
  const shipments = source.Shipment ?? [];
  const planned = planOrders({ orders, shipments });

  return createPlan({
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceType: 'Order.arStatus on BACKFILL shipments + orders with no arStatusChangedAt',
    sourceRows: sourceRowsOf(source),
    actions: [...planned.legacy, ...planned.stamps],
    reviewables: planned.money.map((row) => ({
      kind: 'BACKFILL_ORDER_WITH_MONEY',
      reason: `Order ${row.orderId} is on a backfilled shipment and already ${row.arStatus}; left exactly as it is`,
      source: row,
    })),
    unresolved: planned.noStatus,
    summary: {
      orders: orders.length,
      shipments: shipments.length,
      backfilledShipments: shipments.filter((s) => text(s.source) === BACKFILL_SOURCE).length,
      passA: {
        toLegacy: planned.legacy.length,
        alreadyLegacy: planned.alreadyLegacy,
        skippedBecauseInvoiced: planned.invoiced,
        byPriorStatus: planned.byPriorStatus,
      },
      passB: {
        toStamp: planned.stamps.length,
        alreadyStamped: planned.alreadyStamped,
        // Informational: these are stamped like any other order, they just have no
        // shipment behind them to say which board they belong to.
        ordersWithNoShipment: planned.noShipment.length,
      },
      invoiceRowsWritten: 0,
      nextInvoiceNumberSeeded: false,
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
    'Pass (a) BACKFILL orders → LEGACY',
    `  backfilled shipments:        ${s.backfilledShipments} of ${s.shipments}`,
    `  orders to retire:            ${s.passA.toLegacy}`,
    `  already LEGACY:              ${s.passA.alreadyLegacy}`,
    `  left alone (has an invoice): ${s.passA.skippedBecauseInvoiced}`,
    '  prior AR status on backfilled orders:',
  ];
  const prior = Object.entries(s.passA.byPriorStatus).sort(([a], [b]) => a.localeCompare(b));
  if (prior.length === 0) lines.push('    (none)');
  for (const [status, count] of prior) lines.push(`    ${status}: ${count}`);

  lines.push(
    '',
    'Pass (b) arStatusChangedAt stamps (the index is sparse; no sort key = no worklist row)',
    `  orders read:                 ${s.orders}`,
    `  orders to stamp:             ${s.passB.toStamp}`,
    `  already stamped:             ${s.passB.alreadyStamped}`,
    `  of those, no shipment:       ${s.passB.ordersWithNoShipment}`,
    '',
    'Invoice rows written: 0 — the Aljex-era bills live in the factoring queue.',
    'nextInvoiceNumber: not seeded — the first atomic ADD starts at 1.'
  );

  if (plan.reviewables.length > 0) {
    lines.push('', 'Backfilled orders that already carry money — NOT changed, for Ryne:');
    for (const r of plan.reviewables) {
      const { orderId, arStatus, invoiceNumber, invoiceId } = r.source;
      lines.push(`  Order ${orderId}: ${arStatus}${invoiceNumber || invoiceId ? ` (invoice ${invoiceNumber ?? invoiceId})` : ''}`);
    }
  } else {
    lines.push('', 'No backfilled order is UNPAID or PAID, which is what we expect.');
  }

  if (plan.unresolved.length > 0) {
    const byReason = {};
    for (const u of plan.unresolved) byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;
    lines.push('', 'Orders left exactly as they are (nothing invented):');
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
    MODELS.filter((m) => m !== 'AuditLog').map(async (model) => [model, await scanAll(doc, `${model}-${suffix}`)])
  );
  return Object.fromEntries(entries);
}

// ── Apply ────────────────────────────────────────────────────────────────────

/**
 * One audit row per write, the same way the Lambdas do it. Best effort: an order must not
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
        entityType: 'Order',
        entityId,
        action,
        user: MIGRATION_USER,
        changes: JSON.stringify(changes),
        createdAt: now,
        updatedAt: now,
      },
    }));
  } catch (err) {
    console.warn(`audit log write failed for Order ${entityId}: ${err.message}`);
  }
}

/**
 * @param {object} input
 * @param {any} input.doc
 * @param {import('./lib/tmsPlan.mjs').TmsPlan} input.plan
 * @param {string} input.suffix
 */
export async function applyLegacyArPlan({ doc, plan, suffix }) {
  const orderTable = `Order-${suffix}`;
  const auditTable = `AuditLog-${suffix}`;
  const report = {
    retired: 0,
    retiredAlreadyCurrent: 0,
    stamped: 0,
    stampedAlreadyCurrent: 0,
    failures: [],
  };

  for (const entry of plan.actions) {
    try {
      if (entry.action === 'SET_ORDER_LEGACY') {
        const now = new Date().toISOString();
        try {
          await doc.send(new UpdateCommand({
            TableName: orderTable,
            Key: { id: entry.id },
            UpdateExpression:
              'SET arStatus = :legacy, arStatusChangedAt = :now, updatedAt = :now, updatedBy = :user',
            // The rung must still be the one the plan read, and the order must still carry
            // no invoice: a bill raised since the plan was written wins over the plan.
            ConditionExpression:
              'attribute_exists(id) AND arStatus = :before AND attribute_not_exists(invoiceId)',
            ExpressionAttributeValues: {
              ':legacy': 'LEGACY',
              ':before': entry.before.arStatus,
              ':now': now,
              ':user': MIGRATION_USER,
            },
          }));
          report.retired += 1;
          await writeAudit(doc, auditTable, entry.id, 'BACKFILL_LEGACY_AR', {
            pass: entry.pass,
            before: entry.before,
            after: { arStatus: 'LEGACY', arStatusChangedAt: now },
          });
        } catch (err) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
          // Already LEGACY from an earlier run, or invoiced since the plan was written.
          report.retiredAlreadyCurrent += 1;
        }
        continue;
      }

      if (entry.action === 'STAMP_AR_STATUS_CHANGED_AT') {
        try {
          await doc.send(new UpdateCommand({
            TableName: orderTable,
            Key: { id: entry.id },
            // `updatedAt` is deliberately not touched: this writes the row's own history
            // back onto it, and bumping the CAS field would make the order look edited.
            UpdateExpression: 'SET arStatusChangedAt = :stamp',
            ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(arStatusChangedAt)',
            ExpressionAttributeValues: { ':stamp': entry.arStatusChangedAt },
          }));
          report.stamped += 1;
          await writeAudit(doc, auditTable, entry.id, 'BACKFILL_AR_STATUS_STAMP', {
            pass: entry.pass,
            arStatus: entry.arStatus,
            arStatusChangedAt: entry.arStatusChangedAt,
          });
        } catch (err) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
          // A stamp arrived between the plan and the apply — the Lambda's is newer.
          report.stampedAlreadyCurrent += 1;
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
    const plan = buildLegacyArPlan({ source, environment, suffix });
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

  const report = await applyLegacyArPlan({ doc, plan, suffix });
  console.log(JSON.stringify({ environment, suffix, ...report }, null, 2));
  if (report.failures.length > 0) process.exit(2);
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
