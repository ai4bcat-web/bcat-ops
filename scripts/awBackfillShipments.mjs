#!/usr/bin/env node
/**
 * Step AW stage C, slice C2: link existing Loads to Shipments, PRO first, Load id as the fallback.
 *
 *   BCAT_STACK=rehearsal node scripts/awBackfillShipments.mjs [--out imports/runs/<job>] [--export-keys pros.txt]
 *   node scripts/awBackfillShipments.mjs --suffix <tableSuffix> --outputs <amplify_outputs.json> [--apply]
 *
 * What it does
 *   1. Reads Load / Shipment / ProClaim / TmsSettings of ONE explicit non-production stack (DynamoDB scans,
 *      projected to ids, PRO, dates and link fields only: nothing sensitive is ever read).
 *   2. Keeps the Loads inside the history window. THE CUTOFF MEANS BOOKED: Aljex is final as of the cutoff, so a Load
 *      created before it but shipping on/after it is CARRIED (it is Monday's work) and stays in the window. The window
 *      is the ship date (first pickup, else delivery, else creation) on or after (cutoff - 24 months), with NO upper
 *      bound; a Load before the lower bound is counted (`beforeWindow`) and left alone. Of the Loads kept, those that
 *      ship on/after the cutoff are counted as `carriedOver` (informational). A Load CREATED on or after the cutoff
 *      (`Load.createdAt` day >= cutoff; without createdAt: ship date >= cutoff) is `afterCutoff`: it is NOT classified or
 *      linked, and it is a STOP condition (exit code 3 here, runner afterCutoff=0): it was booked after Aljex was final.
 *      The cutoff is `--cutoff YYYY-MM-DD`, else `TmsSettings.aljexCutoffAt` (Chicago day), else 2026-11-07.
 *   3. Classifies every in-window Load with `classifyLinkCandidates` (src/lib/shipmentLink.ts):
 *        matched-by-PRO     PRO is in the Aljex export (`--export-keys`, one PRO per line): the importer LINKs it
 *        linked-by-ID       no Shipment by PRO: BACKFILL_SHIPMENT links/creates it by Load id (a Load with no PRO
 *                           gets its Shipment created by that same path)
 *        ambiguous          needs Ryne: PRO resolves to several Shipments, an unlinked Shipment already carries it,
 *                           two Loads share it, or its ProClaim is held by another Load. Never guessed.
 *        unmappable         the backfill planner refuses it (voided target, ...)
 *        already linked     Load.shipmentId is set: nothing to do (what makes a re-run a no-op)
 *      The backfill refusals come from a BACKFILL_SHIPMENT dry run (`--outputs`); without `--outputs` they are not
 *      evaluated and the report says so.
 *   4. DRY RUN (default) writes nothing to any table. It prints the Markdown report and, with `--out <dir>`, writes
 *      `link-report.md`, `link-report.csv` (Load id, PRO key, bucket, reason: no names, no values) and
 *      `link-summary.json`.
 *   5. `--apply` performs link adds ONLY, for the linked-by-ID bucket, through the tmsShipmentActions
 *      BACKFILL_SHIPMENT action (deterministic ids, conditional writes). It never edits or deletes a Load row
 *      itself, and matched-by-PRO Loads are left to the importer's LINK. It then re-reads the tables and reports
 *      what is left; a second run changes nothing.
 *
 * Target safety: the stack must be named (`BCAT_STACK=dev|rehearsal` via scripts/lib/stackConfig.mjs, or
 * `--suffix`). The production suffix is refused outright. `--apply` additionally needs `--outputs` whose AppSync
 * URL is the selected stack's, so the Lambda and the tables read are guaranteed to be the same stack.
 *
 * Options: --suffix --region --cutoff --export-keys --out --outputs --batch --apply --help
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { register } from 'node:module';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createTmsClient } from './lib/tmsClient.mjs';
import { authenticateTmsUser } from './lib/tmsAuth.mjs';
import { parseTmsArgs, loadAmplifyOutputs } from './lib/tmsConfig.mjs';
import { PRODUCTION, STACK, STACK_ENV } from './lib/stackConfig.mjs';
import { chunk, resolveBatchSize } from './backfillShipments.mjs';
// Node strips the types at run time: the script classifies with exactly the code the importer uses.
register('./lib/tsExtensionlessHooks.mjs', import.meta.url);
const { classifyLinkCandidates, linkReportCsv, linkReportMarkdown } = await import('../src/lib/shipmentLink.ts');
import { normalizePro } from '../src/lib/proNumber.ts';

/** The Aljex cutoff when neither --cutoff nor TmsSettings.aljexCutoffAt is set (same value as DEFAULT_ALJEX_CUTOFF). */
const DEFAULT_ALJEX_CUTOFF = '2026-11-07';

/** Add whole months to a YYYY-MM-DD, day clamped to the month length. */
function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export const REGION_DEFAULT = 'us-east-1';
export const HISTORY_MONTHS = 24;
const PRODUCTION_FRAGMENT = PRODUCTION.apiId;

const USAGE = `
Usage: node scripts/awBackfillShipments.mjs [options]   (BCAT_STACK=dev|rehearsal or --suffix is REQUIRED)

  --suffix <s>        DynamoDB table suffix. The production suffix is refused.
  --region <r>        AWS region (default ${REGION_DEFAULT}).
  --cutoff <date>     YYYY-MM-DD cutoff (default TmsSettings.aljexCutoffAt, else ${DEFAULT_ALJEX_CUTOFF}).
  --export-keys <f>   PROs in the Aljex export being linked (one per line; a CSV's first column). Without it every
                      unlinked Load without a Shipment falls to the ID fallback.
  --outputs <path>    amplify_outputs.json of the SAME non-production stack: evaluates the backfill refusals on the
                      dry run and is REQUIRED for --apply.
  --out <dir>         write link-report.md, link-report.csv, link-summary.json there.
  --batch <n>         Loads per Lambda call (default 25, max 50).
  --apply             Link the linked-by-ID bucket via BACKFILL_SHIPMENT. Default is a dry run that writes nothing.
`;

// ── target ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The explicit non-production target. Refuses production and any run that names no stack.
 * @param {{suffix?: string, env?: Record<string, string | undefined>, stack?: {tableSuffix: string, apiUrl: string, name: string}}} opts
 * @returns {{suffix: string, environment: string, apiUrl: string | null}}
 */
export function resolveTarget({ suffix, env = process.env, stack = STACK } = {}) {
  const named = env[STACK_ENV];
  const s = (suffix ?? (named ? stack.tableSuffix : '')).trim();
  if (!s) throw new Error(`Name the target: ${STACK_ENV}=dev|rehearsal or --suffix <tableSuffix>`);
  if (s.includes(PRODUCTION_FRAGMENT)) throw new Error(`Refusing to run against production tables (${s})`);
  const isSelected = s === stack.tableSuffix;
  return { suffix: s, environment: isSelected ? stack.name : s, apiUrl: isSelected ? stack.apiUrl : null };
}

/**
 * --apply writes through the stack's Lambda, so the outputs file must be that stack's.
 * @param {{apiUrl: string | null}} target
 * @param {any} outputs
 */
export function assertOutputsMatch(target, outputs) {
  const url = outputs?.data?.url;
  if (!url) throw new Error('amplify_outputs.json missing data.url');
  if (!target.apiUrl) throw new Error(`--apply needs the selected stack (${STACK_ENV}=dev|rehearsal) so its API can be verified; --suffix alone is read-only`);
  if (url !== target.apiUrl) throw new Error('--outputs is not the API of the selected stack: refusing');
}

// ── pure core ────────────────────────────────────────────────────────────────────────────────────

/** The Chicago calendar day of an instant (aljexCutoffAt is 00:00 America/Chicago). */
function chicagoDay(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

/**
 * @param {{cutoff?: string, settings?: any}} opts
 * @returns {string} YYYY-MM-DD
 */
export function resolveCutoff({ cutoff, settings } = {}) {
  if (cutoff) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error('--cutoff must be YYYY-MM-DD');
    return cutoff;
  }
  const at = typeof settings?.aljexCutoffAt === 'string' && settings.aljexCutoffAt ? chicagoDay(settings.aljexCutoffAt) : null;
  return at ?? DEFAULT_ALJEX_CUTOFF;
}

/** The YYYY-MM-DD prefix of an ISO date/time, else null. */
function dayOf(v) {
  const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(v) : null;
  return m ? m[1] : null;
}

/** Ship date of a Load as YYYY-MM-DD: first pickup appointment, else delivery appointment, else creation. */
export function loadShipDate(load) {
  for (const v of [load.pickupAppt, load.deliveryAppt, load.createdAt]) {
    const d = dayOf(v);
    if (d) return d;
  }
  return null;
}

/**
 * Split Loads by the history window: ship date on or after (cutoff - 24 months), no upper bound (the cutoff means
 * BOOKED). Order: ship date before the lower bound = beforeWindow; created on or after the cutoff (createdAt day, else
 * the ship date when there is no createdAt) = afterCutoff (STOP, not classified); everything else is inWindow, and
 * those whose ship date is on/after the cutoff are also listed in carriedOver. An undated Load is kept.
 * @param {any[]} loads
 * @param {string} cutoff
 */
export function partitionByWindow(loads, cutoff) {
  const start = addMonths(cutoff, -HISTORY_MONTHS);
  const inWindow = [];
  const beforeWindow = [];
  const afterCutoff = [];
  const carriedOver = [];
  for (const l of loads) {
    const d = loadShipDate(l);
    const created = dayOf(l.createdAt);
    if (d && d < start) beforeWindow.push(l);
    else if (created ? created >= cutoff : d && d >= cutoff) afterCutoff.push(l);
    else {
      inWindow.push(l);
      if (d && d >= cutoff) carriedOver.push(l);
    }
  }
  return { inWindow, beforeWindow, afterCutoff, carriedOver, windowStart: start };
}

/**
 * @param {string} text one PRO per line (a CSV: its first column)
 * @returns {Set<string>} PRO keys
 */
export function parseExportKeys(text) {
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const k = normalizePro(line.split(',')[0].replace(/^"|"$/g, ''));
    if (k) keys.add(k);
  }
  return keys;
}

/**
 * Classify the target's Loads.
 * @param {{source: {Load: any[], Shipment: any[], ProClaim: any[], settings?: any}, cutoff: string, exportKeys?: Set<string>, backfillSkips?: Map<string, string>}} opts
 */
export function buildLinkReport({ source, cutoff, exportKeys = new Set(), backfillSkips }) {
  const win = partitionByWindow(source.Load, cutoff);
  const report = classifyLinkCandidates({
    loads: win.inWindow.map((l) => ({ id: String(l.id), aljexId: l.aljexId ?? null, shipmentId: l.shipmentId ?? null })),
    shipments: source.Shipment.map((s) => ({ id: String(s.id), number: s.number ?? null, loadIds: s.loadIds ?? null })),
    claims: source.ProClaim.map((c) => ({ id: String(c.id), loadId: String(c.loadId ?? '') })),
    exportKeys,
    backfillSkips,
  });
  return { report, window: { start: win.windowStart, cutoff, outOfWindow: { beforeWindow: win.beforeWindow.length, afterCutoff: win.afterCutoff.length }, carriedOver: win.carriedOver.length, totalLoads: source.Load.length } };
}

/**
 * Loads that need the backfill planner's opinion: in-window, unlinked.
 * @param {any[]} loads
 * @param {string} cutoff
 */
export function loadsToEvaluate(loads, cutoff) {
  return partitionByWindow(loads, cutoff).inWindow.filter((l) => !l.shipmentId).map((l) => String(l.id)).sort();
}

/** Markdown: the link report plus the window block. */
export function renderMarkdown({ report, window }, { skipsEvaluated }) {
  const w = window.outOfWindow;
  return [
    linkReportMarkdown(report),
    '',
    `## History window`,
    `- Window: ship date on or after ${window.start}, no upper bound (the cutoff ${window.cutoff} means BOOKED). Loads in the table: ${window.totalLoads}; before the window: ${w.beforeWindow}; carried over (booked before the cutoff, shipping on/after it, classified above): ${window.carriedOver}; created on or after the cutoff (STOP, not classified): ${w.afterCutoff}; classified above: ${report.counts.loads}.`,
    skipsEvaluated ? '- Backfill refusals evaluated with a BACKFILL_SHIPMENT dry run.' : '- Backfill refusals NOT evaluated (no --outputs): unmappable may be under-reported.',
    '',
  ].join('\n');
}

// ── Lambda ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Ask BACKFILL_SHIPMENT (dry run) which Loads it would refuse.
 * @returns {Promise<Map<string, string>>} loadId -> reason (ALREADY_LINKED excluded)
 */
export async function collectBackfillSkips({ client, loadIds, batchSize }) {
  const skips = new Map();
  for (const ids of chunk(loadIds, batchSize)) {
    const r = await client.tmsShipmentActions('BACKFILL_SHIPMENT', { loadIds: ids, dryRun: true });
    for (const s of r?.skipped ?? []) if (s.reason !== 'ALREADY_LINKED') skips.set(String(s.loadId), String(s.reason));
    for (const id of r?.missing ?? []) skips.set(String(id), 'LOAD_NOT_FOUND');
  }
  return skips;
}

/**
 * Link the linked-by-ID bucket through BACKFILL_SHIPMENT. Never touches the Load table itself.
 * @returns {Promise<{applied: number, skipped: any[], missing: string[], conflicts: any[]}>}
 */
export async function applyLinks({ client, loadIds, batchSize }) {
  const out = { applied: 0, skipped: [], missing: [], conflicts: [] };
  for (const ids of chunk(loadIds, batchSize)) {
    try {
      const r = await client.tmsShipmentActions('BACKFILL_SHIPMENT', { loadIds: ids, dryRun: false });
      out.applied += r?.applied ?? 0;
      out.skipped.push(...(r?.skipped ?? []));
      out.missing.push(...(r?.missing ?? []));
    } catch (err) {
      out.conflicts.push({ loadIds: ids, error: err.message });
    }
  }
  return out;
}

// ── read ─────────────────────────────────────────────────────────────────────────────────────────

const PROJECTIONS = {
  Load: { expr: 'id, aljexId, shipmentId, pickupAppt, deliveryAppt, createdAt' },
  Shipment: { expr: 'id, #n, loadIds', names: { '#n': 'number' } },
  ProClaim: { expr: 'id, loadId' },
  TmsSettings: { expr: 'id, aljexCutoffAt' },
};

async function scanAll(doc, model, suffix) {
  const TableName = `${model}-${suffix}`;
  const { expr, names } = PROJECTIONS[model];
  const items = [];
  let startKey;
  do {
    try {
      const page = await doc.send(new ScanCommand({ TableName, ProjectionExpression: expr, ExpressionAttributeNames: names, ExclusiveStartKey: startKey }));
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } catch (err) {
      if (err?.name === 'ResourceNotFoundException') throw new Error(`Table ${TableName} does not exist: is this stack's schema deployed?`);
      throw err;
    }
  } while (startKey);
  return items;
}

/** @returns {Promise<{Load: any[], Shipment: any[], ProClaim: any[], settings: any}>} */
export async function readSource(doc, suffix) {
  const [Load, Shipment, ProClaim, settingsRows] = await Promise.all(['Load', 'Shipment', 'ProClaim', 'TmsSettings'].map((m) => scanAll(doc, m, suffix)));
  return { Load, Shipment, ProClaim, settings: settingsRows.find((r) => r.id === 'default') ?? null };
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * One end-to-end run against injected dependencies (the CLI wires real ones, the tests fakes).
 * @param {{read: () => Promise<any>, client?: any, apply?: boolean, cutoff?: string, exportKeys?: Set<string>, batchSize?: number}} deps
 */
export async function run({ read, client, apply = false, cutoff, exportKeys = new Set(), batchSize = 25 }) {
  if (apply && !client) throw new Error('--apply needs a Lambda client (--outputs)');
  const source = await read();
  const cut = resolveCutoff({ cutoff, settings: source.settings });
  const skips = client ? await collectBackfillSkips({ client, loadIds: loadsToEvaluate(source.Load, cut), batchSize }) : undefined;
  const before = buildLinkReport({ source, cutoff: cut, exportKeys, backfillSkips: skips });
  const result = { cutoff: cut, skipsEvaluated: Boolean(client), before, applied: null, after: null };
  if (!apply) return result;

  result.applied = await applyLinks({ client, loadIds: before.report.linkedById.map((e) => e.loadId), batchSize });
  const reread = await read();
  const skipsAfter = new Map(skips);
  for (const s of result.applied.skipped) if (s.reason !== 'ALREADY_LINKED') skipsAfter.set(String(s.loadId), String(s.reason));
  result.after = buildLinkReport({ source: reread, cutoff: cut, exportKeys, backfillSkips: skipsAfter });
  return result;
}

/** What goes to stdout / link-summary.json: counts only, no rows. */
export function summaryOf(result) {
  const c = (r) => r.report.counts;
  return { cutoff: result.cutoff, windowStart: result.before.window.start, outOfWindow: result.before.window.outOfWindow, carriedOver: result.before.window.carriedOver, before: c(result.before), applied: result.applied && { applied: result.applied.applied, skipped: result.applied.skipped.length, missing: result.applied.missing.length, conflicts: result.applied.conflicts.length }, after: result.after && c(result.after) };
}

/**
 * The STOP condition: Loads created on or after the cutoff were booked after Aljex was final and are never classified.
 * @returns {string | null} the message, or null when there is none
 */
export function stopReason(result) {
  const n = result.before.window.outOfWindow.afterCutoff;
  return n > 0 ? `STOP: ${n} Load(s) were created on or after the cutoff ${result.cutoff} (booked after Aljex was final); they are NOT linked: report to Ryne.` : null;
}

async function main() {
  const args = parseTmsArgs({ suffix: { type: 'string' }, region: { type: 'string' }, cutoff: { type: 'string' }, 'export-keys': { type: 'string' }, out: { type: 'string' }, batch: { type: 'string' } });
  const v = args.values;
  if (v.help) {
    console.log(USAGE);
    return;
  }
  const target = resolveTarget({ suffix: v.suffix });
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: v.region ?? REGION_DEFAULT }), { marshallOptions: { removeUndefinedValues: true } });
  let client;
  if (v.outputs) {
    const outputs = loadAmplifyOutputs(v.outputs);
    if (v.apply) assertOutputsMatch(target, outputs);
    const auth = await authenticateTmsUser(outputs);
    client = createTmsClient({ endpoint: auth.endpoint, token: auth.token });
  } else if (v.apply) {
    throw new Error('--apply needs --outputs <amplify_outputs.json> of the selected stack');
  }
  const exportKeys = v['export-keys'] ? parseExportKeys(readFileSync(resolve(process.cwd(), v['export-keys']), 'utf8')) : new Set();

  const result = await run({ read: () => readSource(doc, target.suffix), client, apply: Boolean(v.apply), cutoff: v.cutoff, exportKeys, batchSize: resolveBatchSize(v.batch) });
  const md = renderMarkdown(result.before, { skipsEvaluated: result.skipsEvaluated });
  console.log(`Target: ${target.environment} (${target.suffix}); ${v.apply ? 'APPLY' : 'DRY RUN (nothing written)'}\n`);
  console.log(md);
  if (v.out) {
    const dir = resolve(process.cwd(), v.out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'link-report.md'), md);
    writeFileSync(resolve(dir, 'link-report.csv'), linkReportCsv(result.before.report));
    writeFileSync(resolve(dir, 'link-summary.json'), JSON.stringify(summaryOf(result), null, 2));
    console.log(`Report written to ${v.out}`);
  }
  if (v.apply) {
    console.log(JSON.stringify(summaryOf(result), null, 2));
    if (result.applied.conflicts.length > 0) process.exit(2);
  }
  if (stopReason(result)) {
    console.error(stopReason(result));
    process.exitCode = 3;
  }
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
