#!/usr/bin/env node
/**
 * Seed revenue Division and TmsSettings rows from operator-reviewed JSON.
 *
 * Phase 1 migration workflow:
 * - Reads an operator-supplied JSON file (`--input`) containing divisions and
 *   optional global settings.
 * - Validates each row: skips empty or unknown values. No business values are
 *   guessed by the script.
 * - Builds a dry-run plan file tied to the input fingerprint and environment.
 * - Apply mode executes SAVE_DIVISION / SAVE_SETTINGS actions through
 *   tmsDirectoryActions only against an explicit non-production target.
 *
 * Money values use decimal strings, not floats, when present (seeded divisions
 * and settings contain no money fields today; the rule is enforced here for any
 * future additions).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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
Usage: node scripts/seedDivisions.mjs --input <json-file> --outputs <path> [options]

Options:
  --input <path>    Operator-reviewed JSON file (required).
  --outputs <path>  Required: path to amplify_outputs.json (repo-root production file refused).
  --plan <path>     (dry-run) write plan file; (apply) read plan file.
  --env <target>    Required with --apply: test / sandbox / local. Production blocked.
  --apply           Apply the reviewed plan.

Input JSON schema:
  {
    "divisions": [
      { "key": "BCAT_LOGISTICS", "name": "BCAT Logistics", "active": true, ... }
    ],
    "settings": { "id": "default", ... }
  }
`;

const KNOWN_FLEET_GROUPS = new Set(['LOCAL', 'AMAZON', 'BOX_TRUCK']);
const DIVISION_FIELDS = new Set([
  'id',
  'key',
  'name',
  'legalName',
  'mcNumber',
  'dotNumber',
  'scac',
  'remitToName',
  'remitToAddress',
  'remitToEmail',
  'invoicePrefix',
  'fleetGroup',
  'active',
]);

const SETTINGS_FIELDS = new Set([
  'id',
  'marginFloorBps',
  'defaultPaymentTermsDays',
  'accessorialCodes',
  'loadStatusRules',
  'invoiceNumberFormat',
]);

/**
 * @param {string} path
 * @returns {{divisions: any[], settings?: any}}
 */
export function readSeedInput(path) {
  const text = readFileSync(resolve(process.cwd(), path), 'utf8');
  const parsed = JSON.parse(text);
  return {
    divisions: Array.isArray(parsed.divisions) ? parsed.divisions : [],
    settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : undefined,
  };
}

/**
 * @param {any} row
 * @param {number} index
 * @returns {{valid: boolean, cleaned?: any, errors: string[]}}
 */
export function validateDivisionRow(row, index) {
  if (!row || typeof row !== 'object') {
    return { valid: false, errors: [`row ${index} is not an object`] };
  }
  const errors = [];
  const key = typeof row.key === 'string' ? row.key.trim() : '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  const active = typeof row.active === 'boolean' ? row.active : undefined;

  if (!key) errors.push('key is missing/empty');
  if (!name) errors.push('name is missing/empty');
  if (active === undefined) errors.push('active is missing');
  if (key && (/^unknown$/i.test(key) || /^unk$/i.test(key))) {
    errors.push('key is unknown/placeholder');
  }
  if (row.fleetGroup && !KNOWN_FLEET_GROUPS.has(row.fleetGroup)) {
    errors.push(`unknown fleetGroup "${row.fleetGroup}"`);
  }
  if (row.remitToAddress !== undefined && row.remitToAddress !== null) {
    if (typeof row.remitToAddress !== 'object' || Array.isArray(row.remitToAddress)) {
      errors.push('remitToAddress must be an address object {street,city,state,zip,country}');
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  // Keep only known fields so the script never invents values.
  const cleaned = { id: key, key, name, active };
  for (const field of DIVISION_FIELDS) {
    if (field === 'id' || field === 'key' || field === 'name' || field === 'active') continue;
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
      cleaned[field] = row[field];
    }
  }

  return { valid: true, cleaned, errors: [] };
}

/**
 * @param {any} settings
 * @returns {{valid: boolean, cleaned?: any, errors: string[]}}
 */
export function validateSettingsRow(settings) {
  if (!settings || typeof settings !== 'object') {
    return { valid: false, errors: ['settings is not an object'] };
  }
  if (Array.isArray(settings)) {
    return { valid: false, errors: ['settings must be an object, not an array'] };
  }
  const errors = [];
  const id = typeof settings.id === 'string' ? settings.id.trim() : '';
  const known = {};
  for (const field of SETTINGS_FIELDS) {
    if (settings[field] !== undefined && settings[field] !== null && settings[field] !== '') {
      known[field] = settings[field];
    }
  }
  const unknown = Object.keys(settings).filter((k) => k !== 'id' && !SETTINGS_FIELDS.has(k));
  if (unknown.length > 0) errors.push(`unknown settings fields: ${unknown.join(', ')}`);
  if (known.accessorialCodes !== undefined && !Array.isArray(known.accessorialCodes)) {
    errors.push('accessorialCodes must be an array of strings');
  }
  if (known.loadStatusRules !== undefined && typeof known.loadStatusRules !== 'object') {
    errors.push('loadStatusRules must be an object');
  }
  if (known.marginFloorBps !== undefined && (typeof known.marginFloorBps !== 'number' || !Number.isInteger(known.marginFloorBps))) {
    errors.push('marginFloorBps must be an integer');
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, cleaned: { ...known, id: id || 'default' }, errors: [] };
}

/**
 * @param {object} opts
 * @param {string} opts.inputPath
 * @param {string} opts.env
 * @param {string} opts.endpoint
 */
export function buildDivisionPlan({ inputPath, env, endpoint }) {
  const { divisions, settings } = readSeedInput(inputPath);
  const actions = [];
  const reviewables = [];
  const skipped = [];
  const validRows = [];

  for (let i = 0; i < divisions.length; i++) {
    const row = divisions[i];
    const { valid, cleaned, errors } = validateDivisionRow(row, i);
    if (!valid) {
      skipped.push({ index: i, row, reason: errors.join('; ') });
      continue;
    }
    validRows.push(cleaned);
    actions.push({
      action: 'SAVE_DIVISION',
      purpose: 'seed-division',
      divisionKey: cleaned.key,
      input: cleaned,
    });
  }

  if (settings) {
    const { valid, cleaned, errors } = validateSettingsRow(settings);
    if (!valid) {
      skipped.push({ index: -1, row: settings, reason: errors.join('; ') });
    } else {
      actions.push({
        action: 'SAVE_SETTINGS',
        purpose: 'seed-settings',
        input: cleaned,
      });
    }
  }

  if (validRows.length === 0) {
    reviewables.push({
      kind: 'EMPTY_SEED',
      reason: 'No valid divisions found after validation; operator-reviewed input may be empty or unknown',
      source: { input: inputPath, skipped },
    });
  }

  const sourceRows = validRows.map((r) => ({ key: r.key, name: r.name, active: r.active }));

  return createPlan({
    environment: env,
    endpoint,
    sourceType: 'operator-reviewed-division-json',
    sourceRows,
    actions,
    reviewables,
    unresolved: skipped,
    summary: {
      divisions: validRows.length,
      skipped: skipped.length,
      settings: actions.some((a) => a.action === 'SAVE_SETTINGS'),
    },
  });
}

/**
 * @param {object} opts
 * @param {any} opts.client
 * @param {string} opts.planPath
 * @param {string} opts.inputPath
 * @param {string} opts.env
 * @param {string} opts.endpoint
 */
export async function applyDivisionPlan({ client, planPath, inputPath, env, endpoint }) {
  const plan = loadPlan(planPath);
  const { divisions, settings } = readSeedInput(inputPath);
  void settings;
  const validRows = [];
  for (let i = 0; i < divisions.length; i++) {
    const { valid, cleaned } = validateDivisionRow(divisions[i], i);
    if (valid) validRows.push(cleaned);
  }
  const sourceRows = validRows.map((r) => ({ key: r.key, name: r.name, active: r.active }));
  validatePlan(plan, { environment: env, endpoint, sourceRows });

  // Fetch existing records so re-runs use CAS without manual expectedUpdatedAt.
  // A read failure must surface as a failure, not as "every row is new".
  const [existingDivisions, existingSettings] = await Promise.all([
    client.listDivisions({ fields: 'id key updatedAt' }),
    client.getTmsSettings('default'),
  ]);
  const divisionMap = new Map(existingDivisions.map((d) => [d.key, d]));

  const applied = [];
  const conflicts = [];

  for (const entry of plan.actions) {
    try {
      let input = entry.input;
      if (entry.action === 'SAVE_DIVISION' && entry.divisionKey && divisionMap.has(entry.divisionKey)) {
        input = { ...input, expectedUpdatedAt: divisionMap.get(entry.divisionKey).updatedAt };
      }
      if (entry.action === 'SAVE_SETTINGS' && existingSettings?.updatedAt) {
        input = { ...input, expectedUpdatedAt: existingSettings.updatedAt };
      }
      const result = await client.tmsDirectoryActions(entry.action, input);
      applied.push({ action: entry.action, key: entry.divisionKey ?? entry.input?.id, id: result.id, updatedAt: result.updatedAt });
    } catch (err) {
      conflicts.push({ action: entry.action, key: entry.divisionKey ?? entry.input?.id, error: err.message });
    }
  }

  return {
    environment: env,
    planPath,
    inputPath,
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

  if (!args.values.input) {
    throw new Error('--input <path> is required');
  }

  const { mode, env } = detectMode(args.values.apply, args.values.env);
  const inputPath = resolve(process.cwd(), args.values.input);
  const outputs = loadAmplifyOutputs(args.values.outputs);
  const endpoint = outputs?.data?.url;
  if (!endpoint) {
    throw new Error('amplify_outputs.json missing data.url');
  }

  if (mode === 'dry-run') {
    const plan = buildDivisionPlan({ inputPath, env, endpoint });
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
  const report = await applyDivisionPlan({
    client,
    planPath: resolve(process.cwd(), args.values.plan),
    inputPath,
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
