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
 * Refuses the file at the repo root because that is the production backend.
 * @param {string} outputsPath
 * @returns {Record<string, unknown>}
 */
export function loadAmplifyOutputs(outputsPath) {
  if (!outputsPath) {
    throw new Error('--outputs <path> is required');
  }
  const resolved = resolve(process.cwd(), outputsPath);
  if (canonical(resolved) === canonical(REPO_ROOT_AMPLIFY_OUTPUTS)) {
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
 */
export function detectMode(apply, env) {
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
