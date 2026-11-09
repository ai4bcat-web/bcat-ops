/**
 * The ONE production gate shared by every script that can write (or, for the read-only ones, read) the
 * production tables: the Aljex importer and every merge-checklist backfill/seed/fix script.
 *
 * Production is reachable only through `--target prod`, and only when ALL of these hold:
 *   (a) env BCAT_ALLOW_PROD is today's local date, YYYY-MM-DD (not '1', not yesterday's);
 *   (b) the flag --i-mean-production is passed;
 *   (c) every table the script will write has an on-demand DynamoDB backup named
 *       `prodpre-<script>-...` whose status is AVAILABLE and that was created in the last 6 hours
 *       (`scripts/prodBackup.mjs` creates them; this module only LISTS backups, read-only);
 *   (d) the plan is printed first, the run is a dry run unless --apply is given, and an APPLY needs the
 *       operator to type `<AWS account id>:<table suffix being written>` (prompt, or --confirm-prod for
 *       a non-interactive shell).
 * A dry run needs (a), (b) and the printed plan; it reports the backup state but does not need it, because it
 * writes nothing. Read-only scripts (`readOnly: true`) never need a backup.
 *
 * Without `--target prod` every existing dev guard is untouched: a production suffix is still refused by the
 * script's own `resolveTarget`. There is deliberately no other way in: no env var alone, no `--suffix`.
 *
 * REHEARSAL SEAM (test only): `--prod-mode-rehearsal-suffix=<dev suffix>` runs the full prod-gated path (all
 * four gates, the backup check, the real engine) against the DEV tables `<Model>-<suffix>` where the suffix is
 * the dev suffix, optionally followed by `-rh<tag>` (a rehearsal copy). The gate treats it as production-shaped.
 * The seam can only ever point at a dev suffix, never at production.
 *
 * REHEARSAL STACK: with env BCAT_STACK=rehearsal (scripts/lib/stackConfig.mjs) the `rehearsal` Amplify branch's
 * table suffix is ALSO classified as a non-production target ('rehearsal'), so the dev guards and the seam accept
 * it. Without that env it is 'unknown' like any other suffix, and the production suffix is refused in both modes.
 */
import { createInterface } from 'node:readline/promises';
import { DynamoDBClient, ListBackupsCommand } from '@aws-sdk/client-dynamodb';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { STACK, isRehearsal } from './stackConfig.mjs';

export const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE';
export const PROD_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4';
export const DEV_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE';
export const DEV_SUFFIX_FRAGMENT = 'nc3jsnxdmjhkpequimypiatkma';
export const REGION = 'us-east-1';
export const BACKUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const ALLOW_ENV = 'BCAT_ALLOW_PROD';

/** Option definitions to spread into a `node:util` parseArgs `options` object. */
export const PROD_GATE_OPTIONS = {
  target: { type: 'string' },
  'i-mean-production': { type: 'boolean' },
  'confirm-prod': { type: 'string' },
  'prod-mode-rehearsal-suffix': { type: 'string' },
};

export const PROD_GATE_USAGE = `  --target prod     PRODUCTION mode. Needs env ${ALLOW_ENV}=<today YYYY-MM-DD>, --i-mean-production, and
                    (to --apply) fresh 'prodpre-<script>-' on-demand backups (scripts/prodBackup.mjs) plus the
                    typed confirmation <account id>:<table suffix> (prompt, or --confirm-prod).
                    Dry run unless --apply. Not given: the dev guards apply and production is refused.`;

export class ProdGateError extends Error {
  /** @param {string} message @param {string[]} [failures] */
  constructor(message, failures = []) {
    super(message);
    this.name = 'ProdGateError';
    this.failures = failures;
  }
}

// ── suffix detection ─────────────────────────────────────────────────────────────────────────────

/** True when `value` (a suffix or a full table name) names the production stack anywhere. */
export const isProductionSuffix = (value) => typeof value === 'string' && value.includes(PROD_SUFFIX_FRAGMENT);

/** The rehearsal stack's table suffix, only when BCAT_STACK=rehearsal selected it for this process. */
export const SELECTED_REHEARSAL_SUFFIX = isRehearsal ? STACK.tableSuffix : null;

/**
 * 'prod' | 'dev' | 'dev-rehearsal' | 'rehearsal' | 'unknown' for a table suffix. A string naming both stacks is
 * 'prod'. 'rehearsal' is the BCAT_STACK=rehearsal stack's own suffix (`rehearsalSuffix`, null unless that env is set).
 */
export function classifySuffix(suffix, rehearsalSuffix = SELECTED_REHEARSAL_SUFFIX) {
  if (typeof suffix !== 'string' || !suffix) return 'unknown';
  if (isProductionSuffix(suffix)) return 'prod';
  if (suffix === DEV_SUFFIX) return 'dev';
  if (rehearsalSuffix && suffix === rehearsalSuffix) return 'rehearsal';
  if (suffix.startsWith(`${DEV_SUFFIX}-rh`) && /^-rh[a-z0-9]{3,12}$/.test(suffix.slice(DEV_SUFFIX.length))) return 'dev-rehearsal';
  return 'unknown';
}

/** The table `<Model>-<suffix>`. */
/**
 * `<Model>-<suffix>`. The one exception is CarrierTaxVault: it is NOT an Amplify model (its own CDK stack, amplify/backend.ts),
 * so its table is `CarrierTaxVault-<apiId>` with no `-NONE`.
 */
export const tableName = (model, suffix) => (model === 'CarrierTaxVault' ? `${model}-${suffix.replace(/-NONE$/, '')}` : `${model}-${suffix}`);

// ── the pure decision ────────────────────────────────────────────────────────────────────────────

/** Local calendar date, YYYY-MM-DD. */
export function localDate(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The exact string an operator must type to confirm an APPLY. */
export const confirmationFor = (accountId, suffix) => `${accountId}:${suffix}`;

/**
 * Pure gate matrix. Returns every failed condition (empty `failures` means allowed); never throws and never
 * returns allowed while any required condition is missing.
 *
 * @param {object} input
 * @param {'dry-run'|'apply'} input.mode
 * @param {boolean} [input.readOnly]        the script writes nothing: no backup condition
 * @param {string | undefined} input.allowEnv  value of BCAT_ALLOW_PROD
 * @param {string} input.today              YYYY-MM-DD
 * @param {boolean} input.iMeanProduction
 * @param {{ok: boolean} | null} [input.backups]  result of checkBackups (null = not checked)
 * @param {string | null} [input.accountId]
 * @param {string} input.suffix             the table suffix about to be written
 * @param {string | undefined} [input.typed]  what the operator typed
 * @param {boolean} [input.skipTyped]       backups only: gates (a) and (b) are enough, no typed confirmation
 * @returns {{allowed: boolean, failures: string[]}}
 */
export function evaluateProdGate(input) {
  const failures = [];
  if (input.allowEnv !== input.today) failures.push(`(a) env ${ALLOW_ENV} must equal today's date ${input.today} (a bare "1" is refused)`);
  if (input.iMeanProduction !== true) failures.push('(b) pass --i-mean-production');
  if (!input.suffix || (classifySuffix(input.suffix) === 'unknown')) failures.push(`(d) the table suffix "${input.suffix}" is neither the production nor a dev suffix`);
  if (!input.accountId) failures.push('(d) the AWS account id could not be read (aws sts get-caller-identity)');
  if (input.mode === 'apply') {
    if (!input.readOnly && !(input.backups && input.backups.ok === true)) failures.push('(c) a fresh AVAILABLE prodpre- on-demand backup of every table this script writes is required (scripts/prodBackup.mjs)');
    const want = input.accountId ? confirmationFor(input.accountId, input.suffix) : null;
    if (input.skipTyped !== true && (!want || input.typed !== want)) failures.push('(d) typed confirmation must be exactly <account id>:<table suffix>');
  }
  return { allowed: failures.length === 0, failures };
}

// ── backups (read-only listing) ──────────────────────────────────────────────────────────────────

/** Backup-name prefix a script's pre-write backups must carry. */
export const backupPrefix = (script) => `prodpre-${script}-`;

/**
 * Every table in `tables` needs an AVAILABLE backup named `prodpre-<script>-*` created within `maxAgeMs`.
 * Only ListBackups is called. `client` is anything with `send(command)`.
 *
 * @param {{send: (cmd: any) => Promise<any>}} client
 * @param {{script: string, tables: string[], now?: Date, maxAgeMs?: number}} opts
 * @returns {Promise<{ok: boolean, found: Array<{table: string, name: string, ageMinutes: number}>, missing: string[]}>}
 */
export async function checkBackups(client, { script, tables, now = new Date(), maxAgeMs = BACKUP_MAX_AGE_MS }) {
  const prefix = backupPrefix(script);
  const since = new Date(now.getTime() - maxAgeMs);
  const found = [];
  const missing = [];
  for (const table of tables) {
    let best = null;
    let token;
    do {
      const r = await client.send(new ListBackupsCommand({ TableName: table, TimeRangeLowerBound: since, BackupType: 'USER', ExclusiveStartBackupArn: token }));
      for (const b of r.BackupSummaries ?? []) {
        const created = b.BackupCreationDateTime ? new Date(b.BackupCreationDateTime) : null;
        if (b.TableName !== table || !b.BackupName?.startsWith(prefix) || b.BackupStatus !== 'AVAILABLE' || !created) continue;
        const age = now.getTime() - created.getTime();
        if (age > maxAgeMs || age < -60_000) continue;
        if (!best || created > best.created) best = { created, name: b.BackupName };
      }
      token = r.LastEvaluatedBackupArn;
    } while (token);
    if (best) found.push({ table, name: best.name, ageMinutes: Math.round((now.getTime() - best.created.getTime()) / 60000) });
    else missing.push(table);
  }
  return { ok: missing.length === 0 && tables.length > 0, found, missing };
}

// ── target resolution + orchestration ────────────────────────────────────────────────────────────

const authorized = new Set();

/** True only for a suffix a successful `requireProd` in THIS process has authorised. */
export const isProdAuthorized = (suffix) => authorized.has(suffix);

/**
 * The inner write guard that replaces the scripts' `if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) throw`:
 * a production suffix passes only after this process's gate passed for exactly that suffix.
 */
export function assertWritableSuffix(suffix, what) {
  if (isProductionSuffix(suffix) && !isProdAuthorized(suffix)) {
    throw new Error(`Refusing to write ${what} to production tables (${suffix}) without --target prod and every production gate`);
  }
}

async function defaultAccountId() {
  const r = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
  return r.Account ?? null;
}

async function defaultAsk(question) {
  if (!process.stdin.isTTY) throw new ProdGateError('No terminal to type the confirmation in: pass --confirm-prod <account id>:<table suffix>');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * The suffix a `--target prod` run writes: the production suffix, or the dev suffix named by the rehearsal seam.
 * Throws on anything that could aim the run elsewhere.
 * @param {Record<string, unknown>} values parsed CLI values
 * @returns {{suffix: string, rehearsal: boolean}}
 */
export function resolveProdSuffix(values) {
  const seam = values['prod-mode-rehearsal-suffix'];
  const explicit = values.suffix;
  if (seam !== undefined) {
    if (typeof seam !== 'string' || !['dev', 'dev-rehearsal', 'rehearsal'].includes(classifySuffix(seam))) {
      throw new ProdGateError(`--prod-mode-rehearsal-suffix must be the dev suffix ${DEV_SUFFIX} or ${DEV_SUFFIX}-rh<tag> (or the BCAT_STACK=rehearsal suffix), never production (got "${seam}")`);
    }
    if (explicit !== undefined && explicit !== seam) throw new ProdGateError('--suffix and --prod-mode-rehearsal-suffix disagree; pass only the rehearsal suffix');
    return { suffix: seam, rehearsal: true };
  }
  if (explicit !== undefined && explicit !== PROD_SUFFIX) throw new ProdGateError(`--target prod writes ${PROD_SUFFIX}; do not pass a different --suffix (got "${explicit}")`);
  return { suffix: PROD_SUFFIX, rehearsal: false };
}

/**
 * Run the gates for a `--target prod` request. Returns null when the run is not a production run (no `--target`),
 * after refusing every production-only flag given without it. Otherwise prints the plan and either returns
 * `{ suffix, environment, apply, rehearsal, accountId }` or throws ProdGateError.
 *
 * @param {object} opts
 * @param {string} opts.script        script name as used in backup names, e.g. 'backfillApOpen'
 * @param {Record<string, unknown>} opts.values  parsed CLI values (target, i-mean-production, confirm-prod, apply, suffix, ...)
 * @param {string[]} opts.tables      MODEL names the script writes (or reads, when readOnly)
 * @param {boolean} [opts.readOnly]
 * @param {boolean} [opts.apply]      defaults to values.apply
 * @param {boolean} [opts.skipTyped]  only scripts/prodBackup.mjs: creating backups needs gates (a)+(b), not the typed confirmation
 * @param {object} [opts.deps]        test seams: env, now, dynamo, accountId(), ask(q), out(line)
 */
export async function requireProd({ script, values, tables, readOnly = false, apply, skipTyped = false, deps = {} }) {
  const target = values.target;
  const seamGiven = values['prod-mode-rehearsal-suffix'] !== undefined;
  if (target === undefined) {
    if (seamGiven || values['i-mean-production'] || values['confirm-prod'] !== undefined) {
      throw new ProdGateError('--i-mean-production, --confirm-prod and --prod-mode-rehearsal-suffix only apply together with --target prod');
    }
    return null;
  }
  if (target !== 'prod') throw new ProdGateError(`--target must be "prod" (got "${target}"); omit it for the dev stack`);

  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const out = deps.out ?? ((line) => console.log(line));
  const doApply = (apply ?? values.apply) === true;
  const { suffix, rehearsal } = resolveProdSuffix(values);
  const tableNames = tables.map((m) => tableName(m, suffix));

  const dynamo = deps.dynamo ?? new DynamoDBClient({ region: REGION });
  const accountId = await (deps.accountId ?? defaultAccountId)().catch(() => null);
  const backups = readOnly ? null : await checkBackups(dynamo, { script, tables: tableNames, now }).catch((err) => ({ ok: false, found: [], missing: tableNames, error: String(err?.message ?? err) }));

  out(`── PRODUCTION GATE: ${script} ${rehearsal ? '[REHEARSAL SEAM: dev tables treated as production]' : '[PRODUCTION]'}`);
  out(`   account ${accountId ?? 'UNKNOWN'}   suffix ${suffix}   mode ${doApply ? 'APPLY' : 'DRY RUN (nothing is written)'}${readOnly ? '   (read-only script)' : ''}`);
  out(`   ${readOnly ? 'reads' : 'writes'}: ${tableNames.join(', ')}`);
  if (backups) {
    for (const f of backups.found) out(`   backup ok   ${f.table}  ${f.name}  ${f.ageMinutes} min old`);
    for (const m of backups.missing) out(`   backup MISSING/STALE  ${m}  (need ${backupPrefix(script)}* AVAILABLE, < 6 h)`);
  }

  const dryChecks = evaluateProdGate({
    mode: 'dry-run',
    readOnly,
    allowEnv: env[ALLOW_ENV],
    today: localDate(now),
    iMeanProduction: values['i-mean-production'] === true,
    accountId,
    suffix,
  });
  let failures = dryChecks.failures;
  if (doApply && failures.length === 0) {
    let typed = typeof values['confirm-prod'] === 'string' ? values['confirm-prod'].trim() : undefined;
    if (typed === undefined && accountId && !skipTyped) {
      typed = await (deps.ask ?? defaultAsk)(`Type ${confirmationFor(accountId, suffix)} to APPLY against ${rehearsal ? 'the rehearsal copy' : 'PRODUCTION'}: `);
    }
    failures = evaluateProdGate({
      mode: 'apply',
      readOnly,
      allowEnv: env[ALLOW_ENV],
      today: localDate(now),
      iMeanProduction: values['i-mean-production'] === true,
      backups,
      accountId,
      suffix,
      typed,
      skipTyped,
    }).failures;
  }
  if (failures.length) throw new ProdGateError(`Production gate closed for ${script}:\n  - ${failures.join('\n  - ')}`, failures);

  authorized.add(suffix);
  return { suffix, environment: rehearsal ? `prod-rehearsal(${suffix})` : 'production', apply: doApply, rehearsal, accountId };
}
