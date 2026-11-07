/**
 * Step AW (stages C/D/E) live-harness helpers: pure checks plus the offline importer dry-run engine.
 * Everything here is either pure or runs on an in-memory store; nothing in this file talks to AWS except
 * `runBackfillDryRun`, which spawns scripts/awBackfillShipments.mjs WITHOUT --apply.
 *
 * Importer dry runs use SYNTHETIC files generated into a temp dir (ZZ names, PRO band 900000+). A real Aljex
 * file may only be passed through `realCountsDryRun`, which drops every sensitive column by header BEFORE parsing
 * and returns numbers only (no name, e-mail, id or cell value).
 */
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ───────────────────────────── mail safety ─────────────────────────────
/** The only mailbox family a live send may reach: ai4bcat@gmail.com and its `+tag` aliases. */
export const MAIL_OWNER = 'ai4bcat'
export const mailAlias = (tag) => `${MAIL_OWNER}+${String(tag).replace(/[^a-z0-9._-]/gi, '').toLowerCase()}@gmail.com`
export const isAllowedMailbox = (email) => new RegExp(`^${MAIL_OWNER}(\\+[a-z0-9._-]+)?@gmail\\.com$`, 'i').test(String(email ?? '').trim())
/** Throws unless every address is in the allowed family (and the list is not empty when `nonEmpty`). */
export function assertMailOnlyToAllowed(list, label, { nonEmpty = false } = {}) {
  const items = Array.isArray(list) ? list : []
  if (nonEmpty && items.length === 0) throw new Error(`${label}: no recipients`)
  const bad = items.filter((e) => !isAllowedMailbox(e))
  if (bad.length) throw new Error(`${label}: ${bad.length} recipient(s) outside ${MAIL_OWNER}@gmail.com (refusing to send)`)
}

// ───────────────────────────── palette ─────────────────────────────
/** BCAT production blue on the dev styling (AW_PALETTE.md): the `--tms-primary` token per theme. */
export const PALETTE = Object.freeze({ light: '#0369a1', dark: '#1ea8f3' })
export const normHex = (v) => String(v ?? '').trim().toLowerCase()
/** `probe` = { light, dark } computed `--tms-primary` values. Returns problem strings. */
export function paletteProblems(probe) {
  const out = []
  for (const theme of ['light', 'dark']) {
    if (normHex(probe?.[theme]) !== PALETTE[theme]) out.push(`${theme} --tms-primary is ${JSON.stringify(normHex(probe?.[theme]))}, expected ${PALETTE[theme]}`)
  }
  return out
}

// ───────────────────────────── counts / link summary ─────────────────────────────
/** Equality check with a readable message. `expected == null` means "not supplied": the count is only reported. */
export function countProblem(label, actual, expected) {
  if (expected == null) return null
  return actual === expected ? null : `${label}: ${actual}, expected ${expected}`
}

/** The keys awBackfillShipments.mjs writes to <out>/link-summary.json that this harness depends on. */
export function parseLinkSummary(text) {
  const j = JSON.parse(text)
  const b = j?.before
  if (!b || typeof b !== 'object') throw new Error('link-summary.json has no "before" block')
  const keys = ['matchedByPro', 'linkedById', 'ambiguous', 'unmappable', 'alreadyLinked', 'loads']
  const missing = keys.filter((k) => typeof b[k] !== 'number')
  if (missing.length) throw new Error(`link-summary.json before.* lacks: ${missing.join(', ')}`)
  return { ...Object.fromEntries(keys.map((k) => [k, b[k]])), cutoff: j.cutoff ?? null, windowStart: j.windowStart ?? null, outOfWindow: j.outOfWindow ?? null }
}

/** §4 step 2 / C.2 step 3: buckets add up to the Load count; ambiguous and unmappable must be 0. */
export function linkSummaryProblems(s, { loads = null } = {}) {
  const out = []
  const sum = s.matchedByPro + s.linkedById + s.ambiguous + s.unmappable + s.alreadyLinked
  if (sum !== s.loads) out.push(`buckets add up to ${sum}, not the ${s.loads} loads`)
  if (loads != null && s.loads !== loads) out.push(`report saw ${s.loads} loads, the table has ${loads}`)
  if (s.ambiguous !== 0) out.push(`${s.ambiguous} ambiguous (needs Ryne)`)
  if (s.unmappable !== 0) out.push(`${s.unmappable} unmappable`)
  return out
}

/**
 * Run scripts/awBackfillShipments.mjs as a child process in its default DRY-RUN mode. `--apply` is refused here:
 * this harness never writes links. Resolves with the parsed link summary.
 */
export function runBackfillDryRun({ outDir, stack, outputs = null, extraArgs = [], timeoutMs = 600_000 }) {
  if (extraArgs.some((a) => /^--apply/.test(a))) throw new Error('runBackfillDryRun refuses --apply')
  if (stack !== 'rehearsal' && stack !== 'dev') throw new Error(`runBackfillDryRun: stack must be rehearsal or dev (got ${stack})`)
  mkdirSync(outDir, { recursive: true })
  const args = [join(root, 'scripts/awBackfillShipments.mjs'), '--out', outDir, ...(outputs ? ['--outputs', outputs] : []), ...extraArgs]
  return new Promise((resolveRun, reject) => {
    execFile(process.execPath, args, { env: { ...process.env, BCAT_STACK: stack }, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, cwd: root }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`awBackfillShipments dry run failed (exit ${err.code ?? 'signal'}): ${String(stderr).replace(/\s+/g, ' ').slice(0, 300)}`))
      try { resolveRun(parseLinkSummary(readFileSync(join(outDir, 'link-summary.json'), 'utf8'))) } catch (e) { reject(e) }
    })
  })
}

// ───────────────────────────── release shapes ─────────────────────────────
/** A FACTOR release must leave the same queue row the e-mail bridge writes (src/lib/factorHandoff.ts factoringRowFor). */
export function factorRowProblems(item, invoice, { pro, customerId, orderId, shipmentId }) {
  const out = []
  if (!item) return ['no FactoringItem row']
  const eq = (field, want) => { if (item[field] !== want) out.push(`${field} is ${JSON.stringify(item[field])}, expected ${JSON.stringify(want)}`) }
  eq('id', pro); eq('proNumber', pro); eq('status', 'NEED_TO_FACTOR'); eq('source', 'TMS')
  eq('messageId', `tms:${invoice.id}`); eq('invoiceId', invoice.id); eq('customerId', customerId)
  eq('orderId', orderId); eq('shipmentId', shipmentId)
  if (!/^Invoice .+ · /.test(String(item.subject ?? ''))) out.push('subject is not "Invoice <number> · <shipment>"')
  if (!item.fromEmail) out.push('fromEmail empty')
  if (!item.receivedAt) out.push('receivedAt empty')
  if (item.otrInvoiceId) out.push('row already submitted to OTR')
  return out
}

/** Does an audit list contain this action (case-sensitive)? Returns the first hit. */
export const auditHit = (rows, action) => (rows ?? []).find((r) => r.action === action) ?? null

/** Pull the JSON out of an AuditLog `changes` value (AWSJSON string or object). */
export function changesOf(row) {
  const c = row?.changes
  if (c == null) return {}
  if (typeof c === 'string') { try { return JSON.parse(c) } catch { return {} } }
  return c
}

/** Router refusal text matcher: message contains the code or the phrase. */
export const refusedWith = (err, pattern) => pattern.test(String(err?.message ?? err))

// ───────────────────────────── the offline importer engine ─────────────────────────────
function stamp() {
  const h = createHash('sha1')
  for (const dir of ['amplify/functions/tms-aljex-import/engine', 'src/lib/aljex', 'src/lib/aljex/layouts', 'amplify/functions/_shared']) {
    const abs = join(root, dir)
    for (const f of readdirSync(abs).sort()) {
      const p = join(abs, f)
      if (statSync(p).isFile()) h.update(f).update(readFileSync(p))
    }
  }
  return h.digest('hex').slice(0, 12)
}

/**
 * Bundle the layouts, the engine's master/AP runners, the in-memory store and the synthetic AP fixtures into one
 * ESM module (esbuild, TypeScript resolved from the repo) and import it. No network, no AWS.
 */
export async function loadEngine() {
  const outDir = join(root, 'node_modules/.cache/aw-checks')
  mkdirSync(outDir, { recursive: true })
  const outfile = join(outDir, `engine-${stamp()}.mjs`)
  const r = (p) => JSON.stringify(join(root, p))
  await build({
    stdin: {
      resolveDir: root,
      sourcefile: 'aw-engine-entry.ts',
      loader: 'ts',
      contents: `
        export * as customers from ${r('src/lib/aljex/layouts/customers')}
        export * as carriers from ${r('src/lib/aljex/layouts/carriers')}
        export * as apAging from ${r('src/lib/aljex/layouts/apAging')}
        export * as apExpected from ${r('src/lib/aljex/layouts/apExpected')}
        export * as active from ${r('src/lib/aljex/layouts/activeShipments')}
        export * as fixtures from ${r('src/lib/aljex/layouts/apFilesFixture')}
        export * as sensitive from ${r('src/lib/aljex/sensitiveColumns')}
        export * as csv from ${r('src/lib/aljex/csv')}
        export * as directory from ${r('amplify/functions/tms-aljex-import/engine/directory')}
        export * as apFiles from ${r('amplify/functions/tms-aljex-import/engine/apFiles')}
        export * as memory from ${r('amplify/functions/tms-aljex-import/engine/memoryStore')}
        export * as tables from ${r('amplify/functions/tms-aljex-import/engine/tables')}
      `,
    },
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'error',
    tsconfig: join(root, 'amplify/tsconfig.json'),
  })
  return import(pathToFileURL(outfile).href)
}

const q = (s) => `"${String(s).replace(/"/g, '""')}"`
const csvText = (rows) => rows.map((r) => r.map(q).join(',')).join('\n') + '\n'
/** Sentinels planted in the sensitive columns: they must never appear in any output of the dry runs. */
export const SENTINELS = Object.freeze(['ZZSENTINEL-PASSWORD', 'ZZSENTINEL-FEDSS', 'ZZSENTINEL-BANK', 'ZZSENTINEL-ROUTING'])
const SENSITIVE_RE = /password|fed\s*\/?\s*ss|bank|routing/i

function customerRow(eng, over) {
  const base = {
    name: 'Fixture Northwind Foods', address: '1 Main St', address2: '', city: 'Springfield', state: 'IL', zip: '62701', zip4: '', phone: '555-0100', fax: '', contact: 'Pat',
    contactExt: '', contactEmail: 'pat@example.com', contact2: '', contact2Ext: '', contact2Email: '', account: '900001', status: 'Y', customerType: '', termsDays: '',
    revType: 'B', creditLimit: '100.00', balanceDue: '0', invoiceBy: '1', eBillingEmail: 'ap@example.com', firstShipment: '01/05/26', lastShipment: '10/01/26', totalShipments: '3', ...over,
  }
  return Object.keys(eng.customers.CUSTOMER_COLUMNS).map((k) => base[k])
}

function carrierRow(eng, over) {
  const base = {
    name: 'ZZ Blue Line Trucking', address: '9 Road', address2: '', city: 'Dayton', state: 'OH', zip: '45402', phone: '555-0111', fax: '', contact: 'Sam', payableTo: '',
    remitAddress: '', remitAddress2: '', remitCity: '', remitState: '', remitZip: '', remitZip4: '', phoneAccounting: '', isCarrier: 'Y', active: 'Y', mc: '700001',
    dot: '3000001', safetyRating: 'NONE', terms: '', quickPay: '', quickPayDays: '', quickPayPct: '', lastUpdate: '06/01/26', id: '900000001', factorId: '', ...over,
  }
  return Object.keys(eng.carriers.CARRIER_COLUMNS).map((k) => base[k])
}

/**
 * Generate every synthetic fixture into `dir` (the caller passes a temp dir) and return the paths.
 * customers/carriers carry planted sentinels in the sensitive columns so the harness can prove they are dropped.
 */
export function writeSyntheticFiles(eng, dir) {
  mkdirSync(dir, { recursive: true })
  const paths = {}
  const put = (name, text) => { const p = join(dir, name); writeFileSync(p, text, { mode: 0o600 }); paths[name.replace(/\.csv$/, '')] = p }

  const custHeader = [...Object.values(eng.customers.CUSTOMER_COLUMNS), 'Web Password']
  put('customers.csv', csvText([custHeader, ...[
    customerRow(eng, { account: '900001' }),
    customerRow(eng, { account: '900002', name: 'Fixture Fox Logistics', eBillingEmail: 'ivanfactoring@bcatcorp.com', lastShipment: '01/01/24' }),
    customerRow(eng, { account: '900003', name: 'Fixture Old Dock Co', status: 'N' }),
    customerRow(eng, { account: '100003', name: 'TEST CUSTOMER' }),
    customerRow(eng, { account: '900004', name: 'Fixture Internal Billed', eBillingEmail: 'invoices@bcatcorp.com' }),
    customerRow(eng, { account: '900005', name: 'Fixture Duplicate Name' }),
    customerRow(eng, { account: '900006', name: 'Fixture Duplicate Name' }),
    customerRow(eng, { account: '900007', name: 'ZZ Excluded By Name' }),
  ].map((r) => [...r, SENTINELS[0]])]))

  const carHeader = [...Object.values(eng.carriers.CARRIER_COLUMNS), ...eng.carriers.SENSITIVE_CARRIER_HEADERS]
  const sens = [SENTINELS[1], SENTINELS[2], SENTINELS[3]]
  put('carriers.csv', csvText([carHeader, ...[
    carrierRow(eng, { id: '900000001', mc: '700001', dot: '3000001' }),
    carrierRow(eng, { id: '900000002', name: 'ZZ Red Line Freight', mc: '700002', dot: '3000002', active: 'N' }),
    carrierRow(eng, { id: '900000003', name: 'ZZ Blue Line Trucking Dup', mc: '700001', dot: '3000001' }),
  ].map((r) => [...r, ...sens])]))

  put('ap-aging.csv', eng.fixtures.apAgingCsv())
  put('ap-expected.csv', eng.fixtures.apExpectedCsv([
    { pro: '900001', cents: 120000, ship: '10/20/26', carrierId: '900000001' },
    { pro: '900002', cents: 95000, ship: '10/25/26', carrierId: '900000002' },
    { pro: '900003', cents: 70000, ship: '01/05/24', carrierId: '900000003' },
    { pro: '900001', cents: 120000, ship: '10/20/26', carrierId: '900000001' },
  ]))
  put('active-shipments.csv', eng.fixtures.activeCsv([
    { pro: '900001' },
    { pro: '900002', customerRate: '9999.0' },
    { pro: '999999' },
  ]))
  return paths
}

const sumBuckets = (eng) => {
  const out = { D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_PLUS: 0 }
  for (const b of eng.fixtures.fixtureBills()) out[b.bucket === '0 - 30 Days' ? 'D0_30' : 'D31_60'] += b.cents
  return out
}

const FIXED_NOW = '2026-11-03T12:00:00.000Z'
/** An empty in-memory store over dev-style table names (the engine test kit's makeStore, without its fixture generator). */
function makeStore(eng) {
  const tables = Object.fromEntries(Object.entries(eng.tables.MODEL_NAME).map(([k, model]) => [k, `${model}-${eng.tables.DEV_SUFFIX}`]))
  const store = new eng.memory.MemoryStore({ tables, now: () => FIXED_NOW })
  store.seed('settings', [{ id: 'default', defaultPaymentTermsDays: 30 }])
  return store
}

/** A fresh empty store and an overlay on it: every dry run writes to the overlay only; `base` proves nothing leaked. */
function stores(eng) {
  const base = makeStore(eng)
  const overlay = new eng.memory.MemoryStore({ tables: base.tables, now: () => base.now(), base })
  return { base, overlay }
}
const masterEnv = (store) => ({ store, runId: 'zz-aw-e5', counts: {}, findings: [], asOf: '2026-11-07' })
const leaked = (eng, base) => ['customer', 'location', 'carrier', 'carrierBill'].reduce((n, t) => n + base.own(t).length, 0)

function readCsvFile(eng, path) {
  const [headers, ...rows] = eng.csv.parseCsvText(readFileSync(path, 'utf8'))
  return { headers, rows }
}

/** Drop every column whose header names a sensitive field BEFORE parsing; returns the kept file and the dropped header names. */
export function dropSensitive(eng, headers, rows) {
  const keep = headers.map((h, i) => (SENSITIVE_RE.test(h) || eng.sensitive.findSensitiveHeaders([h]).length ? -1 : i)).filter((i) => i >= 0)
  return { headers: keep.map((i) => headers[i]), rows: rows.map((r) => keep.map((i) => String(r[i] ?? ''))), dropped: headers.filter((h, i) => !keep.includes(i)) }
}

const assertNoSentinel = (label, value) => {
  const blob = JSON.stringify(value)
  for (const s of SENTINELS) if (blob.includes(s)) throw new Error(`${label}: a sensitive value leaked into the output`)
}
const must = (cond, message) => { if (!cond) throw new Error(message) }

export async function dryRunCustomers(eng, path) {
  const { headers, rows } = readCsvFile(eng, path)
  const cleaned = dropSensitive(eng, headers, rows)
  must(cleaned.dropped.some((h) => /password/i.test(h)), 'the Web Password column was not dropped by header')
  const parsed = eng.customers.parseCustomerRows(cleaned.headers, cleaned.rows)
  const c = parsed.counts
  must(c.rows === rows.length, `parsed ${c.rows} rows of ${rows.length}`)
  must(c.customers + c.locations + c.excluded + c.rejected === c.rows, 'customers + locations + excluded + rejected != rows')
  must(c.locations === 1, `${c.locations} Status N rows became locations, expected 1`)
  must(c.excluded >= 2, `${c.excluded} excluded, expected TEST CUSTOMER and the ZZ-named row`)
  must(c.factor >= 1 && c.manual >= 1, `billing seed: ${c.factor} factor / ${c.manual} manual`)
  must(c.duplicateGroups >= 1, 'the duplicate-name pair was not grouped')
  const { base, overlay } = stores(eng)
  const first = await eng.directory.runCustomersMaster(masterEnv(overlay), parsed)
  must(first.summary.customersCreated === c.customers, `dry run would create ${first.summary.customersCreated}, parse says ${c.customers}`)
  must(overlay.own('customer').every((r) => r.balance == null && r.balanceDue == null), 'Balance Due leaked onto a customer')
  const again = await eng.directory.runCustomersMaster(masterEnv(overlay), parsed)
  must(again.summary.customersCreated === 0 && again.summary.customersMatched === c.customers, 're-run is not a no-op')
  must(leaked(eng, base) === 0, 'the dry run wrote to the base store')
  assertNoSentinel('customers', { parsed: parsed.counts, first: first.summary, review: first.review })
  return `${c.rows} rows -> ${c.customers} customers (${c.factor} factor / ${c.manual} manual / ${c.unset} unset, ${c.needsReview} need review), ${c.locations} location, ${c.excluded} excluded, ${c.duplicateGroups} duplicate group(s); Web Password dropped by header; re-run no-op; base untouched`
}

export async function dryRunCarriers(eng, path) {
  const { headers, rows } = readCsvFile(eng, path)
  const withCounts = eng.carriers.parseCarrierRows(headers, rows)
  const sr = withCounts.counts.sensitiveRows
  must(sr.fedSs === rows.length && sr.bankAccount === rows.length && sr.routing === rows.length, `sensitive presence counts ${JSON.stringify(sr)} != ${rows.length} rows`)
  let refused = false
  try { eng.carriers.assertNoSensitiveHeaders(headers) } catch { refused = true }
  must(refused, 'a file with Fed/SS #, Bank Account and Routing # headers was not refused')
  const stripped = eng.carriers.stripSensitiveColumns(headers, rows)
  must(eng.sensitive.findSensitiveHeaders(stripped.headers).length === 0, 'sensitive headers survived the strip')
  must(stripped.rows.every((r) => !r.some((cell) => SENTINELS.includes(cell))), 'a sensitive value survived the strip')
  const parsed = eng.carriers.parseCarrierRows(stripped.headers, stripped.rows)
  const { base, overlay } = stores(eng)
  const first = await eng.directory.runCarriersMaster(masterEnv(overlay), parsed)
  const again = await eng.directory.runCarriersMaster(masterEnv(overlay), parsed)
  must(JSON.stringify(Object.keys(again.summary)) === JSON.stringify(Object.keys(first.summary)), 'summary shape changed between runs')
  must(overlay.own('carrier').length === parsed.carriers.length, `${overlay.own('carrier').length} carriers in the overlay, parse says ${parsed.carriers.length}`)
  must(parsed.carriers.length < rows.length, 'the duplicate MC pair was not merged into one carrier')
  must(leaked(eng, base) === 0, 'the dry run wrote to the base store')
  assertNoSentinel('carriers', { counts: withCounts.counts, parsed: parsed.counts, first: first.summary, again: again.summary })
  return `${rows.length} rows -> ${parsed.carriers.length} carrier(s) after the duplicate-MC merge; sensitive columns counted (${sr.fedSs}/${sr.bankAccount}/${sr.routing}), refused as headers, stripped before staging; re-run stable; base untouched`
}

function apSeed(eng) {
  const store = makeStore(eng)
  const bills = eng.fixtures.fixtureBills()
  store.seed('carrier', Array.from({ length: eng.fixtures.FIXTURE_VENDORS }, (_, v) => ({ id: `car-${v}`, name: `ZZ Vendor ${v}`, aljexCode: String(900000001 + v) })))
  for (const b of bills) {
    const v = Number(b.vendorId) - 900000001
    store.seed('load', [{ id: `lod-${b.pro}`, aljexId: b.pro, shipmentId: `shp-${b.pro}`, activeLoadCarrierId: `lcr-${b.pro}`, customer: 'ZZ CUSTOMER', carrierName: `ZZ VENDOR ${v}`, originName: 'ZZ SHIPPER', originCity: 'ZZTOWN, WI', destinationName: 'ZZ CONSIGNEE', destinationCity: 'ZZVILLE, NY' }])
    store.seed('loadCarrier', [{ id: `lcr-${b.pro}`, loadId: `lod-${b.pro}`, shipmentId: `shp-${b.pro}`, carrierId: `car-${v}`, kind: 'CARRIER' }])
    store.seed('loadFinancials', [{ id: `lod-${b.pro}`, customerRateCents: 175_000, carrierRateCents: 130_000 }])
  }
  return store
}

export async function dryRunApAging(eng, path) {
  const text = readFileSync(path, 'utf8')
  const parsed = eng.apAging.parseApAgingCsv(text)
  const want = sumBuckets(eng)
  must(parsed.bills.length === eng.fixtures.FIXTURE_AP_BILLS, `${parsed.bills.length} bills, expected ${eng.fixtures.FIXTURE_AP_BILLS}`)
  must(parsed.totalCents === eng.fixtures.FIXTURE_AP_TOTAL_CENTS, `total ${parsed.totalCents}, expected ${eng.fixtures.FIXTURE_AP_TOTAL_CENTS}`)
  for (const k of Object.keys(want)) must(parsed.byBucket[k] === want[k], `bucket ${k} ${parsed.byBucket[k]} != ${want[k]}`)
  const base = apSeed(eng)
  const overlay = new eng.memory.MemoryStore({ tables: base.tables, now: () => base.now(), base })
  const { report } = await eng.apFiles.runApFiles(overlay, { runId: 'zz-aw-e5', cutoff: '2026-11-07', files: { apAging: text } })
  const ap = report.apAging
  must(ap.created === parsed.bills.length && ap.unresolved.length === 0, `created ${ap.created}, unresolved ${ap.unresolved.length}`)
  const bills = overlay.own('carrierBill')
  must(bills.reduce((n, b) => n + b.balanceCents, 0) === parsed.totalCents, 'open AP does not equal the file total to the cent')
  must(bills.every((b) => b.paidCents === 0 && b.apOpen === 'OPEN'), 'Amount Paid was treated as paid')
  must(base.own('carrierBill').length === 0, 'the dry run wrote bills to the base store')
  return `${parsed.bills.length} bills, total ${(parsed.totalCents / 100).toFixed(2)} equals open AP to the cent; buckets 0-30 ${(parsed.byBucket.D0_30 / 100).toFixed(2)} / 31-60 ${(parsed.byBucket.D31_60 / 100).toFixed(2)}; Amount Paid ignored (all open, none paid); base untouched`
}

export async function dryRunApExpected(eng, path) {
  const text = readFileSync(path, 'utf8')
  const store = apSeed(eng)
  const overlay = new eng.memory.MemoryStore({ tables: store.tables, now: () => store.now(), base: store })
  const { report, files } = await eng.apFiles.runApFiles(overlay, { runId: 'zz-aw-e5', cutoff: '2026-11-07', files: { apExpected: text } })
  const e = report.apExpected
  must(e.rows === 4, `${e.rows} rows, expected 4`)
  must(e.droppedStale === 1, `${e.droppedStale} stale rows dropped, expected 1`)
  must(e.duplicatesReported === 1, `${e.duplicatesReported} repeated PROs reported, expected 1`)
  must(overlay.own('carrierBill').length === 0, 'expected rows were carried as payables')
  must(typeof files['ap-expected-review.csv'] === 'string', 'no ap-expected-review.csv')
  return `${e.rows} rows: ${e.expected} expected ($${(e.expectedCents / 100).toFixed(2)}), ${e.droppedStale} stale dropped, ${e.duplicatesReported} repeated PRO listed, ${e.awaitingInvoiceMarked} marked awaiting-invoice, no payable created`
}

export async function dryRunActive(eng, path) {
  const text = readFileSync(path, 'utf8')
  const store = apSeed(eng)
  const overlay = new eng.memory.MemoryStore({ tables: store.tables, now: () => store.now(), base: store })
  const { report } = await eng.apFiles.runApFiles(overlay, { runId: 'zz-aw-e5', cutoff: '2026-11-07', files: { activeShipments: text } })
  const a = report.activeShipments
  must(a.rows === 3 && a.ok + a.differs + a.missing === 3, `${a.rows} rows, ${a.ok}+${a.differs}+${a.missing}`)
  must(a.differs >= 1, 'the changed customer rate was not reported as a difference')
  must(a.missing === 1, `${a.missing} missing, expected 1`)
  const wrote = ['customer', 'carrier', 'carrierBill', 'shipment', 'load'].reduce((n, t) => n + overlay.own(t).length, 0)
  must(wrote === 0, 'the active-shipments check wrote rows')
  return `${a.rows} rows: ${a.ok} match, ${a.differs} differ (go to reconciliation), ${a.missing} missing; nothing written`
}

/**
 * A REAL Aljex file, counts only. Sensitive columns are dropped by header before anything is parsed; the return
 * value and every thrown message hold numbers and header names (never a cell value). `kind`: customers|carriers|apAging.
 */
export async function realCountsDryRun(eng, kind, path) {
  const { headers, rows } = readCsvFile(eng, path)
  const cleaned = dropSensitive(eng, headers, rows)
  if (kind === 'customers') {
    const p = eng.customers.parseCustomerRows(cleaned.headers, cleaned.rows)
    return { kind, rows: p.counts.rows, customers: p.counts.customers, locations: p.counts.locations, excluded: p.counts.excluded, factor: p.counts.factor, manual: p.counts.manual, unset: p.counts.unset, needsReview: p.counts.needsReview, duplicateGroups: p.counts.duplicateGroups, droppedColumns: cleaned.dropped.length }
  }
  if (kind === 'carriers') {
    const p = eng.carriers.parseCarrierRows(cleaned.headers, cleaned.rows)
    return { kind, rows: rows.length, carriers: p.carriers.length, droppedColumns: cleaned.dropped.length }
  }
  if (kind === 'apAging') {
    const p = eng.apAging.parseApAgingCsv(readFileSync(path, 'utf8'))
    return { kind, rows: p.rows, bills: p.bills.length, totalCents: p.totalCents, byBucket: p.byBucket, droppedColumns: cleaned.dropped.length }
  }
  throw new Error(`unknown real-file kind ${kind}`)
}

/** The doc'd real AP aging totals (STEP_AW_MERGE_READINESS / AW-CDE-plan §4 step 8): $83,407.20 = 66,642.20 + 16,765.00. */
export const REAL_AP = Object.freeze({ bills: 67, totalCents: 8_340_720, D0_30: 6_664_220, D31_60: 1_676_500 })
