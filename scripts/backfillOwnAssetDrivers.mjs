#!/usr/bin/env node
/**
 * Ivan Cartage loads with no (usable) driver (Step W).
 *
 * An own-fleet load must carry a driver; the TMS now refuses to dispatch, deliver or
 * release one that does not. This script looks at the own-fleet loads that already
 * exist and does two things:
 *
 *   FIXES (apply), both of which change no pay input (pay reads Load.deliveryDriverId /
 *   deliveryAppt / rate and never a LoadCarrier):
 *     CREATE_LEG    an OWN_ASSET load with NO active leg whose Load already names a driver
 *                   (deliveryDriverId ?? pickupDriverId ?? first stop driver) gets an ACTIVE
 *                   OWN_ASSET LoadCarrier (name/phone from the roster) and
 *                   Load.activeLoadCarrierId. Nothing else on the Load is written: no driver,
 *                   date, rate or stops field, not even updatedAt.
 *     FILL_LEG_NAME an ACTIVE own leg that has a roster driver but a blank driverName gets
 *                   driverName/driverPhone, on the leg only.
 *
 *   REPORTS (never written, never guessed; fix them in the TMS with Assign driver):
 *     NO_DRIVER_ANYWHERE, PICKUP_STOP_NO_DRIVER, DRIVER_UNKNOWN / DRIVER_BROKER /
 *     DRIVER_INACTIVE, LEG_DRIVER_MISSING, LEG_KIND_MISMATCH; and info counts
 *     VOIDED_OR_CANCELED, SPLIT_RELAY, NEED_TO_COVER_WITH_DRIVER.
 *
 * Dry run is the default and writes NOTHING to AWS. `--plan` saves the plan, `--apply
 * --plan` replays it after checking the source rows have not moved. The environment is
 * read off the table suffix; the production suffix is refused before a single read.
 *
 *   node scripts/backfillOwnAssetDrivers.mjs --help
 *   node scripts/backfillOwnAssetDrivers.mjs --plan plans/w-own-asset-drivers.json --csv gaps.csv
 *   node scripts/backfillOwnAssetDrivers.mjs --apply --plan plans/w-own-asset-drivers.json
 */

import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { parseTmsArgs } from './lib/tmsConfig.mjs';
import { createPlan, loadPlan, savePlan, validatePlan, summarize, stableId } from './lib/tmsPlan.mjs';
import { getStops } from './lib/tmsStops.mjs';

export const REGION_DEFAULT = 'us-east-1';
/** The dev stack. Every write this script makes lands here unless --suffix says otherwise. */
export const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE';
/** Production. Present anywhere in a suffix, the run stops before a single read. */
export const PRODUCTION_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4';
export const MIGRATION_USER = 'migration:backfillOwnAssetDrivers';

export const CREATE_LEG = 'CREATE_LEG';
export const FILL_LEG_NAME = 'FILL_LEG_NAME';

const MODELS = ['Load', 'LoadCarrier', 'Driver', 'Shipment'];

const USAGE = `
Usage: node scripts/backfillOwnAssetDrivers.mjs [options]

Options:
  --help, -h          Show this offline help.
  --suffix <s>        DynamoDB table suffix (default ${DEV_TABLE_SUFFIX});
                      the production suffix is refused.
  --region <r>        AWS region (default ${REGION_DEFAULT}).
  --plan <path>       (dry-run) write the plan file; (apply) read it back.
  --apply             Apply the reviewed plan.
  --csv <path>        Write the gap/report list (what needs a person) as CSV.
  --only-load <id>    Restrict to this Load id (repeatable).

Fixes (apply):
  ${CREATE_LEG}      OWN_ASSET load with no active leg but a driver on the Load -> ACTIVE leg
                   + Load.activeLoadCarrierId. No driver/date/rate/stops field is written.
  ${FILL_LEG_NAME}  ACTIVE own leg with a roster driver but no driverName -> driverName/driverPhone.

Reported only: loads with no driver anywhere, no pickup-stop driver, unknown/broker/
inactive drivers. Voided/canceled loads are skipped; relays and brokered loads that carry
a driver are counted for information.

Dry run reads the tables and writes nothing to AWS.
`;

/**
 * @param {string | undefined} value
 * @returns {{suffix: string, environment: string}}
 */
export function resolveTarget(value) {
  const suffix = (value ?? process.env.TABLE_SUFFIX ?? DEV_TABLE_SUFFIX).trim();
  if (!suffix) throw new Error('--suffix <tableSuffix> cannot be empty');
  if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error(
      `Refusing to run against production tables (${suffix}): this backfill writes ` +
        'LoadCarrier rows and Load.activeLoadCarrierId, and Step W is a dev-only build. ' +
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

/** Same test as the TMS: a broker placeholder is not one of our drivers. */
function isBroker(driver) {
  return String(driver?.type ?? '').toLowerCase() === 'broker';
}

/** @param {Record<string, any>} load @returns {string[]} every non-blank driver on the stops, in order */
function stopDriverIds(load) {
  const ids = [];
  for (const s of getStops(load)) {
    const id = text(s?.driverId);
    if (id) ids.push(id);
  }
  return ids;
}

const isLive = (load) => !text(load.voidedAt) && load.status !== 'CANCELED';

// ── Plan ─────────────────────────────────────────────────────────────────────

/**
 * Pure. Classify every own-fleet load and plan the two safe fixes.
 * @param {Array<Record<string, any>>} loads
 * @param {Array<Record<string, any>>} legs
 * @param {Array<Record<string, any>>} drivers
 * @param {Array<Record<string, any>>} [shipments]
 */
export function planOwnAssetDrivers(loads, legs, drivers, shipments = []) {
  const driverById = new Map(drivers.map((d) => [String(d.id), d]));
  const shipmentById = new Map(shipments.map((s) => [String(s.id), s]));
  const legsByLoad = new Map();
  for (const leg of legs) {
    const list = legsByLoad.get(leg.loadId) ?? [];
    list.push(leg);
    legsByLoad.set(leg.loadId, list);
  }

  const actions = [];
  const report = [];
  const counts = {
    loads: loads.length,
    ownAssetLive: 0,
    VOIDED_OR_CANCELED: 0,
    NO_DRIVER_ANYWHERE: 0,
    LEG_MISSING: 0,
    LEG_NAME_MISSING: 0,
    PICKUP_STOP_NO_DRIVER: 0,
    SPLIT_RELAY: 0,
    NEED_TO_COVER_WITH_DRIVER: 0,
    DRIVER_PROBLEM: 0,
    LEG_DRIVER_MISSING: 0,
    LEG_KIND_MISMATCH: 0,
  };

  const note = (cls, severity, load, detail) => {
    const shipment = shipmentById.get(load.shipmentId);
    report.push({
      class: cls,
      severity,
      loadId: load.id,
      pro: load.aljexId ?? null,
      shipmentNumber: shipment?.number ?? load.loadNumber ?? null,
      status: load.status ?? null,
      pickupDate: typeof load.pickupAppt === 'string' ? load.pickupAppt.slice(0, 10) : null,
      customer: load.customer ?? null,
      detail,
    });
  };

  for (const load of loads) {
    const loadLegs = legsByLoad.get(load.id) ?? [];
    const activeLegs = loadLegs.filter((l) => l.status === 'ACTIVE');
    const activeLeg =
      activeLegs.find((l) => l.id === load.activeLoadCarrierId) ??
      [...activeLegs].sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0] ??
      null;
    const ownType = load.assignmentType === 'OWN_ASSET';
    const ownLeg = activeLeg?.kind === 'OWN_ASSET' ? activeLeg : null;
    const isOwn = ownType || ownLeg != null;

    if (!isOwn) {
      if (isLive(load) && text(load.deliveryDriverId)) counts.NEED_TO_COVER_WITH_DRIVER += 1;
      continue;
    }
    if (!isLive(load)) {
      counts.VOIDED_OR_CANCELED += 1;
      continue;
    }
    counts.ownAssetLive += 1;

    const stopIds = stopDriverIds(load);
    const pickupDriver = text(load.pickupDriverId);
    const deliveryDriver = text(load.deliveryDriverId);
    const legDriver = text(ownLeg?.driverId);
    const loadDriver = deliveryDriver ?? pickupDriver ?? stopIds[0] ?? null;

    if (!legDriver && !loadDriver) {
      counts.NO_DRIVER_ANYWHERE += 1;
      note('NO_DRIVER_ANYWHERE', 'fix', load, 'Ivan Cartage load with no driver on the leg, either mirror or any stop; use Assign driver in the TMS');
      continue;
    }

    // A driver that is not a usable roster row is reported; names are never invented.
    const problems = new Set();
    for (const id of [legDriver, deliveryDriver].filter(Boolean)) {
      const d = driverById.get(id);
      const cls = !d ? 'DRIVER_UNKNOWN' : isBroker(d) ? 'DRIVER_BROKER' : d.active === false ? 'DRIVER_INACTIVE' : null;
      if (cls && !problems.has(`${cls}:${id}`)) {
        problems.add(`${cls}:${id}`);
        counts.DRIVER_PROBLEM += 1;
        note(cls, 'fix', load, `driver ${id}${d?.name ? ` (${d.name})` : ''} is not a usable roster driver`);
      }
    }
    const usable = (id) => {
      const d = id ? driverById.get(id) : null;
      return d && !isBroker(d) && d.active !== false ? d : null;
    };

    if (deliveryDriver && !pickupDriver) {
      counts.PICKUP_STOP_NO_DRIVER += 1;
      note('PICKUP_STOP_NO_DRIVER', 'fix', load, 'delivery driver set but no pickup driver; left alone (pay does not read pickup)');
    }
    if (legDriver && deliveryDriver && legDriver !== deliveryDriver) {
      counts.SPLIT_RELAY += 1;
      note('SPLIT_RELAY', 'info', load, `relay: leg driver ${legDriver} -> delivery driver ${deliveryDriver}`);
    }

    if (activeLeg && !ownLeg) {
      counts.LEG_KIND_MISMATCH += 1;
      note('LEG_KIND_MISMATCH', 'fix', load, `assignmentType OWN_ASSET but the ACTIVE leg is ${activeLeg.kind}; left alone`);
      continue;
    }

    if (!ownLeg) {
      // OWN_ASSET with no active leg.
      counts.LEG_MISSING += 1;
      const d = usable(loadDriver);
      if (!d) continue; // reported above when it is the delivery driver; otherwise a pickup/stop-only driver
      if (!text(load.shipmentId)) {
        note('LEG_MISSING', 'fix', load, 'no shipmentId on the Load, so no leg can be created');
        continue;
      }
      const sequence = loadLegs.reduce((m, l) => Math.max(m, Number(l.sequence) || 0), 0) + 1;
      actions.push({
        action: CREATE_LEG,
        id: stableId('lcr-w', String(load.id)),
        loadId: load.id,
        before: { activeLoadCarrierId: load.activeLoadCarrierId ?? null },
        item: {
          loadId: load.id,
          shipmentId: load.shipmentId,
          kind: 'OWN_ASSET',
          status: 'ACTIVE',
          sequence,
          driverId: d.id,
          driverName: d.name ?? null,
          driverPhone: text(d.phone),
          truckId: text(load.truckId),
          trailerNumber: text(load.trailerNumber),
          carrierRateCents: 0,
          costCents: 0,
        },
      });
      continue;
    }

    if (!legDriver) {
      counts.LEG_DRIVER_MISSING += 1;
      note('LEG_DRIVER_MISSING', 'fix', load, `ACTIVE own leg ${ownLeg.id} has no driverId (the Load names ${loadDriver}); re-assign in the TMS`);
      continue;
    }

    if (!text(ownLeg.driverName)) {
      counts.LEG_NAME_MISSING += 1;
      const d = usable(legDriver);
      if (d && text(d.name)) {
        actions.push({
          action: FILL_LEG_NAME,
          id: ownLeg.id,
          loadId: load.id,
          driverId: legDriver,
          before: { driverName: ownLeg.driverName ?? null, driverPhone: ownLeg.driverPhone ?? null },
          after: { driverName: d.name, driverPhone: text(ownLeg.driverPhone) ?? text(d.phone) },
        });
      }
    }
  }

  return { actions, report, counts };
}

/**
 * Exactly the fields the planner reads. `updatedAt` is left out so a saved ETA does not
 * invalidate a reviewed plan.
 * @param {Record<string, any[]>} source
 */
export function sourceRowsOf(source) {
  const FIELDS = {
    Load: ['shipmentId', 'assignmentType', 'activeLoadCarrierId', 'status', 'voidedAt', 'pickupDriverId', 'deliveryDriverId', 'truckId', 'trailerNumber'],
    LoadCarrier: ['loadId', 'kind', 'status', 'sequence', 'driverId', 'driverName', 'driverPhone'],
    Driver: ['name', 'phone', 'active', 'type'],
  };
  const rows = [];
  for (const [model, fields] of Object.entries(FIELDS)) {
    for (const row of source[model] ?? []) {
      const entry = { model, id: String(row.id) };
      for (const field of fields) entry[field] = row[field] ?? null;
      if (model === 'Load') entry.stopDrivers = stopDriverIds(row);
      rows.push(entry);
    }
  }
  return rows;
}

/** Narrow a source to the given Load ids (and their legs); no ids = everything. */
export function scopeSource(source, onlyLoads) {
  if (!onlyLoads || onlyLoads.length === 0) return source;
  const ids = new Set(onlyLoads);
  return {
    ...source,
    Load: (source.Load ?? []).filter((l) => ids.has(l.id)),
    LoadCarrier: (source.LoadCarrier ?? []).filter((l) => ids.has(l.loadId)),
  };
}

/**
 * @param {object} input
 * @param {Record<string, any[]>} input.source
 * @param {string} input.environment
 * @param {string} input.suffix
 */
export function buildOwnAssetDriversPlan({ source, environment, suffix }) {
  const planned = planOwnAssetDrivers(source.Load ?? [], source.LoadCarrier ?? [], source.Driver ?? [], source.Shipment ?? []);
  return createPlan({
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceType: 'own-fleet Load + LoadCarrier + Driver (driver gaps)',
    sourceRows: sourceRowsOf(source),
    actions: planned.actions,
    reviewables: planned.report.filter((r) => r.severity === 'fix').map((r) => ({
      kind: r.class,
      reason: `${r.pro ?? r.loadId}: ${r.detail}`,
      source: r,
    })),
    unresolved: [],
    summary: { ...planned.counts, report: planned.report },
  });
}

/** @param {import('./lib/tmsPlan.mjs').TmsPlan} plan */
export function reviewText(plan) {
  const s = plan.summary;
  const reportCount = (cls) => s.report.filter((r) => r.class === cls).length;
  const lines = [
    summarize(plan),
    '',
    `Loads read:                    ${s.loads}`,
    `Live own-fleet loads:          ${s.ownAssetLive}`,
    '',
    `VOIDED_OR_CANCELED             ${s.VOIDED_OR_CANCELED}   (skipped)`,
    `NO_DRIVER_ANYWHERE             ${s.NO_DRIVER_ANYWHERE}   (report only)`,
    `LEG_MISSING                    ${s.LEG_MISSING}   (CREATE_LEG when the Load names a usable driver)`,
    `LEG_NAME_MISSING               ${s.LEG_NAME_MISSING}   (FILL_LEG_NAME)`,
    `PICKUP_STOP_NO_DRIVER          ${s.PICKUP_STOP_NO_DRIVER}   (report only)`,
    `SPLIT_RELAY                    ${s.SPLIT_RELAY}   (info)`,
    `NEED_TO_COVER_WITH_DRIVER      ${s.NEED_TO_COVER_WITH_DRIVER}   (info)`,
    `DRIVER_UNKNOWN/BROKER/INACTIVE ${s.DRIVER_PROBLEM}   (report only: ${reportCount('DRIVER_UNKNOWN')}/${reportCount('DRIVER_BROKER')}/${reportCount('DRIVER_INACTIVE')})`,
    `LEG_DRIVER_MISSING             ${s.LEG_DRIVER_MISSING}   (report only)`,
    `LEG_KIND_MISMATCH              ${s.LEG_KIND_MISMATCH}   (report only)`,
    '',
    `Planned writes: ${plan.actions.filter((a) => a.action === CREATE_LEG).length} ${CREATE_LEG}, ` +
      `${plan.actions.filter((a) => a.action === FILL_LEG_NAME).length} ${FILL_LEG_NAME}. No Load driver/date/rate/stops field is ever written.`,
  ];
  return lines.join('\n');
}

/** @param {Array<Record<string, any>>} report */
export function csvOf(report) {
  const cols = ['class', 'severity', 'pro', 'shipmentNumber', 'loadId', 'status', 'pickupDate', 'customer', 'detail'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...report.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

// ── Read ─────────────────────────────────────────────────────────────────────

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

export async function readSource(doc, suffix) {
  const entries = await Promise.all(MODELS.map(async (model) => [model, await scanAll(doc, `${model}-${suffix}`)]));
  return Object.fromEntries(entries);
}

// ── Apply ────────────────────────────────────────────────────────────────────

async function writeAudit(doc, table, entityId, action, changes) {
  const now = new Date().toISOString();
  try {
    await doc.send(new PutCommand({
      TableName: table,
      Item: {
        id: randomUUID(),
        __typename: 'AuditLog',
        entityType: 'LOAD_CARRIER',
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

const isConditionFailure = (err) =>
  err?.name === 'ConditionalCheckFailedException' || err?.name === 'TransactionCanceledException';

/**
 * @param {object} input
 * @param {any} input.doc
 * @param {import('./lib/tmsPlan.mjs').TmsPlan} input.plan
 * @param {string} input.suffix
 */
export async function applyOwnAssetDriversPlan({ doc, plan, suffix }) {
  const legTable = `LoadCarrier-${suffix}`;
  const loadTable = `Load-${suffix}`;
  const auditTable = `AuditLog-${suffix}`;
  const report = { legsCreated: 0, legsCreatedAlreadyCurrent: 0, namesFilled: 0, namesFilledAlreadyCurrent: 0, failures: [] };

  for (const entry of plan.actions) {
    try {
      if (entry.action === CREATE_LEG) {
        const now = new Date().toISOString();
        try {
          await doc.send(new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: legTable,
                  Item: { id: entry.id, __typename: 'LoadCarrier', ...entry.item, createdAt: now, updatedAt: now },
                  ConditionExpression: 'attribute_not_exists(id)',
                },
              },
              {
                Update: {
                  TableName: loadTable,
                  Key: { id: entry.loadId },
                  // Only the pointer. updatedAt and every driver/date/rate/stops field stay as they were.
                  UpdateExpression: 'SET activeLoadCarrierId = :leg',
                  ConditionExpression:
                    'attribute_exists(id) AND assignmentType = :own AND (attribute_not_exists(activeLoadCarrierId) OR activeLoadCarrierId = :null)',
                  ExpressionAttributeValues: { ':leg': entry.id, ':own': 'OWN_ASSET', ':null': null },
                },
              },
            ],
          }));
          report.legsCreated += 1;
          await writeAudit(doc, auditTable, entry.id, 'BACKFILL_OWN_ASSET_LEG', {
            loadId: entry.loadId,
            before: entry.before,
            after: { activeLoadCarrierId: entry.id, driverId: entry.item.driverId, driverName: entry.item.driverName },
          });
        } catch (err) {
          if (!isConditionFailure(err)) throw err;
          report.legsCreatedAlreadyCurrent += 1;
        }
        continue;
      }

      if (entry.action === FILL_LEG_NAME) {
        try {
          await doc.send(new UpdateCommand({
            TableName: legTable,
            Key: { id: entry.id },
            UpdateExpression: 'SET driverName = :name, driverPhone = :phone',
            ConditionExpression:
              'attribute_exists(id) AND kind = :own AND driverId = :driver AND (attribute_not_exists(driverName) OR driverName = :null OR driverName = :empty)',
            ExpressionAttributeValues: {
              ':name': entry.after.driverName,
              ':phone': entry.after.driverPhone,
              ':own': 'OWN_ASSET',
              ':driver': entry.driverId,
              ':null': null,
              ':empty': '',
            },
          }));
          report.namesFilled += 1;
          await writeAudit(doc, auditTable, entry.id, 'BACKFILL_OWN_ASSET_NAME', { before: entry.before, after: entry.after });
        } catch (err) {
          if (!isConditionFailure(err)) throw err;
          report.namesFilledAlreadyCurrent += 1;
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
  const args = parseTmsArgs({
    suffix: { type: 'string' },
    region: { type: 'string' },
    csv: { type: 'string' },
    'only-load': { type: 'string', multiple: true },
  });
  if (args.values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const { suffix, environment } = resolveTarget(args.values.suffix);
  const region = args.values.region ?? REGION_DEFAULT;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const source = scopeSource(await readSource(doc, suffix), args.values['only-load']);

  if (!args.values.apply) {
    const plan = buildOwnAssetDriversPlan({ source, environment, suffix });
    console.log(reviewText(plan));
    if (args.values.csv) {
      writeFileSync(resolve(process.cwd(), args.values.csv), csvOf(plan.summary.report), 'utf8');
      console.log(`\nGap list written to ${args.values.csv} (${plan.summary.report.length} rows)`);
    }
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

  const report = await applyOwnAssetDriversPlan({ doc, plan, suffix });
  console.log(JSON.stringify({ environment, suffix, ...report }, null, 2));
  if (report.failures.length > 0) process.exit(2);
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
