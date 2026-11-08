import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { describeCsv, parseCsv } from './awProdRunHelper.mjs'

const SCRIPT = join(import.meta.dirname, 'awProdRun.sh')
const REAL_HELPER = join(import.meta.dirname, 'awProdRunHelper.mjs')
const CANARY = 'Canary-Pw-9x!Zq7'
const PROD = '5ucwdyvwivelbo4k4jomvrwel4'

// A fake awProd.mjs that prints the real output formats with the runbook's expected numbers. FAKE_BREAK=<step>:<metric> breaks one number.
const FAKE_AWPROD = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const [step, ...rest] = process.argv.slice(2)
const dir = process.env.FAKE_DIR
const apply = rest.includes('--apply')
const evaluate = rest.includes('--evaluate')
const brk = (process.env.FAKE_BREAK || '').split(':')
const bad = (s, m, good, wrong) => (brk[0] === s && brk[1] === m ? wrong : good)
appendFileSync(dir + '/argv.log', process.argv.slice(2).join(' ') + '\\n')
if (apply) { appendFileSync(dir + '/applies.log', step + ' confirm=' + process.env.AW_PROD_CONFIRM + '\\n'); writeFileSync(dir + '/applied-' + step, '1') }
const loadsDone = existsSync(dir + '/applied-loads')
const log = dir + '/' + step + '.log'
const lines = []
const L = (s) => lines.push(s)
const ent = (n, s, c, m, e, k, x, r) => L('  ' + n.padEnd(9) + ' staged ' + s + '  created ' + c + '  matched ' + m + '  enriched ' + e + '  skipped ' + k + '  conflicts ' + x + '  errors ' + r)
const header = (name, mode) => L('\\n== ' + name + ' ' + (mode === 'PLAN' ? 'dry run (PLAN)' : 'apply (APPLY)') + ' job aljexrun:abc' + name.replace(/\\W/g, '') + ' ' + (mode === 'PLAN' ? 'PLANNED' : 'APPLIED'))
const modes = apply && ['customers','carriers','ar','ap-aging','ap-expected'].includes(step) ? ['PLAN', 'APPLY'] : ['PLAN']
const logline = []
if (step === 'settings') L('settings plan: SET (counter -> 19999, NUMERIC; first PRO 20000)')
if (step === 'verify') logline.push('verify tables: tables=110 expected=110', 'verify settings: seriesAt19999=' + (existsSync(dir + '/applied-settings') ? 1 : 0) + ' numeric=1')
if (step === 'tax-ids') L('tax-ids: rows=2462 withValue=2353 resolvable=2353 unresolvable=0')
if (process.env.FAKE_LEAK) L('debug leak ' + process.env.BCAT_PASSWORD + ' ' + process.env.BCAT_EMAIL)
if (step === 'backfill') {
  // Default = the real state since the emergency backfill: all 958 Loads linked. FAKE_BACKFILL_PENDING=1 simulates the old pending state.
  const done = loadsDone || process.env.FAKE_BACKFILL_PENDING !== '1'
  L('backfill before: matchedByPro=' + (done ? 0 : 957) + ' linkedById=' + (process.env.FAKE_BACKFILL_PENDING === '1' ? 1 : 0) + ' ambiguous=0 unmappable=0 alreadyLinked=' + (done ? (process.env.FAKE_BACKFILL_PENDING === '1' ? 957 : 958) : 0) + ' loads=958 beforeWindow=0 afterCutoff=' + bad('backfill-check', 'afterCutoff', 0, 3) + ' carriedOver=17 totalLoads=958')
  L('table Shipment: before ' + (done ? 958 : 0) + ', after ' + (done ? 958 : 0) + ', delta 0')
  if (!evaluate) L('backfill refusals not evaluated (add --evaluate)')
  if (apply) { L('backfill after: matchedByPro=0 linkedById=0 ambiguous=0 unmappable=0 alreadyLinked=958 loads=958') }
}
for (const mode of modes) {
  if (step === 'customers') {
    L('  stripped before upload: Web Password'); L('  uploaded CUSTOMERS_MASTER: job aljexrun:abcCustomers, 761 rows'); header('customers', mode)
    ent('CUSTOMER', 515, 515, 0, 0, 0, 0, 0); ent('LOCATION', 245, 245, 0, 0, 0, 0, 0)
    for (const [k, v] of Object.entries({ customersCreated: 515, customersMatched: 0, customersEnriched: 0, locationsCreated: 245, excluded: 1, rejected: 0, duplicateGroups: 32, factor: 479, manual: 36, unset: 0, needsReview: bad('customers', 'needsReview', 10, 11), danisco120: 2 })) L('  ' + k + ': ' + v)
    L('  needs a look: 96 (keys only)')
    if (mode === 'APPLY') { L('table Customer: before 5, after 520, delta 515'); L('table Location: before 0, after 245, delta 245') }
  }
  if (step === 'carriers') {
    L('  rows with a value in the columns that are NOT imported: Fed/SS # 2353, Bank Account 442, Routing # 442'); L('  stripped before upload: Account #, Fed/SS #, Bank Account, Routing #')
    L('  uploaded CARRIERS_MASTER: job aljexrun:abcCarriers, 2462 rows'); header('carriers', mode); ent('CARRIER', 2442, 2442, 0, 0, 0, 0, 0)
    for (const [k, v] of Object.entries({ otherVendorsSkipped: 19, inactive: 252, withFactorId: 183, quickPay: 14, rowsWithFedSs: 0, rowsWithBankAccount: 0, rowsWithRouting: 0 })) L(process.env.FAKE_HIDE_SENSITIVE && /^rowsWith/.test(k) ? '  ' + k + '=[hidden]' : '  ' + k + ': ' + v)
    if (mode === 'APPLY') L('table Carrier: before 0, after 2442, delta 2442')
  }
  if (step === 'ap-aging') {
    L('  uploaded AP_AGING: job aljexrun:abcAp, 67 rows'); header('ap', mode); ent('BILL', 67, 67, 0, 0, 0, 0, 0)
    L('  apAging: rows 67, bills 67, totalCents $83,407.20, payToDiffers 40, created 67, unresolved 0, rejected 0')
    L('  tie-out apAgingTotal       file $83,407.20  BCAT $' + (mode === 'APPLY' ? '83,407.20' : '0.00') + '  diff $' + (mode === 'APPLY' ? '0.00' : '-83,407.20'))
    L('  tie-out apBucket:D0_30     file $66,642.20  BCAT $0.00  diff $-66,642.20'); L('  tie-out apBucket:D31_60    file $16,765.00  BCAT $0.00  diff $-16,765.00'); L('  tie-out apBucket:D61_90    file $0.00  BCAT $0.00  diff $0.00')
    if (mode === 'APPLY') L('table CarrierBill: before 0, after 67, delta 67')
  }
  if (step === 'ap-expected') {
    L('  uploaded AP_EXPECTED: job aljexrun:abcApe, 36 rows'); header('ap', mode); ent('BILL', 0, 0, 0, 0, 0, 0, 0)
    L('  apExpected: rows 36, expected 24, expectedCents $27,706.47, droppedStale 12, droppedStaleCents $7,562.71, rejected 0')
  }
  if (step === 'ar') {
    L('  uploaded AR_REPORT: job aljexrun:abcAr, 296 rows'); header('ar', mode); ent('INVOICE', 296, 296, 0, 0, 0, 0, 0)
    for (const [k, v] of Object.entries({ rows: 296, invoices: 296, totalCents: '$357,753.44', invoiceTotalCents: '$361,203.44', previousPaidCents: '$3,450.00', partialCount: 3, priorPaymentsCreated: 3, unresolved: 0 })) L('  ' + k + ': ' + v)
    L('  byBucket: D0_30 21641634, D31_60 6220130, D61_90 3000550, D91_120 1487495, D121_PLUS 3425535')
    L('  byBucketBcat: D0_30 29438446, D31_60 5357818, D61_90 510550, D91_120 22995, D121_PLUS 445535')
    L('  redated: count 55, openCents $87,164.96'); L('  termsCounts: 15 5, 30 236, 90 55')
    L('  tie-out arInvoiceMinusPayments file $357,753.44  BCAT $357,753.44  diff $0.00'); L('  tie-out arPreviousPayments file $3,450.00  BCAT $3,450.00  diff $0.00')
    L('  tie-out arTotal            file $357,753.44  BCAT $' + (mode === 'APPLY' ? '357,753.44' : '0.00') + '  diff $' + (mode === 'APPLY' ? '0.00' : '-357,753.44'))
    if (mode === 'APPLY') { L('table Invoice: before 0, after 296, delta 296'); L('table ArPayment: before 0, after 3, delta 3') }
  }
}
if (step === 'stage-export') { if (apply) L('\\n== big export staged: job aljexrun:abcStage, 8347 rows, stage hash 0123456789ab (no table was written)'); else L('stage-export local check: bytes=100') }
if (step === 'loads') {
  L('run aljexrun:x target PRODUCTION-GATED'); L('STAGE 1.0s: 8347 rows (7940 loads, 403 memos, 4 identical duplicates, 7 junk dates, 8345 ragged)'); L('PLAN 3.0s')
  ent('LOAD', 7944, 4384, 40, 915, 2605, 0, 0); ent('CUSTOMER', 487, 1, 486, 0, 0, 0, 0); ent('INVOICE', 5231, 4316, 0, 915, 0, 0, 0); ent('BILL', 2365, 2365, 0, 0, 0, 0, 0)
  L('revenueDifferences: total 283, paid 227 (absCents 162191, shortCount 18, shortCents 106974, overCount 11, overCents 55217), partial 0 (absCents 0), outstanding 56 (absCents 286949), onReviewCsv 56')
  L('revenueDifferencesAll: count 283, absCents 1508301, netCents 1076189, higher 160, lower 123, open 55, paid 228')
  L('paidAmountUsed: invoices 227, explainedCents -39750')
  if (process.env.FAKE_GATE === '1' && apply) { console.error('a LIVE apply of real data needs a RECONCILED rehearsal run with the same stageHash and profileVersion'); process.exit(1) }
  if (apply) { L('APPLY 9.0s'); L('  conservation OK  reconciled YES  open AR 357753.44'); L('revenue-differences report: 56 row(s) -> ' + dir + '/reports/revenue-differences-x.csv (0600; PII, outside the repo)'); L('table Load: before 958, after 5342, delta 4384') }
}
if (step === 'reconcile') {
  const e = rest[rest.indexOf('--entity') + 1]
  L('\\n== reconcile ' + e + ' job x')
  const m = { CUSTOMERS: 515, CARRIERS: 2442, AP: 67, AR: 296, SHIPMENTS: 5339 }[e]
  L('  Aljex rows ' + m + '  BCAT rows ' + m + '  matched ' + m + '  Aljex-only 0  BCAT-only 0  mismatched 0  differences 0')
  if (e === 'AP') L('  money: Aljex $83,407.20  BCAT $83,407.20  diff $0.00'); if (e === 'AR') L('  money: Aljex $357,753.44  BCAT $357,753.44  diff $0.00')
}
for (const l of lines) console.log(l)
writeFileSync(log, [...logline, ...lines].join('\\n') + '\\n')
console.log('log: ' + log)
`

const FAKE_HELPER = `
import { writeFileSync } from 'node:fs'
const [cmd, a, b] = process.argv.slice(2)
const ROWS = { customers: 761, carriers: 2462, 'ap-aging': 67, 'ap-expected': 36, ar: 296, export: 8347 }
if (cmd === 'login') { if (process.env.BCAT_PASSWORD === process.env.FAKE_PW) console.log('login: OK'); else { console.log('login: FAILED (NotAuthorizedException)'); process.exit(1) } }
else if (cmd === 'jenny') console.log('jenny: found')
else if (cmd === 'rows') console.log('rows=' + ROWS[b] + '\\nsensitive=' + (['customers', 'carriers'].includes(b) ? 'yes' : 'no'))
else if (cmd === 'pros') { writeFileSync(b, '14939\\n'); console.log('pros=1') }
else if (cmd === 'suffix') console.log('apiId=nc3jsnxdmjhkpequimypiatkma')
else if (cmd === 'dev-outputs') writeFileSync(b, '{}')
`

const FAKE_AWS = `#!/bin/bash
echo "$*" >> "$FAKE_DIR/aws.log"
case "$*" in
  *"cloudformation list-stacks"*) printf '2026-11-01\\tUPDATE_COMPLETE\\n' ;;
  *"amplify list-jobs"*) printf 'SUCCEED\\tSUCCEED\\n' ;;
  *"keys(branch"*) printf 'BCAT_SCHEMA_STAGE\\tOTHER\\n' ;;
  *"amplify get-branch"*) echo 3 ;;
  *"list-tables"*) printf '%b' "\${FAKE_TABLE_PAGES:-110\\n}" ;;
  *"describe-table"*) [ "$FAKE_VAULT" = 1 ] && exit 0 || exit 255 ;;
  *"dynamodb scan"*) echo 0 ;;
  *) ;;
esac
`

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'awrun-'))
  const dir = join(home, 'fake'); const bin = join(home, 'bin'); const files = join(home, 'files'); const scripts = join(home, 'scripts')
  for (const d of [dir, bin, files, scripts, join(home, 'bcat-ops-backups')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(scripts, 'awProd.mjs'), FAKE_AWPROD); writeFileSync(join(scripts, 'awProdRunHelper.mjs'), FAKE_HELPER)
  writeFileSync(join(bin, 'aws'), FAKE_AWS); chmodSync(join(bin, 'aws'), 0o755)
  writeFileSync(join(scripts, 'prodBackup.mjs'), "import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.FAKE_DIR + '/argv.log', 'prodBackup ' + process.argv.slice(2).join(' ') + ' allow=' + process.env.BCAT_ALLOW_PROD + '\\n')\nconsole.log('backup ok')\n")
  for (const f of ['aljex-customers-2026-11-08.csv', 'aljex-carriers-2026-11-08.csv', 'aljex-ap-aging-2026-11-08.csv', 'aljex-ap-expected-2026-11-08.csv', 'aljex-ar-2026-11-07.csv', 'aljex-full-export-2026-11-07.csv']) writeFileSync(join(files, f), 'x\n')
  writeFileSync(join(home, 'bcat-ops-backups', 'LATEST_BACKUP_STAMP'), new Date().toISOString())
  return { home, dir, bin, files, scripts }
}

function run(sb, { args = [], input = '', env = {} } = {}) {
  const r = spawnSync('bash', [SCRIPT, '--files-dir', sb.files, ...args], {
    input, encoding: 'utf8', timeout: 120000,
    env: { PATH: `${sb.bin}:${process.env.PATH}`, HOME: sb.home, AWPROD_SCRIPTS_DIR: sb.scripts, FAKE_DIR: sb.dir, AW_REPORTS_DIR: join(sb.dir, 'reports'), FAKE_PW: CANARY, AW_PROD_NONINTERACTIVE: '1', BCAT_EMAIL: 'ryne.test@example.com', BCAT_PASSWORD: CANARY, ...env },
  })
  const logs = join(sb.home, 'bcat-ops-backups', 'aw-prod-logs')
  const runDirs = existsSync(logs) ? readdirSync(logs).filter((n) => n.startsWith('run-')) : []
  const runDir = runDirs.length ? join(logs, runDirs.sort().pop()) : null
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
  return { ...r, logs, runDir, applies: read(join(sb.dir, 'applies.log')), results: runDir ? read(join(runDir, 'results.tsv')) : '', state: read(join(logs, 'STATE.tsv')) }
}
const yes = (n) => 'PRODUCTION\n' + 'y\n'.repeat(n)
const allFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]))

describe('awProdRun.sh', () => {
  it('stops on a failing number, applies nothing for that step and exits non-zero with the runbook pointer', () => {
    const sb = sandbox()
    const r = run(sb, { input: yes(20), env: { FAKE_BREAK: 'customers:needsReview' } })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/STOP: customers failed/)
    expect(r.stdout).toMatch(/needsReview/)
    expect(r.stdout).toMatch(/Step 4a Customers/)
    expect(r.applies).not.toMatch(/customers/)
    expect(r.applies).not.toMatch(/carriers/)
  })

  it('stops before any apply when the backfill afterCutoff is > 0', () => {
    const sb = sandbox()
    const r = run(sb, { input: yes(20), env: { FAKE_BREAK: 'backfill-check:afterCutoff' } })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/STOP: backfill-check failed/)
    expect(r.applies).not.toMatch(/customers|carriers|loads|backfill/)
  })

  it('carriedOver 17 with afterCutoff 0 passes (the cutoff means BOOKED); afterCutoff > 0 fails the hard row', () => {
    const ok = run(sandbox(), { input: yes(20), env: { FAKE_BACKFILL_PENDING: '1' } })
    expect(ok.results).toMatch(/backfill-check\tbackfill_before\.afterCutoff\t0\t0\tPASS/)
    expect(ok.results).toMatch(/backfill-check\tbackfill_before\.carriedOver\t17\t17\tPASS/)
    const bad = run(sandbox(), { input: yes(20), env: { FAKE_BREAK: 'backfill-check:afterCutoff', FAKE_BACKFILL_PENDING: '1' } })
    expect(bad.results).toMatch(/backfill-check\tbackfill_before\.afterCutoff\t0\t3\tFAIL/)
    expect(bad.results).toMatch(/backfill-check\tbackfill_before\.carriedOver\t17\t17\tPASS/)
  })

  it('does not apply without a typed y, and applies with y; each apply carries the dated confirm token', () => {
    const sb = sandbox()
    const no = run(sb, { input: 'PRODUCTION\nn\n' })
    expect(no.status).toBe(4)
    expect(no.applies).not.toMatch(/settings|customers/)
    const sb2 = sandbox()
    const ok = run(sb2, { input: yes(40) })
    expect(ok.status).toBe(0)
    const today = new Date().toLocaleDateString('sv-SE')
    for (const s of ['settings', 'customers', 'carriers', 'stage-export', 'loads', 'ap-aging', 'ap-expected', 'ar', 'reconcile']) expect(ok.applies).toContain(`${s} confirm=${today}-${s}`)
    // The emergency backfill linked all 958 Loads: the dry probe says so and the backfill apply is never re-run.
    expect(ok.stdout).toMatch(/backfill already applied: skipped/)
    // The loads step prints the dollar totals computed from the plan output, and the two review files (path + row count only).
    expect(ok.stdout).toMatch(/revenue differences \(plan\): 283 PROs\. All: abs \$15083\.01, net \$10761\.89, 160 Aljex higher \/ 123 lower/)
    expect(ok.stdout).toMatch(/paid .*: 227, short 18 = \$1069\.74, over 11 = \$552\.17; explained in reconcile: \$-397\.50/)
    expect(ok.stdout).toMatch(/revenue-differences report: 56 row\(s\) -> /)
    expect(ok.stdout).toMatch(/post-load checks: \d+ row\(s\) -> .*post-load-checks-\d{4}-\d{2}-\d{2}\.csv/)
    expect(ok.stdout).toMatch(/Review files \(names inside/)
    expect(ok.results).toMatch(/loads\tLOAD\.enriched\t915\t915\tPASS/)
    expect(ok.results).toMatch(/loads\trevdiff\.total\t283\t283\tPASS/)
    expect(ok.results).toMatch(/loads\tLOAD\.conflicts\t0\t0\tPASS/)
    expect(ok.applies).not.toMatch(/backfill/)
    expect(ok.stdout).toMatch(/Jenny signs off in the app/)
  })

  it('--yes-if-all-pass applies without the Apply prompts, logs auto-applied, and tax-ids stays N', () => {
    const sb = sandbox()
    const r = run(sb, { args: ['--yes-if-all-pass'], input: 'PRODUCTION\nn\nn\n', env: { FAKE_VAULT: '1' } })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/auto-applied/)
    expect(r.applies).toMatch(/customers/)
    expect(r.applies).not.toMatch(/tax-ids/)
    expect(r.stdout).toMatch(/Import tax IDs now\? \[y\/N\]|skipped by choice/)
  })

  it('--dry-only never applies and writes no global DONE state', () => {
    const sb = sandbox()
    const r = run(sb, { args: ['--dry-only'], input: 'PRODUCTION\n' })
    expect(r.applies).toBe('')
    expect(r.state).not.toMatch(/DONE/)
    expect(r.stdout).toMatch(/dry-only/)
  })

  it('never writes the password (or the e-mail) into any file under the run dir or the logs', () => {
    const sb = sandbox()
    const r = run(sb, { args: ['--yes-if-all-pass'], input: 'PRODUCTION\nn\n' })
    expect(r.runDir).toBeTruthy()
    expect(statSync(r.runDir).mode & 0o777).toBe(0o700)
    const files = allFiles(r.logs)
    expect(files.length).toBeGreaterThan(3)
    for (const f of files) { const t = readFileSync(f, 'utf8'); expect(t, f).not.toContain(CANARY); expect(t, f).not.toContain('ryne.test@example.com') }
    expect(r.stdout + r.stderr).not.toContain(CANARY)
  })

  it('resume skips DONE steps', () => {
    const sb = sandbox()
    const first = run(sb, { args: ['--yes-if-all-pass'], input: 'PRODUCTION\nn\n' })
    expect(first.status).toBe(0)
    writeFileSync(join(sb.dir, 'applies.log'), '')
    const second = run(sb, { args: ['--yes-if-all-pass'], input: 'PRODUCTION\nn\n' })
    expect(second.stdout).toMatch(/\[customers\] DONE/)
    expect(second.applies).not.toMatch(/customers|carriers|ap-aging/)
  })

  it('--fresh-step re-runs exactly that step', () => {
    const sb = sandbox()
    run(sb, { args: ['--yes-if-all-pass'], input: 'PRODUCTION\nn\n' })
    writeFileSync(join(sb.dir, 'applies.log'), '')
    const r = run(sb, { args: ['--yes-if-all-pass', '--fresh-step', 'carriers'], input: 'PRODUCTION\nn\n' })
    expect(r.applies).toMatch(/carriers/)
    expect(r.applies).not.toMatch(/customers/)
  })

  it('refuses without a tty (no AW_PROD_NONINTERACTIVE), a wrong suffix, a bad login and root-free typo of PRODUCTION', () => {
    const sb = sandbox()
    const noTty = run(sb, { env: { AW_PROD_NONINTERACTIVE: '' } })
    expect(noTty.status).toBe(2); expect(noTty.stderr).toMatch(/stdin is not a terminal/)
    const wrong = run(sb, { args: ['--suffix', 'nc3jsnxdmjhkpequimypiatkma'], input: 'PRODUCTION\n' })
    expect(wrong.status).toBe(2); expect(wrong.stderr).toMatch(/--suffix must be exactly/)
    expect(run(sb, { args: ['--suffix', PROD, '--target', 'dev'], input: 'PRODUCTION\n' }).status).toBe(2)
    const typo = run(sb, { input: 'production\n' })
    expect(typo.status).toBe(2); expect(typo.applies).toBe('')
    const badLogin = run(sb, { args: ['--only', 'backfill-check'], input: 'PRODUCTION\n', env: { BCAT_PASSWORD: 'wrong', FAKE_BACKFILL_PENDING: '1' } })
    expect(badLogin.status).toBe(1); expect(badLogin.stdout).toMatch(/Login failed/)
    // The offline per-file steps never ask for or check the staff password: a wrong one does not stop customers.
    const offline = run(sb, { args: ['--only', 'customers', '--dry-only'], input: 'PRODUCTION\n', env: { BCAT_PASSWORD: 'wrong' } })
    expect(offline.stdout).not.toMatch(/Login failed/)
  })

  it('stops with the importer message when the live pass needs a reconciled rehearsal', () => {
    const sb = sandbox()
    const r = run(sb, { input: yes(40), env: { FAKE_GATE: '1' } })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/RECONCILED rehearsal run with the same stageHash/)
    expect(r.applies).not.toMatch(/backfill|ap-aging/)
  })
})

describe('carriers sensitive-column counts the importer scrubs to [hidden]', () => {
  // The importer's log scrub prints rowsWithFedSs/BankAccount/Routing as [hidden]: they are INFO, the control is derived.strippedAll.
  it('does not stop the carriers dry run when those three counts read [hidden]', () => {
    const sb = sandbox()
    const r = run(sb, { args: ['--dry-only', '--only', 'carriers'], input: 'PRODUCTION\n', env: { FAKE_HIDE_SENSITIVE: '1' } })
    expect(r.stdout).not.toMatch(/STOP: carriers failed/)
    expect(r.results).not.toMatch(/rowsWith(FedSs|BankAccount|Routing)\t[^\t]*\t[^\t]*\tFAIL/)
    expect(r.results).toMatch(/derived\.strippedAll\tyes\tyes\tPASS/)
  })
})

describe('preflight table count is page-safe', () => {
  // `aws dynamodb list-tables --query length(...)` prints ONE number per page (27 27 25 27 4): the runner must sum them.
  it('sums a multi-page count (27+27+25+27+4 = 110) and passes', () => {
    const sb = sandbox()
    const r = run(sb, { args: ['--dry-only', '--only', 'preflight'], input: 'PRODUCTION\n', env: { FAKE_TABLE_PAGES: '27\\n27\\n25\\n27\\n4\\n' } })
    expect(r.results).toMatch(/tables with suffix\t110\t110\tPASS/)
  })

  it('fails a multi-page total that is off by one (27+27+25+27+3 = 109)', () => {
    const sb = sandbox()
    const r = run(sb, { args: ['--dry-only', '--only', 'preflight'], input: 'PRODUCTION\n', env: { FAKE_TABLE_PAGES: '27\\n27\\n25\\n27\\n3\\n' } })
    expect(r.results).toMatch(/tables with suffix\t110\t109\tFAIL/)
  })
})

describe('awProdRunHelper csv counting', () => {
  it('counts records with quoted newlines and detects sensitive headers without values', () => {
    const csv = '\ufeffAccount #,Web Password,Name\n1,"a\nb",x\n2,y,"q ""z"""\n'
    expect(parseCsv(csv)).toHaveLength(3)
    expect(describeCsv(csv, 'customers')).toEqual({ rows: 2, sensitive: true })
    expect(describeCsv('A,B\n1,2\n', 'ar')).toEqual({ rows: 1, sensitive: false })
  })
})

describe('unattended', () => {
  const SEC_PW = 'Kc-Pw-Canary-7Vq!2m'
  const SEC_ACCT = 'migration-canary@leak.example.org'
  const today = () => new Date().toLocaleDateString('sv-SE')
  const yesterday = () => new Date(Date.now() - 86400000).toLocaleDateString('sv-SE')
  const OK = (steps = 'all') => `APPROVED ${today()} steps=${steps} by=ryne\n`
  const FAKE_SECURITY = `#!/bin/bash
echo "$*" >> "$FAKE_DIR/security.log"
[ "$FAKE_SEC" = missing ] && exit 44
case "$*" in
  *" -w"*) [ "$FAKE_SEC" = empty ] && exit 0; printf '%s\\n' '${SEC_PW}' ;;
  *) printf 'keychain: "login.keychain-db"\\nattributes:\\n    "acct"<blob>="${SEC_ACCT}"\\n    "svce"<blob>="bcat-migration"\\n' ;;
esac
`
  const usb = () => {
    const sb = sandbox()
    writeFileSync(join(sb.bin, 'security'), FAKE_SECURITY); chmodSync(join(sb.bin, 'security'), 0o755)
    return sb
  }
  const approvalPath = (sb) => join(sb.home, 'bcat-ops-backups', 'APPROVAL.production-load')
  function lean(sb) { // a PATH with the fake aws and the system tools the runner needs, but no `security`
    const d = join(sb.home, 'lean'); mkdirSync(d, { recursive: true })
    for (const t of ['bash', 'node', 'awk', 'sed', 'grep', 'date', 'stat', 'tee', 'tput', 'sort', 'head', 'tr', 'cat', 'rm', 'mkdir', 'chmod', 'id', 'dirname', 'uname', 'mv', 'tail', 'wc', 'shasum', 'sha256sum', 'cut', 'uniq', 'touch', 'sleep', 'basename', 'env']) {
      const p = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim()
      if (p && !existsSync(join(d, t))) symlinkSync(p, join(d, t))
    }
    symlinkSync(join(sb.bin, 'aws'), join(d, 'aws'))
    return d
  }
  function runU(sb, { args = [], approval, mode = 0o600, env = {}, path, unattended = true } = {}) {
    if (approval !== undefined) { writeFileSync(approvalPath(sb), approval); chmodSync(approvalPath(sb), mode) }
    const r = spawnSync('bash', [SCRIPT, '--files-dir', sb.files, ...(unattended ? ['--unattended'] : []), ...args], {
      input: '', encoding: 'utf8', timeout: 120000,
      env: { PATH: path ?? `${sb.bin}:${process.env.PATH}`, HOME: sb.home, AWPROD_SCRIPTS_DIR: sb.scripts, FAKE_DIR: sb.dir, AW_REPORTS_DIR: join(sb.dir, 'reports'), FAKE_PW: SEC_PW, ...env },
    })
    const logs = join(sb.home, 'bcat-ops-backups', 'aw-prod-logs')
    const runDirs = existsSync(logs) ? readdirSync(logs).filter((n) => n.startsWith('run-')) : []
    const runDir = runDirs.length ? join(logs, runDirs.sort().pop()) : null
    const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
    const used = readdirSync(join(sb.home, 'bcat-ops-backups')).filter((n) => n.startsWith('APPROVAL.production-load.used-'))
    return { ...r, logs, runDir, used, applies: read(join(sb.dir, 'applies.log')), argv: read(join(sb.dir, 'argv.log')), consumed: read(join(logs, 'APPROVAL.consumed')), results: runDir ? read(join(runDir, 'results.tsv')) : '', state: read(join(logs, 'STATE.tsv')) }
  }

  it('refuses (exit 2) without the Keychain item, with an empty password, and without the security tool', () => {
    const sb = usb()
    const missing = runU(sb, { approval: OK(), env: { FAKE_SEC: 'missing' } })
    expect(missing.status).toBe(2); expect(missing.stderr).toMatch(/bcat-migration/); expect(missing.applies).toBe('')
    const empty = runU(sb, { approval: OK(), env: { FAKE_SEC: 'empty' } })
    expect(empty.status).toBe(2); expect(empty.stderr).toMatch(/empty password/)
    const none = runU(sb, { approval: OK(), path: lean(sb) })
    expect(none.status).toBe(2); expect(none.stderr).toMatch(/'security' tool is missing/); expect(none.applies).toBe('')
  })

  it('offline-only: never reads the Keychain, runs an offline step, and refuses (exit 2) a step that needs the staff login', () => {
    const sb = usb()
    const ok = runU(sb, { approval: OK('customers'), args: ['--only', 'customers'], env: { AW_PROD_OFFLINE_ONLY: '1', FAKE_SEC: 'missing' } })
    expect(ok.status).toBe(0)
    expect(existsSync(join(sb.dir, 'security.log'))).toBe(false)
    const sb2 = usb()
    const refused = runU(sb2, { approval: OK('backfill-check'), args: ['--only', 'backfill-check'], env: { AW_PROD_OFFLINE_ONLY: '1', FAKE_BACKFILL_PENDING: '1' } })
    expect(refused.status).toBe(2)
    expect(refused.stdout + refused.stderr).toMatch(/offline-only run.*staff login/)
    expect(existsSync(join(sb2.dir, 'security.log'))).toBe(false)
    expect(refused.applies).toBe('')
    expect(refused.argv).not.toMatch(/--password|BCAT_PASSWORD/)
  })

  it.each([
    ['no approval file', undefined, 0o600, /no approval file/],
    ['wrong date', `APPROVED ${yesterday()} steps=all by=ryne\n`, 0o600, /for today/],
    ['malformed line', `APPROVED ${today()} steps=all\n`, 0o600, /for today/],
    ['missing by=ryne', `APPROVED ${today()} steps=all by=bob\n`, 0o600, /for today/],
    ['only comments', `# APPROVED ${today()} steps=all by=ryne\n`, 0o600, /for today/],
    ['unknown step name', `APPROVED ${today()} steps=customers,bogus by=ryne\n`, 0o600, /unknown step/],
    ['group-writable file', `APPROVED ${today()} steps=all by=ryne\n`, 0o664, /group\/world-writable/],
    ['world-writable file', `APPROVED ${today()} steps=all by=ryne\n`, 0o666, /group\/world-writable/],
  ])('refuses before any apply: %s', (_n, approval, mode, msg) => {
    const sb = usb()
    const r = runU(sb, { approval, mode, args: ['--only', 'customers'] })
    expect(r.status).toBe(2); expect(r.stderr).toMatch(msg); expect(r.applies).toBe('')
    expect(r.consumed).toBe('')
  })

  it('a step that is not listed is refused after its dry run (no apply); dry-only needs no approval', () => {
    const sb = usb()
    const r = runU(sb, { approval: OK('ar'), args: ['--only', 'customers'] })
    expect(r.status).toBe(2); expect(r.stdout).toMatch(/REFUSED: step customers is not listed/)
    expect(r.results).toMatch(/customers\tCUSTOMER\.errors\t0\t0\tPASS/); expect(r.applies).toBe('')
    const dry = runU(usb(), { args: ['--only', 'customers', '--dry-only'] })
    expect(dry.status).toBe(0); expect(dry.applies).toBe('')
  })

  it('applies only the listed steps, needs no TTY and no stdin, and carries the dated confirm token', () => {
    const sb = usb()
    const r = runU(sb, { approval: OK('customers,carriers'), args: ['--from', 'customers'] })
    expect(r.stderr).not.toMatch(/not a terminal/)
    expect(r.status).toBe(2)
    expect(r.applies).toContain(`customers confirm=${today()}-customers`)
    expect(r.applies).toContain(`carriers confirm=${today()}-carriers`)
    expect(r.applies).not.toMatch(/stage-export|loads|backfill|ap-aging|^ar /m)
    expect(r.stdout).toMatch(/REFUSED: step loads is not listed/)
    expect(existsSync(approvalPath(sb))).toBe(false); expect(r.used).toHaveLength(1) // every listed step is DONE: retired
  })

  it('"all" covers every step but tax-ids and backfill-emergency, finishes with exit 0 and retires the file', () => {
    const sb = usb()
    const r = runU(sb, { approval: OK('all'), env: { FAKE_VAULT: '1' } })
    expect(r.status).toBe(0)
    for (const s of ['settings', 'customers', 'carriers', 'stage-export', 'loads', 'ap-aging', 'ap-expected', 'ar', 'reconcile']) expect(r.applies).toContain(`${s} confirm=${today()}-${s}`)
    expect(r.applies).not.toMatch(/backfill/)
    expect(r.applies).not.toMatch(/tax-ids/)
    expect(r.stdout).toMatch(/\[tax-ids\] skipped \(default NO/)
    expect(r.argv).toMatch(/prodBackup .* allow=\d{4}-\d{2}-\d{2}/)
    expect(existsSync(approvalPath(sb))).toBe(false); expect(r.used).toHaveLength(1)
    const emergency = runU(usb(), { approval: OK('all'), args: ['--only', 'backfill-emergency'], env: { FAKE_BACKFILL_PENDING: '1' } })
    expect(emergency.status).toBe(2); expect(emergency.applies).toBe('')
    const listed = runU(usb(), { approval: OK('all,tax-ids'), args: ['--only', 'tax-ids'], env: { FAKE_VAULT: '1' } })
    expect(listed.status).toBe(0); expect(listed.applies).toContain(`tax-ids confirm=${today()}-tax-ids`)
  })

  it('a stop condition overrides the approval: no apply when a number fails (exit 1)', () => {
    const sb = usb()
    const r = runU(sb, { approval: OK('all'), env: { FAKE_BREAK: 'customers:needsReview' } })
    expect(r.status).toBe(1); expect(r.stdout).toMatch(/STOP: customers failed/)
    expect(r.applies).not.toMatch(/customers|carriers/)
    const cut = runU(usb(), { approval: OK('all'), env: { FAKE_BREAK: 'backfill-check:afterCutoff' } })
    expect(cut.status).toBe(1); expect(cut.applies).not.toMatch(/customers|loads/)
  })

  it('refuses (exit 2) instead of prompting when the backup stamp is stale, and never creates it', () => {
    const sb = usb()
    const stamp = join(sb.home, 'bcat-ops-backups', 'LATEST_BACKUP_STAMP')
    const old = new Date(Date.now() - 8 * 3600 * 1000); utimesSync(stamp, old, old)
    const r = runU(sb, { approval: OK('all'), args: ['--only', 'customers'] })
    expect(r.status).toBe(2); expect(r.stdout).toMatch(/never creates it/); expect(r.applies).toBe('')
    expect(statSync(stamp).mtimeMs).toBeLessThan(Date.now() - 7 * 3600 * 1000)
    const gone = usb(); rmSync(join(gone.home, 'bcat-ops-backups', 'LATEST_BACKUP_STAMP'))
    expect(runU(gone, { approval: OK('all'), args: ['--only', 'customers'] }).status).toBe(2)
    expect(existsSync(join(gone.home, 'bcat-ops-backups', 'LATEST_BACKUP_STAMP'))).toBe(false)
  })

  it('an approval line is consumed once: a second run under the same line does not re-apply', () => {
    const sb = usb()
    const first = runU(sb, { approval: OK('customers'), args: ['--only', 'customers'] })
    expect(first.status).toBe(0); expect(first.used).toHaveLength(1)
    expect(first.consumed).toMatch(/^customers\t\S+\t[0-9a-f]{64}\n$/)
    const second = runU(sb, { approval: OK('customers'), args: ['--only', 'customers', '--fresh-step', 'customers'] })
    expect(second.status).toBe(2); expect(second.stdout).toMatch(/already used to apply customers/)
    expect(second.applies.match(/^customers /gm)).toHaveLength(1)
    const third = runU(sb, { approval: OK('customers,carriers'), args: ['--only', 'customers', '--fresh-step', 'customers'] })
    expect(third.status).toBe(0); expect(third.applies.match(/^customers /gm)).toHaveLength(2)
  })

  it('the Keychain canaries never reach a file, a log, results.tsv, the transcript or any fake argv', () => {
    const sb = usb()
    const r = runU(sb, { approval: OK('backfill-emergency'), args: ['--only', 'backfill-emergency'], env: { FAKE_LEAK: '1', FAKE_BACKFILL_PENDING: '1' } })
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).not.toContain(SEC_PW); expect(r.stdout + r.stderr).not.toContain(SEC_ACCT)
    const files = [...allFiles(join(sb.home, 'bcat-ops-backups')), ...['argv.log', 'aws.log', 'security.log', 'applies.log'].map((n) => join(sb.dir, n)).filter(existsSync)]
    expect(files.some((f) => f.endsWith('transcript.log'))).toBe(true)
    for (const f of files) { const t = readFileSync(f, 'utf8'); expect(t, f).not.toContain(SEC_PW); expect(t, f).not.toContain(SEC_ACCT) }
    expect(readFileSync(join(r.runDir, 'transcript.log'), 'utf8')).toMatch(/debug leak \[hidden\] \[email\]/)
    expect(readFileSync(join(sb.dir, 'security.log'), 'utf8')).toMatch(/find-generic-password -s bcat-migration/)
  })

  it('backfill-emergency: dry run, then the exact apply command under an approval; stops on afterCutoff', () => {
    const dry = runU(usb(), { args: ['--only', 'backfill-emergency', '--dry-only'], env: { FAKE_BACKFILL_PENDING: '1' } })
    expect(dry.status).toBe(0); expect(dry.applies).toBe('')
    expect(dry.results).toMatch(/backfill-emergency\tbackfill_before\.afterCutoff\t0\t0\tPASS/)
    expect(dry.results).toMatch(/backfill-emergency\tbackfill_before\.totalLoads\t958\t958\tPASS/)
    expect(dry.results).toMatch(/backfill-emergency\tbackfill_before\.carriedOver\t17\t17\tPASS/)
    const sb = usb()
    const r = runU(sb, { approval: OK('backfill-emergency'), args: ['--only', 'backfill-emergency'], env: { FAKE_BACKFILL_PENDING: '1' } })
    expect(r.status).toBe(0)
    expect(r.applies).toContain(`backfill confirm=${today()}-backfill`)
    expect(r.argv).toContain(`backfill --suffix ${PROD} --cutoff 2026-11-07 --allow-empty-shipments --apply`)
    expect(r.results).toMatch(/backfill-emergency\tbackfill_after\.unmappable\t0\t0\tPASS/)
    expect(r.state).toMatch(/backfill-emergency\tDONE/)
    const stop = runU(usb(), { approval: OK('backfill-emergency'), args: ['--only', 'backfill-emergency'], env: { FAKE_BREAK: 'backfill-check:afterCutoff', FAKE_BACKFILL_PENDING: '1' } })
    expect(stop.status).toBe(1); expect(stop.applies).toBe('')
    expect(runU(usb(), { approval: OK('backfill-emergency'), args: ['--only', 'backfill'] }).applies).toBe('')
  })

  it('--status prints step state, PASS/FAIL counts, the approval state and the log directory without credentials', () => {
    const sb = usb()
    runU(sb, { approval: OK('customers'), args: ['--only', 'customers'] })
    const awsBefore = readFileSync(join(sb.dir, 'aws.log'), 'utf8')
    const none = runU(sb, { args: ['--status'], env: { FAKE_SEC: 'missing' }, path: lean(sb), unattended: false })
    expect(none.status).toBe(0)
    expect(none.stdout).toMatch(/log directory: .*aw-prod-logs/)
    expect(none.stdout).toMatch(/customers\s+DONE\s+\S+\s+PASS=\d+ FAIL=0/)
    expect(none.stdout).toMatch(/carriers\s+pending\s+-\s+PASS=0 FAIL=0/)
    expect(none.stdout).toMatch(/present: no/); expect(none.stdout).toMatch(/last retired approval:/)
    expect(readFileSync(join(sb.dir, 'aws.log'), 'utf8')).toBe(awsBefore)
    const present = runU(sb, { approval: OK('ar,customers'), args: ['--status'], unattended: false })
    expect(present.stdout).toMatch(/present: yes/); expect(present.stdout).toMatch(/steps listed: ar,customers/)
    expect(present.stdout).toMatch(/consumed under this line: none/)
    const bad = runU(sb, { approval: OK('ar'), mode: 0o666, args: ['--status'], unattended: false })
    expect(bad.stdout).toMatch(/usable: no \(the approval file is group\/world-writable/)
    expect(present.stdout + bad.stdout + none.stdout).not.toContain(SEC_PW)
  })
})
