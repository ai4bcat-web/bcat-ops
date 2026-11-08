import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
if (step === 'backfill') {
  const done = loadsDone
  L('backfill before: matchedByPro=' + (done ? 0 : 957) + ' linkedById=1 ambiguous=0 unmappable=0 alreadyLinked=' + (done ? 957 : 0) + ' loads=958 beforeWindow=0 afterCutoff=' + bad('backfill-check', 'afterCutoff', 0, 3) + ' totalLoads=958')
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
    for (const [k, v] of Object.entries({ otherVendorsSkipped: 19, inactive: 252, withFactorId: 183, quickPay: 14, rowsWithFedSs: 0, rowsWithBankAccount: 0, rowsWithRouting: 0 })) L('  ' + k + ': ' + v)
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
  ent('LOAD', 7944, 27, 7900, 13, 4, 0, 0); ent('CUSTOMER', 487, 1, 486, 0, 0, 0, 0)
  if (process.env.FAKE_GATE === '1' && apply) { console.error('a LIVE apply of real data needs a RECONCILED rehearsal run with the same stageHash and profileVersion'); process.exit(1) }
  if (apply) { L('APPLY 9.0s'); L('  conservation OK  reconciled YES  open AR 357753.44'); L('table Load: before 958, after 985, delta 27') }
}
if (step === 'reconcile') {
  const e = rest[rest.indexOf('--entity') + 1]
  L('\\n== reconcile ' + e + ' job x')
  const m = { CUSTOMERS: 515, CARRIERS: 2442, AP: 67, AR: 296, SHIPMENTS: 7940 }[e]
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
  *"list-tables"*) echo 110 ;;
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
  for (const f of ['aljex-customers-2026-11-08.csv', 'aljex-carriers-2026-11-08.csv', 'aljex-ap-aging-2026-11-08.csv', 'aljex-ap-expected-2026-11-08.csv', 'aljex-ar-2026-11-07.csv', 'aljex-full-export-2026-11-07.csv']) writeFileSync(join(files, f), 'x\n')
  writeFileSync(join(home, 'bcat-ops-backups', 'LATEST_BACKUP_STAMP'), new Date().toISOString())
  return { home, dir, bin, files, scripts }
}

function run(sb, { args = [], input = '', env = {} } = {}) {
  const r = spawnSync('bash', [SCRIPT, '--files-dir', sb.files, ...args], {
    input, encoding: 'utf8', timeout: 120000,
    env: { PATH: `${sb.bin}:${process.env.PATH}`, HOME: sb.home, AWPROD_SCRIPTS_DIR: sb.scripts, FAKE_DIR: sb.dir, FAKE_PW: CANARY, AW_PROD_NONINTERACTIVE: '1', BCAT_EMAIL: 'ryne.test@example.com', BCAT_PASSWORD: CANARY, ...env },
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

  it('does not apply without a typed y, and applies with y; each apply carries the dated confirm token', () => {
    const sb = sandbox()
    const no = run(sb, { input: 'PRODUCTION\nn\n' })
    expect(no.status).toBe(4)
    expect(no.applies).not.toMatch(/settings|customers/)
    const sb2 = sandbox()
    const ok = run(sb2, { input: yes(40) })
    expect(ok.status).toBe(0)
    const today = new Date().toLocaleDateString('sv-SE')
    for (const s of ['settings', 'customers', 'carriers', 'stage-export', 'loads', 'backfill', 'ap-aging', 'ap-expected', 'ar', 'reconcile']) expect(ok.applies).toContain(`${s} confirm=${today}-${s}`)
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
    const badLogin = run(sb, { input: 'PRODUCTION\n', env: { BCAT_PASSWORD: 'wrong' } })
    expect(badLogin.status).toBe(1); expect(badLogin.stdout).toMatch(/Login failed/)
  })

  it('stops with the importer message when the live pass needs a reconciled rehearsal', () => {
    const sb = sandbox()
    const r = run(sb, { input: yes(40), env: { FAKE_GATE: '1' } })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/RECONCILED rehearsal run with the same stageHash/)
    expect(r.applies).not.toMatch(/backfill|ap-aging/)
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
