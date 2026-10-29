#!/usr/bin/env node
/**
 * Backfill Customer directory rows from distinct Load.customer values.
 *
 * Phase 1 migration workflow:
 * - Reads all loads (paginated) and all customers (paginated).
 * - Normalises every distinct `Load.customer` string.
 * - Matches against existing Customers by server-computed `normalizedName` using
 *   exact unique matching. Ambiguous or unmatched rows are routed to review.
 * - Build a dry-run plan file with source fingerprints and environment.
 * - Apply mode executes the plan through `tmsDirectoryActions` only against an
 *   explicit non-production environment.
 *
 * No automatic inference: Batory customers are flagged for reviewer approval.
 * The original `Load.customer` text is preserved; only `customerId` is added.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeCustomerName,
  pickCanonicalName,
  buildAliases,
} from './lib/tmsNormalize.mjs';
import { createTmsClient } from './lib/tmsClient.mjs';
import { authenticateTmsUser } from './lib/tmsAuth.mjs';
import {
  parseTmsArgs,
  loadAmplifyOutputs,
  detectMode,
} from './lib/tmsConfig.mjs';
import { createPlan, loadPlan, savePlan, validatePlan, summarize } from './lib/tmsPlan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const USAGE = `
Usage: node scripts/backfillCustomers.mjs [options]

Options:
  --help, -h        Show this offline help.
  --outputs <path>  Required: path to amplify_outputs.json (repo-root production file refused).
  --plan <path>     (dry-run) write plan file; (apply) read plan file.
  --env <target>    Required with --apply: test / sandbox / local. Production blocked.
  --apply           Apply the reviewed plan.
  --link-only       Create no customer: link loads to the customers that exist and
                    report every name that has none, with its load count.

Dry-run writes a JSON plan of proposed creates and load updates. A load that already
carries a customerId is counted and left alone.
Apply validates the plan's fingerprint, environment, and endpoint, then executes via AppSync.
`;


/**
 * @param {any[]} loads
 * @returns {Map<string, {normalizedName: string, canonicalName: string, variants: Set<string>, loadIds: Set<string>}>}
 */
export function extractCustomerSources(loads) {
  /** @type {Map<string, any>} */
  const sources = new Map();
  for (const load of loads) {
    if (!load.customer) continue;
    const raw = String(load.customer).trim();
    if (!raw) continue;
    const normalizedName = normalizeCustomerName(raw);
    if (!normalizedName) continue;
    if (!sources.has(normalizedName)) {
      sources.set(normalizedName, {
        normalizedName,
        variants: new Set(),
        loadIds: new Set(),
      });
    }
    const src = sources.get(normalizedName);
    src.variants.add(raw);
    src.loadIds.add(load.id);
  }
  return sources;
}

/**
 * @param {Map<string, any>} sources
 * @param {any[]} existingCustomers
 * @returns {{actions: any[], reviewables: any[], unresolved: any[]}}
 */
export function planCustomerActions(sources, existingCustomers) {
  const actions = [];
  const reviewables = [];
  const unresolved = [];

  // Index existing customers by normalized name.
  /** @type {Map<string, any[]>} */
  const byNormalized = new Map();
  for (const c of existingCustomers) {
    // Always the script's own normalization: the server's normalizedName uses a different rule.
    const key = normalizeCustomerName(c.name);
    if (!key) continue;
    const arr = byNormalized.get(key) ?? [];
    arr.push(c);
    byNormalized.set(key, arr);
  }

  const sorted = [...sources.values()].sort((a, b) =>
    a.normalizedName.localeCompare(b.normalizedName)
  );

  for (const src of sorted) {
    const canonicalName = pickCanonicalName([...src.variants]);
    const aliases = buildAliases(canonicalName, [...src.variants]);
    const matches = byNormalized.get(src.normalizedName) ?? [];
    const activeMatches = matches.filter((c) => c.active !== false && !c.mergedIntoId);

    if (activeMatches.length > 1) {
      reviewables.push({
        kind: 'AMBIGUOUS_CUSTOMER',
        reason: `Multiple active customers match normalized name "${src.normalizedName}"`,
        source: {
          normalizedName: src.normalizedName,
          variants: [...src.variants],
          matches: activeMatches.map((c) => ({ id: c.id, name: c.name })),
        },
      });
      continue;
    }

    const matched = activeMatches[0];
    const isBatory = /batory/i.test(src.normalizedName) || /batory/i.test(canonicalName);

    if (!matched) {
      const action = {
        action: 'UPSERT_CUSTOMER',
        purpose: 'create-customer-from-loads',
        customerKey: src.normalizedName,
        input: {
          name: canonicalName,
          aliases,
          active: true,
          // apptWorkflow is never inferred; reviewer must approve Batory mapping.
        },
      };
      actions.push(action);
    }

    if (isBatory) {
      reviewables.push({
        kind: 'BATORY_WORKFLOW_REVIEW',
        reason: 'Batory mapping requires explicit reviewer approval before apptWorkflow is set',
        source: {
          normalizedName: src.normalizedName,
          matchedCustomerId: matched?.id ?? null,
          proposedWorkflow: 'BATORY',
        },
      });
    }
  }

  return { actions, reviewables, unresolved };
}

/**
 * Build updateLoad actions for every load whose customer normalized name resolves.
 * A load that already carries a `customerId` is the record of an earlier run or of a
 * person's choice, and is left alone either way.
 * @param {any[]} loads
 * @param {any[]} existingCustomers
 * @param {Map<string, any>} sourcesFromPlan
 * @returns {{updates: any[], alreadyLinked: number}}
 */
export function planLoadCustomerUpdates(loads, existingCustomers, sourcesFromPlan) {
  /** @type {Map<string, string>} */
  const customerIdByNormalized = new Map();
  for (const c of existingCustomers) {
    const key = normalizeCustomerName(c.name);
    if (!key) continue;
    // Only map unique active matches; ambiguous entries were excluded.
    if (!customerIdByNormalized.has(key) && c.active !== false && !c.mergedIntoId) {
      customerIdByNormalized.set(key, c.id);
    }
  }

  const updates = [];
  let alreadyLinked = 0;
  for (const load of loads) {
    const raw = String(load.customer ?? '').trim();
    if (!raw) continue;
    const normalizedName = normalizeCustomerName(raw);
    if (!normalizedName) continue;
    if (!sourcesFromPlan.has(normalizedName)) continue;
    if (typeof load.customerId === 'string' && load.customerId) {
      alreadyLinked += 1;
      continue;
    }

    const existingId = customerIdByNormalized.get(normalizedName);
    const source = sourcesFromPlan.get(normalizedName);
    const isAmbiguous = source.isAmbiguous;
    if (isAmbiguous) {
      continue;
    }

    updates.push({
      action: 'updateLoad',
      purpose: 'set-customer-id',
      loadId: load.id,
      customerKey: normalizedName,
      input: {
        id: load.id,
        customerId: existingId ?? null, // resolved from UPSERT result when null
      },
      condition: {
        updatedAt: { eq: load.updatedAt },
      },
    });
  }
  return { updates, alreadyLinked };
}

/**
 * @param {object} opts
 * @param {any} opts.client
 * @param {string} opts.env
 * @param {string} opts.endpoint
 * @param {boolean} [opts.linkOnly] Create no customer: a name with no row is reported, not minted.
 */
export async function buildCustomerPlan({ client, env, endpoint, linkOnly = false }) {
  const [loads, customers] = await Promise.all([
    client.listLoads(),
    client.listCustomers(),
  ]);

  const sources = extractCustomerSources(loads);
  const { actions, reviewables, unresolved } = planCustomerActions(sources, customers);

  // Mark ambiguous sources so load updates skip them.
  for (const r of reviewables) {
    if (r.kind === 'AMBIGUOUS_CUSTOMER') {
      const src = sources.get(r.source.normalizedName);
      if (src) src.isAmbiguous = true;
    }
  }

  const { updates: loadUpdates, alreadyLinked } = planLoadCustomerUpdates(loads, customers, sources);
  let directoryActions = actions.filter((a) => a.action === 'UPSERT_CUSTOMER');
  let loadActions = loadUpdates.map((u) => ({
    action: u.action,
    purpose: u.purpose,
    loadId: u.loadId,
    customerKey: u.customerKey,
    input: u.input,
    condition: u.condition,
  }));
  if (linkOnly) {
    // A load whose customer has no row cannot be linked without inventing one: it is
    // counted against its name and left exactly as it is.
    const unmatchedLoads = new Map();
    for (const u of loadActions) {
      if (u.input.customerId) continue;
      unmatchedLoads.set(u.customerKey, (unmatchedLoads.get(u.customerKey) ?? 0) + 1);
    }
    for (const a of directoryActions) {
      unresolved.push({
        kind: 'NO_CUSTOMER_MATCH',
        normalizedName: a.customerKey,
        name: a.input.name,
        loadCount: unmatchedLoads.get(a.customerKey) ?? 0,
        reason: 'link-only: no active customer carries this name and none is created',
      });
    }
    directoryActions = [];
    loadActions = loadActions.filter((u) => u.input.customerId);
  }

  const sourceRows = [...sources.values()].map((src) => ({
    normalizedName: src.normalizedName,
    loadCount: src.loadIds.size,
    variants: [...src.variants].sort(),
  }));

  return createPlan({
    environment: env,
    endpoint,
    sourceType: 'Load.customer',
    sourceRows,
    actions: [...directoryActions, ...loadActions],
    reviewables,
    unresolved,
    summary: {
      distinctCustomers: sourceRows.length,
      newCustomers: directoryActions.length,
      loadsToUpdate: loadActions.length,
      loadsAlreadyLinked: alreadyLinked,
      unmatchedNames: unresolved.filter((u) => u.kind === 'NO_CUSTOMER_MATCH').length,
      unmatchedLoads: unresolved.filter((u) => u.kind === 'NO_CUSTOMER_MATCH').reduce((n, u) => n + u.loadCount, 0),
      ambiguous: reviewables.filter((r) => r.kind === 'AMBIGUOUS_CUSTOMER').length,
      batoryToReview: reviewables.filter((r) => r.kind === 'BATORY_WORKFLOW_REVIEW').length,
    },
  });
}

/**
 * Execute a reviewed customer backfill plan.
 * @param {object} opts
 * @param {any} opts.client
 * @param {string} opts.planPath
 * @param {string} opts.env
 * @param {string} opts.endpoint
 */
export async function applyCustomerPlan({ client, planPath, env, endpoint }) {
  const plan = loadPlan(planPath);

  const loads = await client.listLoads();
  const sources = extractCustomerSources(loads);
  const sourceRows = [...sources.values()].map((src) => ({
    normalizedName: src.normalizedName,
    loadCount: src.loadIds.size,
    variants: [...src.variants].sort(),
  }));

  validatePlan(plan, { environment: env, endpoint, sourceRows });

  /** @type {Map<string, string>} */
  const customerIdByKey = new Map();
  const applied = [];
  const conflicts = [];
  const skipped = [];

  // First pass: directory creates/updates.
  for (const entry of plan.actions) {
    if (entry.action !== 'UPSERT_CUSTOMER') continue;
    try {
      const result = await client.tmsDirectoryActions('UPSERT_CUSTOMER', entry.input);
      customerIdByKey.set(entry.customerKey, result.id);
      applied.push({ action: entry.action, key: entry.customerKey, id: result.id, updatedAt: result.updatedAt });
    } catch (err) {
      conflicts.push({ action: entry.action, key: entry.customerKey, error: err.message });
    }
  }

  // Second pass: load updates via generated updateLoad mutation with CAS condition.
  for (const entry of plan.actions) {
    if (entry.action !== 'updateLoad') continue;
    const resolvedId = entry.input.customerId ?? customerIdByKey.get(entry.customerKey);
    if (!resolvedId) {
      skipped.push({ action: entry.action, loadId: entry.loadId, reason: `no customer id resolved for ${entry.customerKey}` });
      continue;
    }
    const input = { ...entry.input, customerId: resolvedId };
    try {
      const result = await client.updateLoad(input, entry.condition);
      applied.push({ action: entry.action, loadId: entry.loadId, id: result.id, updatedAt: result.updatedAt });
    } catch (err) {
      conflicts.push({ action: entry.action, loadId: entry.loadId, error: err.message });
    }
  }

  return {
    environment: env,
    planPath,
    applied: applied.length,
    conflicts,
    skipped,
    appliedDetails: applied,
  };
}

async function main() {
  const args = parseTmsArgs({ 'link-only': { type: 'boolean', default: false } });
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

  const linkOnly = args.values['link-only'] === true;
  if (mode === 'dry-run') {
    const auth = await authenticateTmsUser(outputs);
    const client = createTmsClient({ endpoint: auth.endpoint, token: auth.token });
    const plan = await buildCustomerPlan({ client, env, endpoint, linkOnly });
    const planPath = args.values.plan;
    if (planPath) {
      savePlan(plan, resolve(process.cwd(), planPath));
      console.log(`Plan written to ${planPath}`);
      console.log(summarize(plan));
    } else {
      console.log(JSON.stringify(plan, null, 2));
    }
    process.exit(0);
  }

  // apply mode
  if (!args.values.plan) {
    throw new Error('--plan <path> is required when applying');
  }
  const auth = await authenticateTmsUser(outputs);
  const client = createTmsClient({ endpoint: auth.endpoint, token: auth.token });
  const report = await applyCustomerPlan({
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
