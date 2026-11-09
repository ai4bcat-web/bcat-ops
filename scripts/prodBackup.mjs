#!/usr/bin/env node
/**
 * Create the on-demand DynamoDB backups the production gate demands (scripts/lib/prodGate.mjs, condition (c)).
 *
 *   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script backfillApOpen,backfillLegacyAr --target prod --i-mean-production [--apply]
 *   BCAT_ALLOW_PROD=$(date +%F) node scripts/prodBackup.mjs --script all --target prod --i-mean-production --apply
 *
 * For every named script, every table in scripts/lib/prodWriteSets.mjs gets one backup named
 * `prodpre-<script>-<Model>-<UTC stamp>`; the script's own gate accepts it for 6 hours once AVAILABLE. A table that
 * already has a fresh qualifying backup for that script is skipped, so a re-run only creates what is missing.
 * Gates: BCAT_ALLOW_PROD=<today YYYY-MM-DD> and --i-mean-production (no typed confirmation: a backup destroys nothing).
 * Dry run unless --apply; --apply creates the backups and waits for every one to be AVAILABLE.
 * Test-only: --prod-mode-rehearsal-suffix=<dev suffix> backs up the dev tables through the same path.
 */
import { CreateBackupCommand, DescribeBackupCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PROD_GATE_OPTIONS, REGION, backupPrefix, checkBackups, requireProd, tableName } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';

const stamp = (now) => now.toISOString().replace(/[-:]/g, '').slice(0, 15); // 20261105T210000

/** Scripts that actually write tables (what `--script all` means). */
export const backupScripts = () => Object.entries(PROD_WRITE_SETS).filter(([, v]) => !v.readOnly && v.models.length).map(([k]) => k);

/** @param {string} list comma-separated script names or 'all' */
export function resolveScripts(list) {
  if (!list) throw new Error('--script <name[,name]|all> is required');
  const names = list === 'all' ? backupScripts() : list.split(',').map((x) => x.trim()).filter(Boolean);
  for (const n of names) {
    const set = PROD_WRITE_SETS[n];
    if (!set) throw new Error(`unknown script "${n}"; known: ${Object.keys(PROD_WRITE_SETS).join(', ')}`);
    if (set.readOnly || !set.models.length) throw new Error(`${n} writes no table: it needs no backup`);
  }
  return [...new Set(names)];
}

/**
 * What still has to be backed up: for each script, the tables without a fresh AVAILABLE `prodpre-<script>-` backup.
 * @returns {Promise<Array<{script: string, table: string, backupName: string}>>}
 */
export async function planBackups(client, { scripts, suffix, now }) {
  const jobs = [];
  for (const script of scripts) {
    const models = PROD_WRITE_SETS[script].models;
    const tables = models.map((m) => tableName(m, suffix));
    const have = await checkBackups(client, { script, tables, now });
    for (const table of have.missing) jobs.push({ script, table, backupName: `${backupPrefix(script)}${models[tables.indexOf(table)]}-${stamp(now)}` });
  }
  return jobs;
}

/** Create every backup, then wait for all to be AVAILABLE. */
export async function createBackups(client, jobs, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitMs = 45 * 60_000, log = console.log } = {}) {
  const started = [];
  for (const j of jobs) {
    const r = await client.send(new CreateBackupCommand({ TableName: j.table, BackupName: j.backupName }));
    started.push({ ...j, arn: r.BackupDetails.BackupArn });
    log(`backup started  ${j.backupName}`);
  }
  const deadline = Date.now() + maxWaitMs;
  for (const s of started) {
    for (;;) {
      const d = await client.send(new DescribeBackupCommand({ BackupArn: s.arn }));
      const status = d.BackupDescription?.BackupDetails?.BackupStatus;
      if (status === 'AVAILABLE') break;
      if (status === 'DELETED') throw new Error(`backup ${s.backupName} was deleted`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for backup ${s.backupName} (${status})`);
      await sleep(5000);
    }
    log(`backup AVAILABLE ${s.backupName}`);
  }
  return started.length;
}

async function main() {
  const { values } = parseArgs({ options: { script: { type: 'string' }, apply: { type: 'boolean' }, ...PROD_GATE_OPTIONS }, allowPositionals: false });
  if (values.target !== 'prod') throw new Error('prodBackup only runs with --target prod (and the gates)');
  const scripts = resolveScripts(values.script);
  const models = [...new Set(scripts.flatMap((s) => PROD_WRITE_SETS[s].models))];
  const gate = await requireProd({ script: 'prodBackup', values, tables: models, readOnly: true, skipTyped: true });
  const client = new DynamoDBClient({ region: REGION });
  const now = new Date();
  const jobs = await planBackups(client, { scripts, suffix: gate.suffix, now });
  console.log(`${jobs.length} backup(s) needed, ${scripts.length} script(s)`);
  for (const j of jobs) console.log(`  ${gate.apply ? 'create' : 'would create'}  ${j.backupName}`);
  if (!gate.apply) return console.log('Dry run: nothing was created. Add --apply.');
  const n = await createBackups(client, jobs);
  console.log(`done: ${n} backup(s) AVAILABLE`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
