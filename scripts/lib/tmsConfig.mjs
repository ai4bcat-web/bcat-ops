/**
 * CLI argument parsing and environment resolution for TMS migration scripts.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const ALLOWED_ENVS = ['test', 'sandbox', 'local'];
export const BLOCKED_ENVS = ['prod', 'production'];

// The production outputs file, located from THIS file (not the cwd) so the guard holds
// wherever the script is launched from, and does not need the file to exist for --help.
const REPO_ROOT_AMPLIFY_OUTPUTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../amplify_outputs.json');
const canonical = (p) => (existsSync(p) ? realpathSync(p) : resolve(p)).toLowerCase();

/**
 * @param {object} spec
 * @returns {{values: Record<string, unknown>, positionals: string[]}}
 */
export function parseTmsArgs(spec = {}) {
  const args = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      outputs: { type: 'string' },
      apply: { type: 'boolean' },
      env: { type: 'string' },
      plan: { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      ...spec,
    },
    allowPositionals: false,
  });
  return args;
}

/**
 * Read amplify_outputs.json from the path provided by --outputs.
 * Refuses the file at the repo root because that is the production backend, EXCEPT for a run that passed the
 * production gate (`prod` = the result of `requireProd` from ./prodGate.mjs): a real production run must pass
 * exactly the repo-root file, and the rehearsal seam must pass anything else.
 * @param {string} outputsPath
 * @param {{rehearsal?: boolean} | null} [prod]
 * @returns {Record<string, unknown>}
 */
export function loadAmplifyOutputs(outputsPath, prod = null) {
  if (!outputsPath) {
    throw new Error('--outputs <path> is required');
  }
  const resolved = resolve(process.cwd(), outputsPath);
  const isRoot = canonical(resolved) === canonical(REPO_ROOT_AMPLIFY_OUTPUTS);
  if (prod && !prod.rehearsal) {
    if (!isRoot) throw new Error(`--target prod needs --outputs <repo-root amplify_outputs.json> (the production backend), got ${resolved}`);
  } else if (isRoot) {
    throw new Error(
      `Refusing to use repo-root amplify_outputs.json (production): ${resolved}`
    );
  }
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

/**
 * Ensure --apply has a non-production environment.
 * @param {string | undefined} env
 * @param {string} [target]
 */
export function requireApplyEnv(env, target = 'target') {
  if (!env) {
    throw new Error(`--env <${target}> is required with --apply`);
  }
  const lower = env.toLowerCase();
  if (BLOCKED_ENVS.includes(lower)) {
    throw new Error(`Environment "${env}" is blocked; only isolated test/sandbox targets are allowed with --apply`);
  }
  if (!ALLOWED_ENVS.includes(lower)) {
    throw new Error(
      `Unknown environment "${env}". Allowed values: ${ALLOWED_ENVS.join(', ')}`
    );
  }
  return lower;
}

/**
 * @param {boolean} apply
 * @param {string | undefined} env
 * @param {{apply: boolean, environment: string} | null} [prod] result of `requireProd` (./prodGate.mjs): a run that
 *   passed the production gate takes its mode and environment label from it instead of --env.
 */
export function detectMode(apply, env, prod = null) {
  if (prod) {
    return { mode: prod.apply ? 'apply' : 'dry-run', env: prod.environment };
  }
  if (apply) {
    return { mode: 'apply', env: requireApplyEnv(env) };
  }
  return { mode: 'dry-run', env: env ?? 'dry-run' };
}

/**
 * Format a plan file path from a default pattern.
 * @param {string} scriptName
 * @param {string} env
 * @returns {string}
 */
export function defaultPlanPath(scriptName, env) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `plans/${scriptName}-${env}-${ts}.json`;
}
