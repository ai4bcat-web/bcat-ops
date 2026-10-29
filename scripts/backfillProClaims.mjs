#!/usr/bin/env node
/**
 * Claim every PRO the board already carries (Step R cutover).
 *
 * Step R makes a PRO permanent: one `ProClaim` row per PRO number ever issued, written
 * with a conditional put inside the shipment transaction, never released — not on a
 * rolled-back create and not on a void. That rule is only as good as the table it reads.
 * On a stack whose Load table predates the claim, the ProClaim table starts EMPTY, so
 * the first legacy edit or the first `BACKFILL_SHIPMENT` would find the PRO unclaimed,
 * take it, and the invariant would have a hole exactly where the history is.
 *
 * So this runs BEFORE enforcement can bite: one claim per PRO a Load already carries,
 * `origin: 'LEGACY'`.
 *
 *   - VOIDED LOADS ARE INCLUDED, and that is the entire point. A voided PRO stays
 *     claimed forever; leaving those rows out would hand a number that has already been
 *     on a bill of lading to the next shipment created.
 *   - Each claim is keyed by `normalizePro(load.aljexId)` — the app's single definition
 *     of PRO identity (`src/lib/proNumber.ts`), shared rather than restated. The live
 *     table stores PROs padded ('14547  ') and every resolver trims before comparing, so
 *     a raw key would claim a spelling the app does not recognise and still leave the
 *     real PRO free.
 *   - Writes are conditional puts on `attribute_not_exists(id)`, so a claim the router
 *     has since written wins and a re-run writes nothing.
 *
 * Nothing is invented and nothing is dropped silently:
 *
 *   - a load whose PRO normalizes to NOTHING (blank, whitespace-only, 'N/A', under three
 *     characters) is listed as UNCLAIMABLE and skipped — there is no key to claim, and
 *     making one up would claim a number nobody issued;
 *   - two loads whose PROs normalize to the SAME key are listed as a COLLISION naming
 *     every load id. The first wins the claim (lowest load id, so the report is stable)
 *     and the rest are printed for a person. They are not dropped and not merged: a
 *     duplicate PRO in the history is a fact about the data, and only a human can say
 *     which load should carry it.
 *
 * Dry run is the default and writes NOTHING: it reads both tables, prints the counts and
 * every unclaimable and contested row, and saves a plan file when `--plan` is given.
 * `--apply` replays that reviewed plan after checking the rows it was computed from have
 * not moved underneath it, then RE-PLANS off the table and prints that there is nothing
 * left to write.
 *
 * Two guards, because this script writes to DynamoDB directly (ProClaim is Lambda-written
 * by the schema and there is no action for a migration): the TABLE SUFFIX is checked
 * before a single read — the production suffix is refused outright — the `--outputs` file
 * may not be the repo-root (production) `amplify_outputs.json`, and the identity it signs
 * in with (`BCAT_EMAIL` / `BCAT_PASSWORD`) must be the owner or in the ADMIN group, which
 * is read off the id token's own claims rather than taken on trust.
 *
 *   node scripts/backfillProClaims.mjs --help
 *   node scripts/backfillProClaims.mjs --outputs dev_outputs.json --plan plans/r-pro-claims.json
 *   node scripts/backfillProClaims.mjs --outputs dev_outputs.json --apply --plan plans/r-pro-claims.json
 */

import { resolve } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { authenticateTmsUser } from './lib/tmsAuth.mjs';
import { parseTmsArgs, loadAmplifyOutputs } from './lib/tmsConfig.mjs';
import { createPlan, loadPlan, savePlan, validatePlan, summarize } from './lib/tmsPlan.mjs';
// Node strips the types at run time, so the script claims PROs under exactly the key the
// app and the Lambda use. A second copy of the normalizer would stay right for one release.
import { normalizePro } from '../src/lib/proNumber.ts';

export const REGION_DEFAULT = 'us-east-1';
/** The dev stack. Every write this script makes lands here unless --suffix says otherwise. */
export const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE';
/** Production. Present anywhere in a suffix, the run stops before a single read. */
export const PRODUCTION_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4';
/** Who the claim says did this. Not a person: a script, named so it can be found again. */
export const MIGRATION_USER = 'migration:backfillProClaims';
/** The `ProClaim.origin` rung that exists for exactly this: a PRO issued before the rule. */
export const CLAIM_ORIGIN = 'LEGACY';

/** The two identities the shipment router treats as admin (`handler.ts:259-260`). */
export const OWNER_EMAIL = 'ryne@bcatcorp.com';
export const ADMIN_GROUP = 'ADMIN';

const USAGE = `
Usage: node scripts/backfillProClaims.mjs [options]

Options:
  --help, -h        Show this offline help.
  --outputs <path>  Required: amplify_outputs.json for the DEV stack (the repo-root
                    production file is refused). Sign-in uses BCAT_EMAIL / BCAT_PASSWORD
                    and that identity must be the owner or in the ADMIN group.
  --suffix <s>      DynamoDB table suffix (default ${DEV_TABLE_SUFFIX});
                    the production suffix is refused.
  --region <r>      AWS region (default ${REGION_DEFAULT}).
  --plan <path>     (dry-run) write the plan file; (apply) read it back.
  --apply           Apply the reviewed plan.

CLAIM:       one ProClaim row per PRO a Load already carries, keyed by the normalized
             PRO and written under attribute_not_exists(id) with origin ${CLAIM_ORIGIN}.
             VOIDED LOADS ARE INCLUDED: a voided PRO stays claimed forever, which is the
             rule this backfill exists to make true for the history as well as the future.
UNCLAIMABLE: a load whose PRO is blank, whitespace-only, 'N/A' or shorter than three
             characters has no key to claim. It is listed and skipped; nothing is made up.
COLLISION:   two loads whose PROs normalize to the same key are listed with both load ids.
             The lowest load id takes the claim and the rest are reported for a person —
             a duplicate PRO in the history is a fact, not something a script may resolve.

Dry run reads the Load and ProClaim tables, prints all of it and writes nothing to AWS.
Apply re-reads the same tables, refuses a plan whose sources have changed, replays it,
and then re-plans off the table: a second plan has nothing left to write.
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
      `Refusing to run against production tables (${suffix}): this backfill claims every PRO ` +
        'on the board permanently and a claim is never released. Step R is a dev-only build. ' +
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

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Who the id token says this is. Read off the token's own claims because this script
 * writes to DynamoDB with IAM credentials and never calls a Lambda — nothing downstream
 * would refuse a non-admin, so the refusal has to happen here.
 *
 * @param {string} token a Cognito id token
 * @returns {{email: string | null, groups: string[], isAdmin: boolean}}
 */
export function identityOf(token) {
  const segments = String(token ?? '').split('.');
  if (segments.length < 2) throw new Error('Not a JWT: cannot tell who this run is');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Could not read the id token claims: cannot tell who this run is');
  }
  const email = text(claims.email);
  const raw = claims['cognito:groups'];
  const groups = Array.isArray(raw)
    ? raw.filter((g) => typeof g === 'string')
    : typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  // The same two tests the shipment router applies (`handler.ts:610`).
  return { email, groups, isAdmin: email === OWNER_EMAIL || groups.includes(ADMIN_GROUP) };
}

/**
 * @param {string} token
 * @returns {{email: string | null, groups: string[], isAdmin: boolean}}
 */
export function requireAdminIdentity(token) {
  const identity = identityOf(token);
  if (!identity.isAdmin) {
    throw new Error(
      `Forbidden: claiming every PRO on the board requires the owner or an ADMIN; ` +
        `${identity.email ?? 'this identity'} is in [${identity.groups.join(', ') || 'no groups'}]`
    );
  }
  return identity;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

/**
 * When the PRO was issued — the load's own creation, not the moment this migration ran.
 * The claim is a record of the number going out, and on dev that is years of history.
 * @param {Record<string, any>} load
 * @param {string} now
 * @returns {string}
 */
function claimedAtOf(load, now) {
  return text(load.createdAt) ?? now;
}

/**
 * Which PROs need claiming, which are already claimed, and which this script refuses to
 * decide. Pure: every AWS call happens above it.
 *
 * @param {object} input
 * @param {Array<Record<string, any>>} input.loads every Load row, VOIDED ONES INCLUDED
 * @param {Array<Record<string, any>>} input.claims the ProClaim rows that already exist
 * @param {string} input.now ISO timestamp, used only when a load carries no createdAt
 */
export function planProClaims({ loads = [], claims = [], now = new Date().toISOString() }) {
  const existing = new Map();
  for (const claim of claims) {
    const id = text(claim?.id);
    if (id) existing.set(id, claim);
  }

  // Lowest load id first, so which load wins a contested PRO is the same on every run
  // and a reviewer reading the plan twice sees the same answer.
  const ordered = loads
    .filter((load) => load && load.id != null)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  /** @type {Map<string, Record<string, any>>} the load that takes each PRO */
  const holders = new Map();
  /** @type {Map<string, Array<Record<string, any>>>} the loads that lost it */
  const contested = new Map();
  const unclaimable = [];
  let voidedLoads = 0;

  for (const load of ordered) {
    const voided = Boolean(load.voidedAt);
    if (voided) voidedLoads += 1;
    const pro = normalizePro(load.aljexId);
    const row = {
      loadId: String(load.id),
      aljexId: typeof load.aljexId === 'string' ? load.aljexId : null,
      shipmentId: text(load.shipmentId),
      voided,
    };
    if (!pro) {
      // No key exists to claim. Reported with the raw text so a person can see whether
      // it is a blank, an 'N/A' or a two-character stub.
      unclaimable.push(row);
      continue;
    }
    if (holders.has(pro)) {
      contested.set(pro, [...(contested.get(pro) ?? []), row]);
      continue;
    }
    holders.set(pro, load);
  }

  const actions = [];
  const alreadyClaimed = [];
  const collisions = [];

  for (const [pro, load] of holders) {
    const claim = existing.get(pro);
    const loadId = String(load.id);
    const holderLoadId = claim ? (text(claim.loadId) ?? loadId) : loadId;
    if (claim) {
      alreadyClaimed.push({ pro, loadId: holderLoadId });
    } else {
      actions.push({
        action: 'CLAIM_PRO',
        purpose: 'Claim a PRO the board already carries, so it can never be issued again',
        pro,
        loadId,
        shipmentId: text(load.shipmentId),
        voided: Boolean(load.voidedAt),
        claimedAt: claimedAtOf(load, now),
      });
    }
    // A claim already on the table under another load's id is a collision too: both the
    // row and this load believe they own the number, and only a person can say which.
    const rivals = [
      ...(contested.get(pro) ?? []),
      ...(claim && holderLoadId !== loadId
        ? [{ loadId, aljexId: typeof load.aljexId === 'string' ? load.aljexId : null, shipmentId: text(load.shipmentId), voided: Boolean(load.voidedAt) }]
        : []),
    ];
    if (rivals.length > 0) {
      collisions.push({
        pro,
        holderLoadId,
        holderIsExistingClaim: Boolean(claim),
        loadIds: [holderLoadId, ...rivals.map((r) => r.loadId)],
        contenders: rivals,
      });
    }
  }

  actions.sort((a, b) => a.pro.localeCompare(b.pro));
  alreadyClaimed.sort((a, b) => a.pro.localeCompare(b.pro));
  collisions.sort((a, b) => a.pro.localeCompare(b.pro));

  return {
    actions,
    alreadyClaimed,
    collisions,
    unclaimable,
    loadsScanned: ordered.length,
    voidedLoads,
  };
}

/**
 * Exactly the fields the pass reads, per row. `updatedAt` is deliberately NOT
 * fingerprinted: a dispatcher saving an ETA between plan and apply does not change which
 * PRO a load carries, and invalidating the plan for it would make this never applyable on
 * a live dev stack.
 * @param {{Load?: any[], ProClaim?: any[]}} source
 * @returns {Array<Record<string, unknown>>}
 */
export function sourceRowsOf(source) {
  const rows = [];
  for (const load of source.Load ?? []) {
    rows.push({
      model: 'Load',
      id: String(load.id),
      aljexId: load.aljexId ?? null,
      shipmentId: load.shipmentId ?? null,
      voidedAt: load.voidedAt ?? null,
      createdAt: load.createdAt ?? null,
    });
  }
  for (const claim of source.ProClaim ?? []) {
    rows.push({ model: 'ProClaim', id: String(claim.id), loadId: claim.loadId ?? null });
  }
  return rows;
}

/**
 * @param {object} input
 * @param {{Load?: any[], ProClaim?: any[]}} input.source
 * @param {string} input.environment
 * @param {string} input.suffix
 * @param {string} [input.now]
 */
export function buildProClaimPlan({ source, environment, suffix, now = new Date().toISOString() }) {
  const planned = planProClaims({ loads: source.Load ?? [], claims: source.ProClaim ?? [], now });

  return createPlan({
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceType: 'Load (every row, voided included) against ProClaim',
    sourceRows: sourceRowsOf(source),
    actions: planned.actions,
    reviewables: [
      ...planned.collisions.map((row) => ({
        kind: 'PRO_COLLISION',
        reason:
          `${row.loadIds.length} loads carry PRO ${row.pro}: ${row.loadIds.join(', ')}. ` +
          `${row.holderLoadId} ${row.holderIsExistingClaim ? 'already holds the claim' : 'takes the claim'}; ` +
          'the rest keep their PRO text and are reported — a duplicate PRO is a fact about the ' +
          'data and not something a migration may resolve',
        source: row,
      })),
      ...planned.unclaimable.map((row) => ({
        kind: 'PRO_UNCLAIMABLE',
        reason:
          `Load ${row.loadId} carries ${JSON.stringify(row.aljexId)} as its PRO, which normalizes ` +
          'to nothing; there is no key to claim and none is invented',
        source: row,
      })),
    ],
    unresolved: planned.unclaimable,
    summary: {
      loadsScanned: planned.loadsScanned,
      voidedLoads: planned.voidedLoads,
      claimsToWrite: planned.actions.length,
      alreadyClaimed: planned.alreadyClaimed.length,
      unclaimable: planned.unclaimable.length,
      collisions: planned.collisions.length,
      // Named one by one, not counted: each is a number somebody has to look at.
      unclaimableLoads: planned.unclaimable,
      collisionDetail: planned.collisions,
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
    `Loads scanned:                 ${s.loadsScanned}`,
    `    of them voided:            ${s.voidedLoads} (their PROs are claimed too — a voided PRO is never reissued)`,
    `Claims to write:               ${s.claimsToWrite}`,
    `Already claimed:               ${s.alreadyClaimed}`,
    `Unclaimable (no key):          ${s.unclaimable}`,
    `Collisions (need a person):    ${s.collisions}`,
    '',
  ];

  if (s.claimsToWrite === 0) {
    lines.push(
      'Nothing to write: every PRO on the Load table is already claimed. A second plan after',
      'an applied one reports exactly this.',
      ''
    );
  }

  const unclaimable = s.unclaimableLoads ?? [];
  lines.push(`Loads with no claimable PRO: ${unclaimable.length} — reported, never invented:`);
  if (unclaimable.length === 0) lines.push('    (none)');
  for (const row of unclaimable) {
    lines.push(
      `    ${row.loadId} — aljexId ${JSON.stringify(row.aljexId)}` +
        `${row.shipmentId ? ` on shipment ${row.shipmentId}` : ' (no shipment)'}` +
        `${row.voided ? ' [voided]' : ''}`
    );
  }

  const collisions = s.collisionDetail ?? [];
  lines.push(
    '',
    `PROs carried by more than one load: ${collisions.length} — the first takes the claim and`,
    '    the rest are printed. Nothing is merged and no load is changed:'
  );
  if (collisions.length === 0) lines.push('        (none — every PRO on the board is unique once normalized)');
  for (const row of collisions) {
    lines.push(
      `        ${row.pro}: ${row.loadIds.join(', ')} — claim goes to ${row.holderLoadId}` +
        `${row.holderIsExistingClaim ? ' (it already holds it)' : ''}`
    );
    for (const c of row.contenders) {
      lines.push(`            reported: ${c.loadId} — aljexId ${JSON.stringify(c.aljexId)}${c.voided ? ' [voided]' : ''}`);
    }
  }

  lines.push(
    '',
    'Nothing is deleted and no load is edited: this backfill only writes ProClaim rows.',
    'A claim is never released — not on a void, not on a rollback — so applying this is',
    'one-way by design.'
  );

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
 * Every Load row and every ProClaim row. The Load scan is deliberately unfiltered: a
 * voided load's PRO is exactly the one that must never come back.
 * @param {any} doc
 * @param {string} suffix
 * @returns {Promise<{Load: any[], ProClaim: any[]}>}
 */
export async function readSource(doc, suffix) {
  const [Load, ProClaim] = await Promise.all([
    scanAll(doc, `Load-${suffix}`),
    scanAll(doc, `ProClaim-${suffix}`),
  ]);
  return { Load, ProClaim };
}

// ── Apply ────────────────────────────────────────────────────────────────────

/**
 * Replay a reviewed plan. One conditional put per claim: a row the router has written
 * since the plan was built is the real claim and wins, which is what makes a re-run —
 * or a run that died half way — write nothing the second time.
 *
 * @param {object} input
 * @param {any} input.doc the DynamoDB document client
 * @param {import('./lib/tmsPlan.mjs').TmsPlan} input.plan
 * @param {string} input.suffix
 */
export async function applyProClaimPlan({ doc, plan, suffix }) {
  // The suffix was checked before the read; it is checked again here because this is the
  // function that writes, and it is exported for tests and for other callers.
  if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error(`Refusing to write PRO claims in production tables (${suffix})`);
  }
  const table = `ProClaim-${suffix}`;
  const report = { claimsWritten: 0, alreadyClaimed: 0, failures: [] };

  for (const entry of plan.actions) {
    try {
      if (entry.action !== 'CLAIM_PRO') throw new Error(`Unknown action ${entry.action}`);
      const now = new Date().toISOString();
      await doc.send(new PutCommand({
        TableName: table,
        // The whole rule, in one expression: a PRO is claimed once and never again.
        ConditionExpression: 'attribute_not_exists(id)',
        Item: {
          id: entry.pro,
          __typename: 'ProClaim',
          loadId: entry.loadId,
          // Omitted rather than NULL when the load belongs to no shipment yet: the
          // claim is about the number, and an absent attribute says so honestly.
          ...(entry.shipmentId ? { shipmentId: entry.shipmentId } : {}),
          claimedAt: entry.claimedAt,
          claimedBy: MIGRATION_USER,
          origin: CLAIM_ORIGIN,
          createdAt: now,
          updatedAt: now,
        },
      }));
      report.claimsWritten += 1;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        report.alreadyClaimed += 1;
        continue;
      }
      report.failures.push({ action: entry.action, pro: entry.pro ?? null, loadId: entry.loadId ?? null, error: err.message });
    }
  }

  return report;
}

/**
 * What the table says after the writes, worked out by re-planning off it rather than
 * assumed from the plan. `claimsToWrite` is zero on a successful apply, and that is the
 * line a reviewer checks.
 * @param {any} doc
 * @param {string} suffix
 */
export async function replanAfterApply(doc, suffix) {
  const source = await readSource(doc, suffix);
  const planned = planProClaims({ loads: source.Load, claims: source.ProClaim });
  return {
    loadsScanned: planned.loadsScanned,
    voidedLoads: planned.voidedLoads,
    claimsToWrite: planned.actions.length,
    alreadyClaimed: planned.alreadyClaimed.length,
    unclaimable: planned.unclaimable.length,
    collisions: planned.collisions.length,
  };
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
  const identity = requireAdminIdentity(auth.token);
  console.log(`signed in as ${identity.email ?? '(no email claim)'}`);

  const source = await readSource(doc, suffix);

  if (!args.values.apply) {
    const plan = buildProClaimPlan({ source, environment, suffix });
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

  const report = await applyProClaimPlan({ doc, plan, suffix });
  const after = await replanAfterApply(doc, suffix);
  console.log(JSON.stringify({ environment, suffix, ...report, after }, null, 2));
  if (after.claimsToWrite === 0) {
    console.log('\nRe-planned off the table: 0 claims left to write.');
  } else {
    console.log(`\nRe-planned off the table: ${after.claimsToWrite} claim(s) STILL to write — the apply did not finish.`);
  }
  if (report.failures.length > 0) process.exit(2);
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
