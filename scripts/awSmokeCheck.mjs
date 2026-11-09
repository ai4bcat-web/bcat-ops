#!/usr/bin/env node
/**
 * READ-ONLY production check for the manual "build a load + assign it" smoke test
 * (Docs/tms-build/PROD_SMOKE_LOAD.md). Run it twice: after the test shipment is built and assigned
 * (`--expect live`), and after it was voided in the app (`--expect voided`).
 *
 *   node scripts/awSmokeCheck.mjs --since 2026-11-09T13:00:00Z [--expect live|voided] [--key "TEST - DELETE ME"] [--suffix <prod suffix>]
 *
 * What it does: Scan / Describe only (no write command is imported). It finds the shipments whose customer text is
 * the test key, counts their rows (Shipment / Order / Load / LoadCarrier / LoadCharge / LoadFinancials / ProClaim /
 * AuditLog), reports the counters the create used, and checks that nothing that sends or bills was created:
 * ShipmentNotice and FactoringItem rows since `--since` (FAIL), and Invoice, CarrierBill, Customer and Location rows
 * since `--since` (WARN: other staff create those too).
 *
 * "Cleanup" in this system is a VOID: there is no delete (a PRO is permanent, Ryne 2026-10-28), so the rows of a
 * voided test shipment stay, marked voided, its load CANCELED. `--expect voided` therefore checks the void, not an
 * empty table. The PRO and the shipment counter number are spent for good.
 *
 * Output: counts, ids' shapes (shp-/lod-/lcr- prefixes), statuses and the verdict. The test customer text is the only
 * name printed; no real customer, carrier, driver, e-mail or phone is read into the output. Exit 1 on any FAIL.
 */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'

export const PROD_SUFFIX = '5ucwdyvwivelbo4k4jomvrwel4-NONE'
export const REGION = 'us-east-1'
export const DEFAULT_KEY = 'TEST - DELETE ME'

// ── pure parts ─────────────────────────────────────────────────────────────────────────────

/** Lower-case, collapse whitespace and dash spacing, so 'test – delete me ' and 'TEST - DELETE ME' are one key. */
export function normalizeKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function matchesKey(row, key) {
  const want = normalizeKey(key)
  return want !== '' && normalizeKey(row?.customerName) === want
}

/** `--since` must be an instant: a bare date is read as UTC midnight so nothing earlier slips in. */
export function parseSince(value) {
  if (!value) throw new Error('--since <ISO time> is required: the moment before the test shipment was created')
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value)
  if (!Number.isFinite(ms)) throw new Error(`--since is not a time: ${value}`)
  return new Date(ms).toISOString()
}

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: 'string' }, expect: { type: 'string' }, key: { type: 'string' }, suffix: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const expect = values.expect ?? 'live'
  if (expect !== 'live' && expect !== 'voided') throw new Error('--expect must be live or voided')
  return {
    help: Boolean(values.help),
    since: values.help ? null : parseSince(values.since),
    expect,
    key: values.key ?? DEFAULT_KEY,
    suffix: values.suffix ?? PROD_SUFFIX,
  }
}

const count = (rows, pick) => rows.reduce((n, r) => n + (pick(r) ? 1 : 0), 0)
const hist = (rows, field) => rows.reduce((h, r) => { const v = r[field] ?? '(none)'; h[v] = (h[v] ?? 0) + 1; return h }, {})
const sinceOrAfter = (row, since) => typeof row?.createdAt === 'string' && row.createdAt >= since

/**
 * Group the child rows under the test shipments. `tables` holds the rows of each table already narrowed to the
 * columns used here; the grouping is by shipment id, never by name.
 */
export function summarizeTest({ shipments, tables, since }) {
  const ids = new Set(shipments.map((s) => s.id))
  const forTest = (rows) => rows.filter((r) => ids.has(r.shipmentId))
  const orders = forTest(tables.Order)
  const loads = forTest(tables.Load)
  const legs = forTest(tables.LoadCarrier)
  const charges = forTest(tables.LoadCharge)
  const financials = forTest(tables.LoadFinancials)
  const claims = forTest(tables.ProClaim)
  const entityIds = new Set([...ids, ...loads.map((l) => l.id), ...legs.map((l) => l.id), ...orders.map((o) => o.id)])
  const audits = tables.AuditLog.filter((a) => entityIds.has(a.entityId))
  const notices = forTest(tables.ShipmentNotice)
  return {
    shipments: shipments.map((s) => ({
      id: s.id, number: s.number, status: s.status ?? null, voided: Boolean(s.voidedAt), createdAt: s.createdAt ?? null,
    })),
    rows: {
      Shipment: shipments.length, Order: orders.length, Load: loads.length, LoadCarrier: legs.length,
      LoadCharge: charges.length, LoadFinancials: financials.length, ProClaim: claims.length, AuditLog: audits.length,
    },
    loadStatus: hist(loads, 'status'),
    legs: { kind: hist(legs, 'kind'), status: hist(legs, 'status'), liveOnApBoard: count(legs, (l) => l.status === 'ACTIVE' && l.apOpen) },
    billed: { orders: count(orders, (o) => o.arStatus === 'UNPAID' || o.arStatus === 'PAID' || o.invoiceId), legs: count(legs, (l) => l.invoiceId) },
    auditActions: hist(audits, 'action'),
    // Anything that sends mail or bills, tied to the test shipment itself: this is the hard failure.
    noticesForTest: notices.length,
    // The same tables, any shipment, since the start: other staff work on Monday, so these are information only.
    since: {
      ShipmentNotice: count(tables.ShipmentNotice, (r) => sinceOrAfter(r, since)),
      FactoringItem: count(tables.FactoringItem, (r) => sinceOrAfter(r, since)),
      Invoice: count(tables.Invoice, (r) => sinceOrAfter(r, since)),
      CarrierBill: count(tables.CarrierBill, (r) => sinceOrAfter(r, since)),
      Customer: count(tables.Customer, (r) => sinceOrAfter(r, since)),
      Location: count(tables.Location, (r) => sinceOrAfter(r, since)),
      ShipmentOther: count(tables.Shipment, (r) => sinceOrAfter(r, since)) - shipments.filter((s) => sinceOrAfter(s, since)).length,
    },
    loads,
    legsRows: legs,
  }
}

/**
 * The verdicts. `live`: the test shipment exists once, with its order, load, claim and financials, one live leg
 * after the assignment. `voided`: shipment voided, every load CANCELED, no leg left on the AP board. Both: nothing
 * sent (no ShipmentNotice on the shipment), nothing billed, no Customer or Location created since the start.
 */
export function verdicts(summary, expect) {
  const out = []
  // `warn` findings cannot be tied to the test (other staff create customers and invoices on a working day): they are
  // listed for a human, never fail the run. Notices and factoring items are the ones the test must never cause.
  const check = (name, ok, detail, level = 'fail') => out.push({ name, ok, detail, level })
  const n = summary.rows
  check('test shipment found', n.Shipment >= 1, `${n.Shipment} shipment(s)`)
  check('one shipment per test run', n.Shipment <= 1, n.Shipment > 1 ? 'more than one shipment carries the key; the first run was not cleaned' : 'ok')
  if (n.Shipment >= 1) {
    check('order, load, claim, financials written once each', n.Order === n.Shipment && n.Load === n.Shipment && n.ProClaim === n.Shipment && n.LoadFinancials === n.Shipment,
      `Order ${n.Order}, Load ${n.Load}, ProClaim ${n.ProClaim}, LoadFinancials ${n.LoadFinancials}`)
    check('a CREATE_SHIPMENT audit row exists', (summary.auditActions.CREATE_SHIPMENT ?? 0) >= 1, `${summary.auditActions.CREATE_SHIPMENT ?? 0}`)
  }
  if (expect === 'live') {
    const live = summary.legs.status.ACTIVE ?? 0
    check('exactly one live assignment', live === 1, `${live} ACTIVE LoadCarrier row(s)`)
    check('no shipment voided yet', summary.shipments.every((s) => !s.voided), summary.shipments.map((s) => s.voided ? 'voided' : 'live').join(',') || 'none')
  } else {
    check('shipment voided', summary.shipments.length > 0 && summary.shipments.every((s) => s.voided), summary.shipments.map((s) => s.voided ? 'voided' : 'STILL LIVE').join(','))
    const loadStates = Object.entries(summary.loadStatus)
    check('every load CANCELED', loadStates.length > 0 && loadStates.every(([status]) => status === 'CANCELED'), loadStates.map(([k, v]) => `${k}:${v}`).join(' '))
    check('no leg left on the AP board', summary.legs.liveOnApBoard === 0, `${summary.legs.liveOnApBoard}`)
    check('a VOID_SHIPMENT audit row exists', (summary.auditActions.VOID_SHIPMENT ?? 0) >= 1, `${summary.auditActions.VOID_SHIPMENT ?? 0}`)
  }
  check('nothing billed on the test shipment', summary.billed.orders === 0 && summary.billed.legs === 0, `orders ${summary.billed.orders}, legs ${summary.billed.legs}`)
  check('no ShipmentNotice (e-mail/notice) on the test shipment', summary.noticesForTest === 0, `${summary.noticesForTest}`)
  check('no ShipmentNotice created since the start', summary.since.ShipmentNotice === 0, `${summary.since.ShipmentNotice} (any shipment)`)
  check('no FactoringItem created since the start', summary.since.FactoringItem === 0, `${summary.since.FactoringItem} (any shipment)`)
  check('no Customer created since the start', summary.since.Customer === 0, `${summary.since.Customer} (any user)`, 'warn')
  check('no Location created since the start', summary.since.Location === 0,
    summary.since.Location === 0 ? 'ok' : `${summary.since.Location} (any user); if the stops were typed instead of picked from the directory, the form filed a new Location`, 'warn')
  check('no Invoice or CarrierBill created since the start', summary.since.Invoice === 0 && summary.since.CarrierBill === 0,
    `Invoice ${summary.since.Invoice}, CarrierBill ${summary.since.CarrierBill} (any user)`, 'warn')
  return out
}

export function formatReport({ key, since, expect, suffix, summary, counters, verdictRows }) {
  const lines = []
  lines.push(`awSmokeCheck (READ-ONLY) suffix=${suffix} key="${key}" since=${since} expect=${expect}`)
  lines.push('')
  lines.push('Rows written for the test shipment (by shipmentId):')
  for (const [table, n] of Object.entries(summary.rows)) lines.push(`  ${table.padEnd(15)} ${n}`)
  for (const s of summary.shipments) lines.push(`  shipment ${s.id} number/PRO ${s.number} status ${s.status} ${s.voided ? 'VOIDED' : 'live'}`)
  lines.push(`  load status ${JSON.stringify(summary.loadStatus)}; legs ${JSON.stringify(summary.legs)}`)
  lines.push(`  audit actions ${JSON.stringify(summary.auditActions)}`)
  lines.push('')
  lines.push(`Counters: TmsSettings.nextShipmentNumber=${counters.nextShipmentNumber} proScheme=${counters.proScheme}; ProClaim ids for the test: ${counters.claimIds.join(', ') || '(none)'} (spent for good, never reissued)`)
  lines.push(`Since ${since} (any shipment, information only): ${JSON.stringify(summary.since)}`)
  lines.push('')
  lines.push('Verdict:')
  for (const v of verdictRows) lines.push(`  ${v.ok ? 'PASS' : v.level === 'warn' ? 'WARN' : 'FAIL'}  ${v.name} - ${v.detail}`)
  const failed = verdictRows.filter((v) => !v.ok && v.level === 'fail').length
  const warned = verdictRows.filter((v) => !v.ok && v.level === 'warn').length
  lines.push('')
  lines.push(failed === 0 ? `ALL ${verdictRows.length - warned} BLOCKING CHECKS PASS${warned ? `, ${warned} WARNING(S) TO LOOK AT` : ''}` : `${failed} CHECK(S) FAILED`)
  return lines.join('\n')
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────

const COLUMNS = {
  Shipment: ['id', 'number', 'status', 'customerName', 'voidedAt', 'createdAt'],
  Order: ['id', 'shipmentId', 'arStatus', 'invoiceId'],
  Load: ['id', 'shipmentId', 'status', 'voidedAt'],
  LoadCarrier: ['id', 'shipmentId', 'kind', 'status', 'apOpen', 'invoiceId'],
  LoadCharge: ['id', 'shipmentId'],
  LoadFinancials: ['id', 'shipmentId'],
  ProClaim: ['id', 'shipmentId'],
  AuditLog: ['entityId', 'action'],
  ShipmentNotice: ['id', 'shipmentId', 'createdAt'],
  FactoringItem: ['id', 'createdAt'],
  Invoice: ['id', 'createdAt'],
  CarrierBill: ['id', 'createdAt'],
  Customer: ['id', 'createdAt'],
  Location: ['id', 'createdAt'],
}

async function scanAll(client, table, columns) {
  const names = Object.fromEntries(columns.map((c, i) => [`#c${i}`, c]))
  const rows = []
  let ExclusiveStartKey
  do {
    const r = await client.send(new ScanCommand({
      TableName: table, ExclusiveStartKey,
      ProjectionExpression: Object.keys(names).join(','), ExpressionAttributeNames: names,
    }))
    for (const item of r.Items ?? []) rows.push(unmarshall(item))
    ExclusiveStartKey = r.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return rows
}

export async function readProduction({ suffix, client = new DynamoDBClient({ region: REGION }) }) {
  const tables = {}
  for (const [model, columns] of Object.entries(COLUMNS)) tables[model] = await scanAll(client, `${model}-${suffix}`, columns)
  const settings = await scanAll(client, `TmsSettings-${suffix}`, ['id', 'nextShipmentNumber', 'proScheme'])
  return { tables, settings: settings.find((s) => s.id === 'default') ?? {} }
}

export async function run(argv, deps = {}) {
  const cli = parseCli(argv)
  if (cli.help) {
    console.log('node scripts/awSmokeCheck.mjs --since <ISO time> [--expect live|voided] [--key "TEST - DELETE ME"] [--suffix <suffix>]  (read-only)')
    return 0
  }
  const { tables, settings } = await (deps.read ?? readProduction)({ suffix: cli.suffix })
  const shipments = tables.Shipment.filter((s) => matchesKey(s, cli.key))
  const summary = summarizeTest({ shipments, tables, since: cli.since })
  const counters = {
    nextShipmentNumber: settings.nextShipmentNumber ?? null,
    proScheme: settings.proScheme ?? 'DERIVED',
    claimIds: tables.ProClaim.filter((c) => shipments.some((s) => s.id === c.shipmentId)).map((c) => c.id),
  }
  const verdictRows = verdicts(summary, cli.expect)
  const log = deps.log ?? console.log
  log(formatReport({ ...cli, summary, counters, verdictRows }))
  return verdictRows.some((v) => !v.ok && v.level === 'fail') ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (err) => { console.error(`awSmokeCheck: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 2 },
  )
}
