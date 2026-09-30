#!/usr/bin/env node
/**
 * Backfill Location directory links onto Load stops.
 *
 * Phase 1 migration workflow:
 * - Reads all loads (paginated) and all locations (paginated).
 * - Extracts distinct `(stop.name, stop.city)` from every stop (real stops or
 *   legacy-synthesised stops).
 * - Matches against existing Locations by normalised name + normalised city using
 *   exact unique matching. No coordinates or addresses are fabricated; unmatched
 *   rows are reported for manual review.
 * - Builds a dry-run plan file tied to a source fingerprint, environment, and AppSync endpoint.
 * - Apply mode executes the generated updateLoad mutation with a CAS condition on
 *   updatedAt, re-serialising the stops JSON and re-deriving legacy mirrors server-side.
 *
 * Stop JSON is preserved in full: proofs, appointment workflow state, mirrors,
 * and legacy-derived pickup/delivery fields stay intact.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeLocationName,
  normalizeCity,
} from './lib/tmsNormalize.mjs';
import { getStops, deriveLegacyFields } from './lib/tmsStops.mjs';
import { createTmsClient } from './lib/tmsClient.mjs';
import { authenticateTmsUser } from './lib/tmsAuth.mjs';
import {
  parseTmsArgs,
  loadAmplifyOutputs,
  detectMode,
} from './lib/tmsConfig.mjs';
import {
  createPlan,
  loadPlan,
  savePlan,
  validatePlan,
  summarize,
} from './lib/tmsPlan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const USAGE = `
Usage: node scripts/backfillLocations.mjs [options]

Options:
  --help, -h        Show this offline help.
  --outputs <path>  Required: path to amplify_outputs.json (repo-root production file refused).
  --plan <path>     (dry-run) write plan file; (apply) read plan file.
  --env <target>    Required with --apply: test / sandbox / local. Production blocked.
  --apply           Apply the reviewed plan.

Dry-run writes a JSON plan of location matches and load stop updates.
Apply validates the plan's fingerprint, environment, and endpoint, then executes
via the generated updateLoad mutation with condition { updatedAt: { eq: ... } }.
`;

/**
 * @param {any[]} loads
 * @returns {Map<string, any>}
 */
export function extractLocationSources(loads) {
  const sources = new Map();
  let linkedSkipped = 0;
  for (const load of loads) {
    const stops = getStops(load);
    for (const stop of stops) {
      // An existing link is authoritative. Repointing after a merge belongs to the
      // merge job (MERGE_LOCATIONS / RESUME_MERGE), never to this backfill, so a stop
      // that is already linked is not a source — even if its target was since merged.
      if (typeof stop.locationId === 'string' && stop.locationId) { linkedSkipped++; continue; }
      const rawName = String(stop.name ?? '').trim();
      const rawCity = String(stop.city ?? '').trim();
      if (!rawName && !rawCity) continue;
      const normalizedName = normalizeLocationName(rawName);
      const normalizedCity = normalizeCity(rawCity);
      if (!normalizedName && !normalizedCity) continue;
      const key = `${normalizedName}|${normalizedCity}`;
      if (!sources.has(key)) {
        sources.set(key, {
          key,
          normalizedName,
          normalizedCity,
          variants: new Map(),
          stopEntries: [],
          loadIds: new Set(),
        });
      }
      const src = sources.get(key);
      const variantKey = `${rawName}|${rawCity}`;
      src.variants.set(variantKey, (src.variants.get(variantKey) ?? 0) + 1);
      src.stopEntries.push({
        loadId: load.id,
        stopId: stop.id,
        loadUpdatedAt: load.updatedAt,
        originalStop: stop,
        originalLoad: load,
      });
      src.loadIds.add(load.id);
    }
  }
  return { sources, linkedSkipped };
}

/**
 * @param {any} location
 * @returns {Record<string, string | undefined>}
 */
function buildAddressSnapshot(location) {
  // Never fabricate coordinates. Plain textual evidence only.
  return {
    name: location.name,
    street: location.street,
    city: location.city,
    state: location.state,
    zip: location.zip,
    country: location.country,
    timezone: location.timezone,
  };
}

/**
 * @param {Map<string, any>} sources
 * @param {any[]} existingLocations
 * @returns {{actions: any[], reviewables: any[], unresolved: any[]}}
 */
export function planLocationActions(sources, existingLocations) {
  // Index active, non-merged locations by normalised name + city.
  const byKey = new Map();
  for (const loc of existingLocations) {
    const name = normalizeLocationName(loc.name); // script's own rule, not the server's normalizedName
    const city = normalizeCity(loc.city);
    const key = `${name}|${city}`;
    const arr = byKey.get(key) ?? [];
    if (loc.active !== false && !loc.mergedIntoId) {
      arr.push(loc);
      byKey.set(key, arr);
    }
  }

  const actions = [];
  const reviewables = [];
  const unresolved = [];
  const sorted = [...sources.values()].sort((a, b) => a.key.localeCompare(b.key));

  /** @type {Map<string, any[]>} */
  const updatesByLoad = new Map();

  for (const src of sorted) {
    const variants = Object.fromEntries(src.variants.entries());
    const matches = byKey.get(src.key) ?? [];

    if (matches.length === 0) {
      unresolved.push({
        kind: 'UNRESOLVED_LOCATION',
        reason: 'No existing Location matches the normalised stop facility/city',
        source: {
          key: src.key,
          stopCount: src.stopEntries.length,
          variants,
        },
      });
      continue;
    }

    if (matches.length > 1) {
      reviewables.push({
        kind: 'AMBIGUOUS_LOCATION',
        reason: `Multiple active locations match key "${src.key}"`,
        source: {
          key: src.key,
          variants,
          matches: matches.map((l) => ({ id: l.id, name: l.name, city: l.city })),
        },
      });
      continue;
    }

    const location = matches[0];
    const addressSnapshot = buildAddressSnapshot(location);

    for (const entry of src.stopEntries) {
      if (!updatesByLoad.has(entry.loadId)) updatesByLoad.set(entry.loadId, []);
      updatesByLoad.get(entry.loadId).push({ entry, location, addressSnapshot });
    }
  }

  for (const loadId of [...updatesByLoad.keys()].sort()) {
    const entries = updatesByLoad.get(loadId);
    const representative = entries[0].entry;
    const load = representative.originalLoad;
    const stops = getStops(load).map((s) => ({ ...s }));

    for (const { entry, location, addressSnapshot } of entries) {
      const existing = stops.find((s) => s.id === entry.stopId);
      if (!existing) {
        throw new Error(`Stop ${entry.stopId} not found for load ${loadId} during plan build`);
      }
      Object.assign(existing, { locationId: location.id, address: addressSnapshot });
    }

    const reordered = stops.map((s, i) => ({ ...s, sequence: i }));
    const legacyFields = deriveLegacyFields(reordered);

    actions.push({
      action: 'updateLoad',
      purpose: 'set-stop-location-ids',
      loadId,
      input: {
        id: loadId,
        stops: reordered,
        ...legacyFields,
      },
      condition: {
        updatedAt: { eq: representative.loadUpdatedAt },
      },
    });
  }

  return { actions, reviewables, unresolved };
}

/**
 * @param {object} opts
 * @param {any} opts.client
 * @param {string} opts.env
 * @param {string} opts.endpoint
 */
export async function buildLocationPlan({ client, env, endpoint }) {
  const [loads, locations] = await Promise.all([
    client.listLoads(),
    client.listLocations(),
  ]);

  const { sources, linkedSkipped } = extractLocationSources(loads);
  const { actions, reviewables, unresolved } = planLocationActions(sources, locations);

  const sourceRows = [...sources.values()].map((src) => ({
    key: src.key,
    normalizedName: src.normalizedName,
    normalizedCity: src.normalizedCity,
    stopCount: src.stopEntries.length,
    variants: Object.fromEntries(src.variants.entries()),
  }));

  return createPlan({
    environment: env,
    endpoint,
    sourceType: 'Load.stops',
    sourceRows,
    actions,
    reviewables,
    unresolved,
    summary: {
      distinctStopKeys: sourceRows.length,
      linkedStopsSkipped: linkedSkipped,
      loadsToUpdate: actions.length,
      unresolved: unresolved.length,
      ambiguous: reviewables.filter((r) => r.kind === 'AMBIGUOUS_LOCATION').length,
    },
  });
}

/**
 * @param {object} opts
 * @param {any} opts.client
 * @param {string} opts.planPath
 * @param {string} opts.env
 * @param {string} opts.endpoint
 */
export async function applyLocationPlan({ client, planPath, env, endpoint }) {
  const plan = loadPlan(planPath);
  const loads = await client.listLoads();
  const { sources } = extractLocationSources(loads);
  const sourceRows = [...sources.values()].map((src) => ({
    key: src.key,
    normalizedName: src.normalizedName,
    normalizedCity: src.normalizedCity,
    stopCount: src.stopEntries.length,
    variants: Object.fromEntries(src.variants.entries()),
  }));
  validatePlan(plan, { environment: env, endpoint, sourceRows });

  const applied = [];
  const conflicts = [];

  for (const entry of plan.actions) {
    if (entry.action !== 'updateLoad') continue;
    try {
      const result = await client.updateLoad(entry.input, entry.condition);
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
    appliedDetails: applied,
  };
}

async function main() {
  const args = parseTmsArgs();
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

  if (mode === 'dry-run') {
    const auth = await authenticateTmsUser(outputs);
    const client = createTmsClient({ endpoint: auth.endpoint, token: auth.token });
    const plan = await buildLocationPlan({ client, env, endpoint });
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

  if (!args.values.plan) {
    throw new Error('--plan <path> is required when applying');
  }
  const auth = await authenticateTmsUser(outputs);
  const client = createTmsClient({ endpoint: auth.endpoint, token: auth.token });
  const report = await applyLocationPlan({
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
