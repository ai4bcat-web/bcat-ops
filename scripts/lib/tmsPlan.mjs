/**
 * Review plan file helpers for TMS migration scripts.
 *
 * A plan is the dry-run deliverable. It carries the source fingerprint and the
 * target environment so apply can refuse to run against the wrong data or env.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const PLAN_VERSION = 'tms-plan/1';

/**
 * @typedef {object} Reviewable
 * @property {string} kind
 * @property {string} reason
 * @property {unknown} source
 */

/**
 * @typedef {object} TmsPlan
 * @property {string} version
 * @property {string} generatedAt
 * @property {string} environment
 * @property {string} sourceType
 * @property {string} fingerprint
 * @property {number} sourceRows
 * @property {unknown[]} actions
 * @property {Reviewable[]} reviewables
 * @property {unknown[]} unresolved
 * @property {Record<string, unknown>} [summary]
 */

/**
 * Build a deterministic fingerprint from source rows.
 * @param {Array<Record<string, unknown>>} rows
 * @returns {string}
 */
export function createFingerprint(rows) {
  const sorted = [...rows].map((r) => {
    const next = {};
    for (const key of Object.keys(r).sort()) {
      next[key] = r[key];
    }
    return next;
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return `sha256:${createHash('sha256').update(JSON.stringify(sorted)).digest('hex')}`;
}

/**
 * @param {object} opts
 * @param {string} opts.environment
 * @param {string} opts.endpoint
 * @param {string} opts.sourceType
 * @param {Array<Record<string, unknown>>} opts.sourceRows
 * @param {unknown[]} opts.actions
 * @param {Reviewable[]} [opts.reviewables]
 * @param {unknown[]} [opts.unresolved]
 * @param {Record<string, unknown>} [opts.summary]
 * @returns {TmsPlan}
 */
export function createPlan({
  environment,
  endpoint,
  sourceType,
  sourceRows,
  actions,
  reviewables = [],
  unresolved = [],
  summary = {},
}) {
  return {
    version: PLAN_VERSION,
    generatedAt: new Date().toISOString(),
    environment,
    endpoint,
    sourceType,
    fingerprint: createFingerprint(sourceRows),
    sourceRows: sourceRows.length,
    actions,
    reviewables,
    unresolved,
    summary,
  };
}

/**
 * @param {string} path
 * @returns {TmsPlan}
 */
export function loadPlan(path) {
  const raw = readFileSync(path, 'utf8');
  const plan = JSON.parse(raw);
  if (plan.version !== PLAN_VERSION) {
    throw new Error(`Plan file ${path} version ${plan.version} is not supported (need ${PLAN_VERSION})`);
  }
  return plan;
}

/**
 * @param {TmsPlan} plan
 * @param {string} path
 */
export function savePlan(plan, path) {
  writeFileSync(path, JSON.stringify(plan, null, 2), 'utf8');
}

/**
 * @param {TmsPlan} plan
 * @param {object} current
 * @param {string} current.environment
 * @param {string} current.endpoint
 * @param {Array<Record<string, unknown>>} current.sourceRows
 */
export function validatePlan(plan, { environment, endpoint, sourceRows }) {
  if (plan.environment !== environment) {
    throw new Error(
      `Plan environment mismatch: plan is "${plan.environment}", current target is "${environment}"`
    );
  }
  if (plan.endpoint !== endpoint) {
    throw new Error(
      `Plan endpoint mismatch: plan was computed for "${plan.endpoint}", current target is "${endpoint}"`
    );
  }
  const currentFingerprint = createFingerprint(sourceRows);
  if (plan.fingerprint !== currentFingerprint) {
    throw new Error(
      `Source fingerprint mismatch: plan=${plan.fingerprint}, current=${currentFingerprint}. Re-run dry-run to regenerate the plan.`
    );
  }
}

/**
 * @param {TmsPlan} plan
 * @returns {string}
 */
export function summarize(plan) {
  const lines = [
    `Environment: ${plan.environment}`,
    `Generated:   ${plan.generatedAt}`,
    `Source rows: ${plan.sourceRows}`,
    `Actions:     ${plan.actions.length}`,
    `Reviewables: ${plan.reviewables.length}`,
    `Unresolved:  ${plan.unresolved.length}`,
  ];
  return lines.join('\n');
}

/**
 * Timestamp-safe deterministic seed id for stable resumable creates.
 * @param {string} prefix
 * @param {string} key
 * @returns {string}
 */
export function stableId(prefix, key) {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `${prefix}-${hash}`;
}

/**
 * Handy unique label when a deterministic id is not available.
 * @param {string} [prefix]
 * @returns {string}
 */
export function uniqueLabel(prefix = 'tmp') {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
