#!/usr/bin/env node
/**
 * Backfill Shipment / Order / LoadCarrier / LoadFinancials / LoadCharge rows from
 * the loads that already exist.
 *
 * Every legacy load becomes a one-leg shipment so the new board shows the same
 * freight the calendar does. The mapping itself lives in the tmsShipmentActions
 * Lambda — the new tables are Lambda-written, and a migration script is not an
 * exception to that. This script decides WHICH loads need backfilling, batches
 * them, records a reviewable plan, and reports what came back.
 *
 * Dry run is the default and writes nothing: it asks the Lambda to plan each batch
 * and prints the mapping it would apply. `--apply` runs the same batches for real
 * against an explicitly named non-production environment.
 *
 * Idempotent in both directions: a load that already carries a `shipmentId` is
 * skipped, and the rows are written under deterministic ids with conditional puts,
 * so an interrupted run can simply be run again.
 */

import { resolve } from 'node:path';
import { createTmsClient } from './lib/tmsClient.mjs';
import { authenticateTmsUser } from './lib/tmsAuth.mjs';
import { parseTmsArgs, loadAmplifyOutputs, detectMode } from './lib/tmsConfig.mjs';
import { createPlan, loadPlan, savePlan, validatePlan, summarize } from './lib/tmsPlan.mjs';

const USAGE = `
Usage: node scripts/backfillShipments.mjs [options]

Options:
  --help, -h        Show this offline help.
  --outputs <path>  Required: path to amplify_outputs.json (repo-root production file refused).
  --plan <path>     (dry-run) write plan file; (apply) read plan file.
  --env <target>    Required with --apply: test / sandbox / local. Production blocked.
  --apply           Apply the reviewed plan.
  --batch <n>       Loads per Lambda call (default 25, max 50).

Dry run asks the Lambda to plan every un-backfilled load and writes the result as a
JSON plan. Apply validates the plan's fingerprint, environment and endpoint, then
replays the same batches for real.
`;

/** The Lambda caps a batch at 50; 25 keeps a single call comfortably inside its timeout. */
export const DEFAULT_BATCH_SIZE = 25;
export const MAX_BATCH_SIZE = 50;

/**
 * Loads the board does not know about yet.
 * @param {any[]} loads
 * @returns {any[]}
 */
export function selectLoadsToBackfill(loads) {
  return loads
    .filter((l) => l && l.id && !l.shipmentId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * @param {any[]} items
 * @param {number} size
 * @returns {any[][]}
 */
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Count the mapping the Lambda proposed, so a reviewer can sanity-check the shape
 * of the migration without reading 890 rows.
 * @param {any[]} planned
 * @returns {Record<string, Record<string, number>>}
 */
export function tallyPlanned(planned) {
  const byLoadStatus = {};
  const byShipmentStatus = {};
  const byArStatus = {};
  const byAssignment = {};
  for (const p of planned) {
    byLoadStatus[p.loadStatus] = (byLoadStatus[p.loadStatus] ?? 0) + 1;
    byShipmentStatus[p.shipmentStatus] = (byShipmentStatus[p.shipmentStatus] ?? 0) + 1;
    byArStatus[p.arStatus] = (byArStatus[p.arStatus] ?? 0) + 1;
    byAssignment[p.assignmentType] = (byAssignment[p.assignmentType] ?? 0) + 1;
  }
  return { byLoadStatus, byShipmentStatus, byArStatus, byAssignment };
}

const LOAD_FIELDS = `
  id aljexId customer customerId shipmentId orderId
  rate readyToInvoice truckId trailerNumber
  originCity destinationCity pickupAppt deliveryAppt
  pickupDriverId deliveryDriverId stops
  createdAt updatedAt
`;

/**
 * @param {number | string | undefined} value
 * @returns {number}
 */
export function resolveBatchSize(value) {
  if (value == null || value === '') return DEFAULT_BATCH_SIZE;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) {
    throw new Error(`--batch must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
  return n;
}

/**
 * The source fingerprint: every candidate load and the version of it that was read.
 * A load edited between plan and apply invalidates the plan.
 * @param {any[]} candidates
 * @returns {Array<Record<string, unknown>>}
 */
function sourceRowsOf(candidates) {
  return candidates.map((l) => ({ loadId: String(l.id), updatedAt: String(l.updatedAt ?? '') }));
}

/**
 * @param {object} opts
 * @param {any} opts.client
 * @param {string} opts.env
 * @param {string} opts.endpoint
 * @param {number} [opts.batchSize]
 */
export async function buildShipmentPlan({ client, env, endpoint, batchSize = DEFAULT_BATCH_SIZE }) {
  const loads = await client.listLoads({ fields: LOAD_FIELDS });
  const candidates = selectLoadsToBackfill(loads);
  const batches = chunk(candidates.map((l) => String(l.id)), batchSize);

  const planned = [];
  const unresolved = [];
  for (const loadIds of batches) {
    const report = await client.tmsShipmentActions('BACKFILL_SHIPMENT', { loadIds, dryRun: true });
    planned.push(...(report?.planned ?? []));
    for (const id of report?.missing ?? []) {
      unresolved.push({ loadId: id, reason: 'LOAD_NOT_FOUND' });
    }
  }

  return createPlan({
    environment: env,
    endpoint,
    sourceType: 'Load (no shipmentId)',
    sourceRows: sourceRowsOf(candidates),
    actions: batches.map((loadIds) => ({
      action: 'BACKFILL_SHIPMENT',
      purpose: 'Create Shipment/Order/LoadCarrier/LoadFinancials/LoadCharge and link the load',
      input: { loadIds },
    })),
    reviewables: [],
    unresolved,
    summary: {
      totalLoads: loads.length,
      toBackfill: candidates.length,
      alreadyLinked: loads.length - candidates.length,
      batches: batches.length,
      ...tallyPlanned(planned),
    },
  });
}

/**
 * Execute a reviewed backfill plan.
 * @param {object} opts
 * @param {any} opts.client
 * @param {string} opts.planPath
 * @param {string} opts.env
 * @param {string} opts.endpoint
 */
export async function applyShipmentPlan({ client, planPath, env, endpoint }) {
  const plan = loadPlan(planPath);

  const loads = await client.listLoads({ fields: LOAD_FIELDS });
  validatePlan(plan, { environment: env, endpoint, sourceRows: sourceRowsOf(selectLoadsToBackfill(loads)) });

  let applied = 0;
  const skipped = [];
  const missing = [];
  const conflicts = [];

  for (const entry of plan.actions) {
    if (entry.action !== 'BACKFILL_SHIPMENT') continue;
    try {
      const report = await client.tmsShipmentActions('BACKFILL_SHIPMENT', {
        loadIds: entry.input.loadIds,
        dryRun: false,
      });
      applied += report?.applied ?? 0;
      skipped.push(...(report?.skipped ?? []));
      missing.push(...(report?.missing ?? []));
    } catch (err) {
      conflicts.push({ loadIds: entry.input.loadIds, error: err.message });
    }
  }

  return { environment: env, planPath, applied, skipped, missing, conflicts };
}

async function main() {
  const args = parseTmsArgs({ batch: { type: 'string' } });
  if (args.values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const { mode, env } = detectMode(args.values.apply, args.values.env);
  const outputs = loadAmplifyOutputs(args.values.outputs);
  const endpoint = outputs?.data?.url;
  if (!endpoint) {
    throw new Error('amplify_outputs.json missing data.url');
  }

  const auth = await authenticateTmsUser(outputs);
  const client = createTmsClient({ endpoint: auth.endpoint, token: auth.token });

  if (mode === 'dry-run') {
    const plan = await buildShipmentPlan({
      client,
      env,
      endpoint,
      batchSize: resolveBatchSize(args.values.batch),
    });
    const planPath = args.values.plan;
    if (planPath) {
      savePlan(plan, resolve(process.cwd(), planPath));
      console.log(`Plan written to ${planPath}`);
      console.log(summarize(plan));
      console.log(JSON.stringify(plan.summary, null, 2));
    } else {
      console.log(JSON.stringify(plan, null, 2));
    }
    process.exit(0);
  }

  if (!args.values.plan) {
    throw new Error('--plan <path> is required when applying');
  }
  const report = await applyShipmentPlan({
    client,
    planPath: resolve(process.cwd(), args.values.plan),
    env,
    endpoint,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.conflicts.length > 0) {
    process.exit(2);
  }
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
