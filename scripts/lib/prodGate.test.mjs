import { describe, expect, it } from 'vitest';
import {
  ALLOW_ENV, DEV_SUFFIX, PROD_SUFFIX, ProdGateError, assertWritableSuffix, checkBackups, classifySuffix, confirmationFor,
  evaluateProdGate, isProdAuthorized, localDate, requireProd, resolveProdSuffix,
} from './prodGate.mjs';
import { planBackups, resolveScripts } from '../prodBackup.mjs';
import { splitProdArgs } from './importAljexArgs.mjs';

const NOW = new Date(2026, 10, 7, 21, 0, 0); // local Nov 7 2026 21:00
const TODAY = '2026-11-07';
const ACCT = '111122223333';

/** Fake DynamoDB: `backups` are summaries; ListBackups filters by TableName like the real API. */
const fakeDynamo = (backups) => ({
  calls: [],
  async send(cmd) {
    this.calls.push(cmd.constructor.name);
    return { BackupSummaries: backups.filter((b) => b.TableName === cmd.input.TableName) };
  },
});
const backup = (table, script, minutesAgo, status = 'AVAILABLE') => ({
  TableName: table, BackupName: `prodpre-${script}-${table}-x`, BackupStatus: status,
  BackupCreationDateTime: new Date(NOW.getTime() - minutesAgo * 60000),
});

const allOk = { mode: 'apply', allowEnv: TODAY, today: TODAY, iMeanProduction: true, backups: { ok: true }, accountId: ACCT, suffix: PROD_SUFFIX, typed: `${ACCT}:${PROD_SUFFIX}` };

describe('evaluateProdGate matrix', () => {
  it('passes only when every condition holds', () => {
    expect(evaluateProdGate(allOk)).toEqual({ allowed: true, failures: [] });
  });

  it.each([
    ['env missing', { allowEnv: undefined }, '(a)'],
    ['env "1"', { allowEnv: '1' }, '(a)'],
    ['env yesterday', { allowEnv: '2026-11-06' }, '(a)'],
    ['flag missing', { iMeanProduction: false }, '(b)'],
    ['no backups', { backups: null }, '(c)'],
    ['backups not ok', { backups: { ok: false } }, '(c)'],
    ['no typed confirmation', { typed: undefined }, '(d) typed'],
    ['typed wrong suffix', { typed: `${ACCT}:${DEV_SUFFIX}` }, '(d) typed'],
    ['typed wrong account', { typed: `999:${PROD_SUFFIX}` }, '(d) typed'],
    ['no account id', { accountId: null }, '(d) the AWS account'],
    ['unknown suffix', { suffix: 'other-NONE', typed: `${ACCT}:other-NONE` }, 'neither the production nor a dev'],
  ])('refuses an apply when %s', (_n, over, text) => {
    const r = evaluateProdGate({ ...allOk, ...over });
    expect(r.allowed).toBe(false);
    expect(r.failures.join('\n')).toContain(text);
  });

  it('a dry run needs (a), (b) and the account, but neither backups nor the typed confirmation', () => {
    const dry = { ...allOk, mode: 'dry-run', backups: null, typed: undefined };
    expect(evaluateProdGate(dry).allowed).toBe(true);
    expect(evaluateProdGate({ ...dry, iMeanProduction: false }).allowed).toBe(false);
    expect(evaluateProdGate({ ...dry, allowEnv: '1' }).allowed).toBe(false);
  });

  it('a read-only script needs no backup; skipTyped (backups) needs no typed confirmation', () => {
    expect(evaluateProdGate({ ...allOk, readOnly: true, backups: null }).allowed).toBe(true);
    expect(evaluateProdGate({ ...allOk, readOnly: true, backups: null, typed: undefined, skipTyped: true }).allowed).toBe(true);
    expect(evaluateProdGate({ ...allOk, readOnly: true, backups: null, typed: undefined, skipTyped: true, allowEnv: '1' }).allowed).toBe(false);
  });

  it('uses the local calendar date', () => {
    expect(localDate(NOW)).toBe(TODAY);
  });
});

describe('suffix detection', () => {
  it('classifies prod, dev, rehearsal copies and anything else', () => {
    expect(classifySuffix(PROD_SUFFIX)).toBe('prod');
    expect(classifySuffix(`Load-${PROD_SUFFIX}`)).toBe('prod');
    expect(classifySuffix(`${PROD_SUFFIX}-rhabc`)).toBe('prod');
    expect(classifySuffix(DEV_SUFFIX)).toBe('dev');
    expect(classifySuffix(`${DEV_SUFFIX}-rhabc`)).toBe('dev-rehearsal');
    expect(classifySuffix(`${DEV_SUFFIX}-rhab`)).toBe('unknown');
    expect(classifySuffix(`${DEV_SUFFIX}-x`)).toBe('unknown');
    expect(classifySuffix('')).toBe('unknown');
  });

  it('the rehearsal seam can only name a dev suffix, never production', () => {
    expect(resolveProdSuffix({})).toEqual({ suffix: PROD_SUFFIX, rehearsal: false });
    expect(resolveProdSuffix({ 'prod-mode-rehearsal-suffix': `${DEV_SUFFIX}-rhabc` })).toEqual({ suffix: `${DEV_SUFFIX}-rhabc`, rehearsal: true });
    expect(() => resolveProdSuffix({ 'prod-mode-rehearsal-suffix': PROD_SUFFIX })).toThrow(ProdGateError);
    expect(() => resolveProdSuffix({ 'prod-mode-rehearsal-suffix': 'whatever' })).toThrow(ProdGateError);
    expect(() => resolveProdSuffix({ suffix: DEV_SUFFIX })).toThrow(/do not pass a different --suffix/);
  });
});

describe('checkBackups', () => {
  const T = ['Load-s', 'Order-s'];
  it('accepts fresh AVAILABLE backups with the script prefix', async () => {
    const c = fakeDynamo([backup('Load-s', 'x', 30), backup('Order-s', 'x', 359)]);
    const r = await checkBackups(c, { script: 'x', tables: T, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.found.map((f) => f.table)).toEqual(T);
    expect(new Set(c.calls)).toEqual(new Set(['ListBackupsCommand'])); // read-only
  });
  it.each([
    ['older than 6 hours', backup('Order-s', 'x', 361)],
    ['not AVAILABLE', backup('Order-s', 'x', 5, 'CREATING')],
    ['another script prefix', backup('Order-s', 'y', 5)],
    ['another table', backup('Other-s', 'x', 5)],
  ])('reports the table missing when its backup is %s', async (_n, bad) => {
    const r = await checkBackups(fakeDynamo([backup('Load-s', 'x', 5), bad]), { script: 'x', tables: T, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['Order-s']);
  });
  it('an empty table list is never ok', async () => {
    expect((await checkBackups(fakeDynamo([]), { script: 'x', tables: [], now: NOW })).ok).toBe(false);
  });
});

describe('requireProd', () => {
  const tables = ['Load'];
  const dev = `${DEV_SUFFIX}`;
  const base = (over = {}) => ({
    script: 'x', tables, apply: true,
    values: { target: 'prod', apply: true, 'i-mean-production': true, 'prod-mode-rehearsal-suffix': dev, 'confirm-prod': `${ACCT}:${dev}` },
    deps: { env: { [ALLOW_ENV]: TODAY }, now: NOW, accountId: async () => ACCT, dynamo: fakeDynamo([backup(`Load-${dev}`, 'x', 10)]), out: () => {} },
    ...over,
  });

  it('is a no-op without --target, and refuses prod-only flags without it', async () => {
    expect(await requireProd({ script: 'x', tables, values: {} })).toBeNull();
    await expect(requireProd({ script: 'x', tables, values: { 'i-mean-production': true } })).rejects.toThrow(/only apply together/);
  });

  it('passes with every gate and authorises exactly that suffix', async () => {
    expect(isProdAuthorized(dev)).toBe(false);
    const r = await requireProd(base());
    expect(r).toMatchObject({ suffix: dev, apply: true, rehearsal: true });
    expect(isProdAuthorized(dev)).toBe(true);
  });

  it.each([
    ['env', (b) => { b.deps.env = {}; }],
    ['flag', (b) => { b.values['i-mean-production'] = false; }],
    ['backup', (b) => { b.deps.dynamo = fakeDynamo([]); }],
    ['typed', (b) => { b.values['confirm-prod'] = 'nope'; }],
  ])('refuses an apply with %s missing', async (_n, mutate) => {
    const b = base();
    mutate(b);
    await expect(requireProd(b)).rejects.toBeInstanceOf(ProdGateError);
  });

  it('a production-suffix write is refused by the inner guard until the gate passed', async () => {
    expect(() => assertWritableSuffix(PROD_SUFFIX, 'rows')).toThrow(/Refusing to write rows to production/);
    expect(() => assertWritableSuffix(DEV_SUFFIX, 'rows')).not.toThrow();
    const dry = base({ apply: false });
    dry.values.apply = false;
    await requireProd({ ...dry, deps: { ...dry.deps, accountId: async () => ACCT } });
    expect(isProdAuthorized(PROD_SUFFIX)).toBe(false); // the seam authorised only the dev suffix
  });

  it('rejects an unknown --target', async () => {
    await expect(requireProd({ script: 'x', tables, values: { target: 'dev' } })).rejects.toThrow(/must be "prod"/);
  });
});

describe('prodBackup planning', () => {
  it('plans only the tables lacking a fresh prodpre- backup for each script', async () => {
    const s = DEV_SUFFIX;
    const jobs = await planBackups(fakeDynamo([backup(`LoadCarrier-${s}`, 'backfillApOpen', 10)]), { scripts: ['backfillApOpen'], suffix: s, now: NOW });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ script: 'backfillApOpen', table: `AuditLog-${s}` });
    expect(jobs[0].backupName).toMatch(/^prodpre-backfillApOpen-AuditLog-20261108T\d{6}$|^prodpre-backfillApOpen-AuditLog-2026110\dT\d{6}$/);
  });
  it('refuses unknown and read-only scripts', () => {
    expect(() => resolveScripts('nope')).toThrow(/unknown script/);
    expect(() => resolveScripts('checkDevDuplicates')).toThrow(/needs no backup/);
    expect(resolveScripts('all')).toContain('importAljex');
  });
});

describe('importAljex prod argv', () => {
  it('leaves dev invocations alone and refuses gate flags without --target prod', () => {
    expect(splitProdArgs(['run', '--source', 'f.csv', '--target', 'rehearsal:rh1']).prod).toBe(false);
    expect(() => splitProdArgs(['run', '--target', 'live:x', '--i-mean-production'])).toThrow(/only apply together/);
  });
  it('rewrites the target, strips gate flags and plans (no apply) unless --apply', () => {
    const p = splitProdArgs(['run', '--source', 'f.csv', '--target', 'prod:GO-LIVE', '--i-mean-production', `--prod-mode-rehearsal-suffix=${DEV_SUFFIX}`]);
    expect(p).toMatchObject({ prod: true, liveTag: 'GO-LIVE', cliArgv: ['run', '--source', 'f.csv', '--target', 'live:GO-LIVE', '--no-apply'] });
    expect(p.values).toMatchObject({ target: 'prod', apply: false, 'prod-mode-rehearsal-suffix': DEV_SUFFIX });
    expect(splitProdArgs(['run', '--source', 'f', '--target', 'prod:T', '--apply']).cliArgv).not.toContain('--no-apply');
  });
  it('refuses dev tooling, --memory and a missing live tag in production mode; resume/pitr stop after the plan without --apply', () => {
    expect(() => splitProdArgs(['rehearsal-drop', '--target', 'prod:T'])).toThrow(/dev tooling/);
    expect(() => splitProdArgs(['run', '--memory', '--target', 'prod:T'])).toThrow(/--memory/);
    expect(() => splitProdArgs(['run', '--target', 'prod'])).toThrow(/live tag/);
    expect(splitProdArgs(['resume', '--run', 'r', '--target', 'prod:T']).stopAfterPlan).toBe(true);
    expect(splitProdArgs(['pitr-restore', '--table', 'Load', '--target', 'prod']).readOnly).toBe(true);
  });
  it('prod-rehearsal: rewrites to the engine rehearsal target, gates read-only, plans without --apply, never combines with the seam', () => {
    const run = splitProdArgs(['run', '--source', 'f.csv', '--target', 'prod-rehearsal:rhprod', '--i-mean-production']);
    expect(run).toMatchObject({ prod: true, rehearsalTag: 'rhprod', liveTag: null, readOnly: true, cliArgv: ['run', '--source', 'f.csv', '--target', 'rehearsal:rhprod', '--no-apply'] });
    expect(splitProdArgs(['run', '--source', 'f', '--target', 'prod-rehearsal:rhprod', '--apply']).cliArgv).not.toContain('--no-apply');
    expect(splitProdArgs(['rehearsal-create', '--target', 'prod-rehearsal:rhprod']).cliArgv).toEqual(['rehearsal-create', '--tag', 'rhprod']);
    expect(splitProdArgs(['rehearsal-drop', '--tag', 'rhprod', '--target', 'prod-rehearsal:rhprod', '--apply']).cliArgv).toEqual(['rehearsal-drop', '--tag', 'rhprod', '--apply']);
    expect(splitProdArgs(['resume', '--run', 'r', '--target', 'prod-rehearsal:rhprod']).stopAfterPlan).toBe(true);
    expect(() => splitProdArgs(['rehearsal-drop', '--tag', 'other', '--target', 'prod-rehearsal:rhprod'])).toThrow(/does not match/);
    expect(() => splitProdArgs(['seed-counter', '--target', 'prod-rehearsal:rhprod'])).toThrow(/run \| resume/);
    expect(() => splitProdArgs(['run', '--target', 'prod-rehearsal'])).toThrow(/needs a tag/);
    expect(() => splitProdArgs(['run', '--target', 'prod-rehearsal:A!'])).toThrow(/needs a tag/);
    expect(() => splitProdArgs(['run', '--memory', '--target', 'prod-rehearsal:rhprod'])).toThrow(/--memory/);
    expect(() => splitProdArgs(['run', '--target', 'prod-rehearsal:rhprod', `--prod-mode-rehearsal-suffix=${DEV_SUFFIX}`])).toThrow(/does not combine/);
  });
});

it('confirmation string is account:suffix', () => {
  expect(confirmationFor('1', 'a-NONE')).toBe('1:a-NONE');
});
